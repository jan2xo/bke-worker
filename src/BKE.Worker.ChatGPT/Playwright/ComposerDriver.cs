using System.Text.RegularExpressions;
using Microsoft.Playwright;

namespace BKE.Worker.ChatGPT.Playwright;

public sealed record ComposerProbe(
    bool ComposerAvailable,
    bool TurnBusy,
    bool CanSendNextTurn);

/// <summary>The turn was definitely not submitted (nothing was clicked). Safe to inspect and fix.</summary>
public sealed class ChatGptSendNotSubmittedException(string code) : InvalidOperationException(code);

/// <summary>
/// The send button was clicked but delivery could not be positively confirmed in the transcript.
/// Treat as UNKNOWN_SEND: keep the durable pending journal and require owner review; never retry.
/// </summary>
public sealed class ChatGptSendUnconfirmedException(string code, Exception? inner = null)
    : InvalidOperationException(code, inner);

public sealed class ComposerDriver
{
    private static readonly Regex StopPattern = new("stop", RegexOptions.IgnoreCase);
    private static readonly Regex SendPattern = new("^send", RegexOptions.IgnoreCase);
    private static readonly TimeSpan DefaultReadyTimeout = TimeSpan.FromSeconds(15);
    private static readonly TimeSpan StableReadyWindow = TimeSpan.FromMilliseconds(750);
    private static readonly TimeSpan AutonomousStableIdleWindow = TimeSpan.FromSeconds(3);
    private static readonly TimeSpan AutonomousReadyTimeout = TimeSpan.FromSeconds(4);
    private static readonly TimeSpan ReadyPollInterval = TimeSpan.FromMilliseconds(100);
    private static readonly TimeSpan SendButtonTimeout = TimeSpan.FromSeconds(5);
    private static readonly TimeSpan DefaultSubmissionConfirmTimeout = TimeSpan.FromSeconds(20);
    private static readonly Regex WhitespacePattern = new(@"\s+");
    private const int FingerprintLength = 120;
    private const string UserMessageSelector = "[data-message-author-role='user']";

    private readonly TimeSpan _submissionConfirmTimeout;

    public ComposerDriver(TimeSpan? submissionConfirmTimeout = null)
    {
        _submissionConfirmTimeout = submissionConfirmTimeout ?? DefaultSubmissionConfirmTimeout;
        if (_submissionConfirmTimeout <= TimeSpan.Zero)
            throw new ArgumentOutOfRangeException(nameof(submissionConfirmTimeout));
    }

    public async Task<ComposerProbe> Probe(IPage page, CancellationToken cancellationToken)
    {
        cancellationToken.ThrowIfCancellationRequested();
        if (page.IsClosed)
            return new(false, false, false);

        var stopButtons = page.GetByRole(AriaRole.Button, new() { NameRegex = StopPattern });
        var turnBusy = await ProjectNavigator.FindFirstVisible(stopButtons, cancellationToken) is not null;
        var composerAvailable = await FindComposer(page, cancellationToken) is not null;

        return new(
            composerAvailable,
            turnBusy,
            composerAvailable && !turnBusy);
    }

    public async Task<bool> CanSendNextTurn(IPage page, CancellationToken cancellationToken)
    {
        // Autonomous continuation uses a positive safety proof instead of trying to classify
        // every transient ChatGPT state. Busy, hydrating, missing-composer, or otherwise
        // ambiguous states all fail closed immediately. Only a continuously sendable composer
        // for the full stable-idle window is considered safe to interrupt.
        var initial = await Probe(page, cancellationToken);
        if (!initial.CanSendNextTurn)
            return false;

        var ready = await WaitForStableComposer(
            page,
            AutonomousReadyTimeout,
            AutonomousStableIdleWindow,
            cancellationToken);
        return ready is not null;
    }

    public async Task<bool> WaitUntilCanSendNextTurn(
        IPage page,
        CancellationToken cancellationToken,
        TimeSpan? timeout = null)
    {
        var ready = await WaitForStableComposer(
            page,
            timeout ?? DefaultReadyTimeout,
            StableReadyWindow,
            cancellationToken);
        return ready is not null;
    }

    public async Task Send(IPage page, string instruction, CancellationToken cancellationToken)
    {
        ArgumentException.ThrowIfNullOrWhiteSpace(instruction);

        var composer = await WaitForStableComposer(
            page,
            DefaultReadyTimeout,
            StableReadyWindow,
            cancellationToken);
        if (composer is null)
        {
            var state = await Probe(page, cancellationToken);
            throw new ChatGptSendNotSubmittedException(
                state.TurnBusy
                    ? "CHATGPT_TURN_NOT_IDLE"
                    : "CHATGPT_COMPOSER_NOT_AVAILABLE");
        }

        // Never clobber or reuse text that is already in the composer. A leftover draft may be
        // an earlier unconfirmed send; the owner must inspect it. Do not clear it here.
        if (!string.IsNullOrWhiteSpace(await ReadComposerText(composer)))
            throw new ChatGptSendNotSubmittedException("CHATGPT_COMPOSER_HAS_EXISTING_DRAFT");

        var userMessages = page.Locator(UserMessageSelector);
        var userMessagesBefore = await userMessages.CountAsync();
        var fingerprint = Fingerprint(instruction);

        await composer.FillAsync(instruction);

        if (!Normalize(await ReadComposerText(composer)).Contains(fingerprint, StringComparison.Ordinal))
            throw new ChatGptSendNotSubmittedException("CHATGPT_COMPOSER_FILL_UNVERIFIED");

        // The only submission path is an explicit, visible, enabled send button. There is no
        // keyboard fallback: an unverified Enter press is what produced false DISPATCHED results.
        var send = await WaitForEnabledSendButton(page, SendButtonTimeout, cancellationToken);
        if (send is null)
            throw new ChatGptSendNotSubmittedException("CHATGPT_SEND_BUTTON_UNAVAILABLE");

        // From the click onward the turn may have reached ChatGPT. Every failure past this
        // point is UNKNOWN_SEND and must stay quarantined for owner review, never retried.
        try
        {
            await send.ClickAsync();
        }
        catch (Exception ex) when (ex is not OperationCanceledException)
        {
            throw new ChatGptSendUnconfirmedException("CHATGPT_SEND_UNCONFIRMED_CLICK_FAILED", ex);
        }

        if (!await WaitForSubmissionConfirmed(
                page,
                composer,
                userMessagesBefore,
                fingerprint,
                _submissionConfirmTimeout,
                cancellationToken))
        {
            throw new ChatGptSendUnconfirmedException("CHATGPT_SEND_UNCONFIRMED");
        }
    }

    private static async Task<ILocator?> WaitForEnabledSendButton(
        IPage page,
        TimeSpan timeout,
        CancellationToken cancellationToken)
    {
        var deadline = DateTimeOffset.UtcNow + timeout;
        while (DateTimeOffset.UtcNow < deadline)
        {
            cancellationToken.ThrowIfCancellationRequested();
            var sendButtons = page.GetByRole(AriaRole.Button, new() { NameRegex = SendPattern });
            var send = await ProjectNavigator.FindFirstVisible(sendButtons, cancellationToken);
            if (send is not null && await send.IsEnabledAsync())
                return send;

            await Task.Delay(ReadyPollInterval, cancellationToken);
        }

        return null;
    }

    private static async Task<bool> WaitForSubmissionConfirmed(
        IPage page,
        ILocator composer,
        int userMessagesBefore,
        string fingerprint,
        TimeSpan timeout,
        CancellationToken cancellationToken)
    {
        var deadline = DateTimeOffset.UtcNow + timeout;
        while (DateTimeOffset.UtcNow < deadline)
        {
            cancellationToken.ThrowIfCancellationRequested();
            try
            {
                if (!page.IsClosed && await IsSubmissionConfirmed(
                        page, composer, userMessagesBefore, fingerprint))
                    return true;
            }
            catch (PlaywrightException)
            {
                // DOM churn while the SPA re-renders is not evidence either way; keep polling
                // until the deadline, then fail closed as unconfirmed.
            }

            await Task.Delay(ReadyPollInterval, cancellationToken);
        }

        return false;
    }

    private static async Task<bool> IsSubmissionConfirmed(
        IPage page,
        ILocator composer,
        int userMessagesBefore,
        string fingerprint)
    {
        // Positive proof requires all three: a new user turn exists, the newest user turn
        // carries this instruction, and the composer no longer holds it as a draft.
        var userMessages = page.Locator(UserMessageSelector);
        var count = await userMessages.CountAsync();
        if (count <= userMessagesBefore)
            return false;

        var newest = Normalize(await userMessages.Nth(count - 1).InnerTextAsync());
        if (!newest.Contains(fingerprint, StringComparison.Ordinal))
            return false;

        if (await composer.CountAsync() == 0 || !await composer.IsVisibleAsync())
            return true;

        return !Normalize(await ReadComposerText(composer)).Contains(fingerprint, StringComparison.Ordinal);
    }

    private static async Task<string> ReadComposerText(ILocator composer)
    {
        var editable = await composer.EvaluateAsync<bool>(
            "el => el instanceof HTMLTextAreaElement || el instanceof HTMLInputElement");
        return editable
            ? await composer.InputValueAsync()
            : await composer.InnerTextAsync();
    }

    internal static string Normalize(string? text) =>
        WhitespacePattern.Replace(text ?? string.Empty, " ").Trim();

    internal static string Fingerprint(string instruction)
    {
        var normalized = Normalize(instruction);
        return normalized.Length <= FingerprintLength
            ? normalized
            : normalized[..FingerprintLength];
    }

    private static async Task<ILocator?> WaitForStableComposer(
        IPage page,
        TimeSpan timeout,
        TimeSpan stableWindow,
        CancellationToken cancellationToken)
    {
        var deadline = DateTimeOffset.UtcNow + timeout;
        DateTimeOffset? readySince = null;

        while (DateTimeOffset.UtcNow < deadline)
        {
            cancellationToken.ThrowIfCancellationRequested();
            if (page.IsClosed)
                return null;

            var stopButtons = page.GetByRole(AriaRole.Button, new() { NameRegex = StopPattern });
            var turnBusy = await ProjectNavigator.FindFirstVisible(stopButtons, cancellationToken) is not null;
            var composer = turnBusy ? null : await FindComposer(page, cancellationToken);

            if (composer is null)
            {
                readySince = null;
            }
            else
            {
                readySince ??= DateTimeOffset.UtcNow;
                if (DateTimeOffset.UtcNow - readySince >= stableWindow)
                    return composer;
            }

            await Task.Delay(ReadyPollInterval, cancellationToken);
        }

        return null;
    }

    private static async Task<ILocator?> FindComposer(IPage page, CancellationToken cancellationToken)
    {
        var semantic = page.GetByRole(AriaRole.Textbox);
        var count = await semantic.CountAsync();
        for (var index = 0; index < count; index++)
        {
            cancellationToken.ThrowIfCancellationRequested();
            var candidate = semantic.Nth(index);
            if (await candidate.IsVisibleAsync() && await candidate.IsEnabledAsync())
                return candidate;
        }

        var fallback = page.Locator("textarea, [contenteditable='true'][role='textbox'], [contenteditable='true']");
        count = await fallback.CountAsync();
        for (var index = 0; index < count; index++)
        {
            cancellationToken.ThrowIfCancellationRequested();
            var candidate = fallback.Nth(index);
            if (await candidate.IsVisibleAsync() && await candidate.IsEnabledAsync())
                return candidate;
        }

        return null;
    }
}
