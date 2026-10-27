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
public sealed class ChatGptSendUnconfirmedException(
    string code,
    Exception? inner = null,
    SubmissionDiagnostics? diagnostics = null)
    : InvalidOperationException(code, inner)
{
    /// <summary>Bounded, privacy-safe evidence of which confirmation predicate failed.</summary>
    public SubmissionDiagnostics? Diagnostics { get; } = diagnostics;
}

/// <summary>
/// Privacy-safe record of the post-click confirmation predicates. Holds only counts, booleans
/// and a predicate code: never prompt text, transcript text, URLs, cookies or page HTML.
/// </summary>
public sealed record SubmissionDiagnostics(
    int UserTurnsBefore,
    int UserTurnsAfter,
    bool NewUserTurnDetected,
    bool FingerprintMatched,
    bool ComposerVisible,
    bool ComposerRetainsInstruction,
    int TransientDomErrors,
    bool TimedOut,
    string FailedPredicate)
{
    public const string None = "NONE";
    public const string NoNewUserTurn = "NO_NEW_USER_TURN";
    public const string FingerprintMismatch = "NEWEST_USER_TURN_FINGERPRINT_MISMATCH";
    public const string ComposerRetainsDraft = "COMPOSER_RETAINS_INSTRUCTION";
    public const string DomUnreadable = "DOM_UNREADABLE";

    public bool Confirmed => FailedPredicate == None;

    public string ToStatusLine() =>
        "SEND_ACK_DIAG" +
        $" before={UserTurnsBefore}" +
        $" after={UserTurnsAfter}" +
        $" new_turn={Flag(NewUserTurnDetected)}" +
        $" fingerprint_match={Flag(FingerprintMatched)}" +
        $" composer_visible={Flag(ComposerVisible)}" +
        $" composer_retains={Flag(ComposerRetainsInstruction)}" +
        $" dom_errors={TransientDomErrors}" +
        $" timed_out={Flag(TimedOut)}" +
        $" failed_predicate={FailedPredicate}";

    private static string Flag(bool value) => value ? "1" : "0";
}

/// <summary>
/// Read-only evidence about an already-delivered instruction in the open transcript. Used by the
/// owner-run, non-sending acknowledgment probe. Holds only counts and booleans.
/// </summary>
public sealed record DeliveredTurnProbe(
    bool ComposerFound,
    bool ComposerVisible,
    bool ComposerEmpty,
    int UserRoleElements,
    int UserTurnArticles,
    bool NewestUserRoleMatchesInnerText,
    bool NewestUserRoleMatchesTextContent,
    bool AnyUserRoleMatchesInnerText,
    int UserRoleElementsWithMessageId,
    bool NewestUserRoleInnerTextReadable,
    bool PageTextMatches)
{
    public string ToStatusLine() =>
        "SEND_ACK_PROBE" +
        $" composer_found={F(ComposerFound)}" +
        $" composer_visible={F(ComposerVisible)}" +
        $" composer_empty={F(ComposerEmpty)}" +
        $" user_role_elements={UserRoleElements}" +
        $" user_turn_articles={UserTurnArticles}" +
        $" user_role_with_message_id={UserRoleElementsWithMessageId}" +
        $" newest_inner_text_readable={F(NewestUserRoleInnerTextReadable)}" +
        $" newest_match_inner_text={F(NewestUserRoleMatchesInnerText)}" +
        $" newest_match_text_content={F(NewestUserRoleMatchesTextContent)}" +
        $" any_user_role_match={F(AnyUserRoleMatchesInnerText)}" +
        $" page_text_match={F(PageTextMatches)}";

    private static string F(bool value) => value ? "1" : "0";
}

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
    // Every Playwright read inside the confirmation loop is bounded. Without this, one read on a
    // node the SPA is re-rendering inherits Playwright's 30 s default and can silently consume
    // the entire confirmation window before the predicate is evaluated again.
    private const float DomReadTimeoutMs = 2_000;
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

        var diagnostics = await WaitForSubmissionConfirmed(
            page,
            composer,
            userMessagesBefore,
            fingerprint,
            _submissionConfirmTimeout,
            cancellationToken);
        LastSubmissionDiagnostics = diagnostics;
        if (!diagnostics.Confirmed)
            throw new ChatGptSendUnconfirmedException("CHATGPT_SEND_UNCONFIRMED", null, diagnostics);
    }

    /// <summary>Diagnostics of the most recent post-click confirmation, confirmed or not.</summary>
    public SubmissionDiagnostics? LastSubmissionDiagnostics { get; private set; }

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

    private static async Task<SubmissionDiagnostics> WaitForSubmissionConfirmed(
        IPage page,
        ILocator composer,
        int userMessagesBefore,
        string fingerprint,
        TimeSpan timeout,
        CancellationToken cancellationToken)
    {
        var deadline = DateTimeOffset.UtcNow + timeout;
        var domErrors = 0;
        SubmissionDiagnostics? last = null;
        while (DateTimeOffset.UtcNow < deadline)
        {
            cancellationToken.ThrowIfCancellationRequested();
            try
            {
                if (!page.IsClosed)
                {
                    last = await ObserveSubmission(page, composer, userMessagesBefore, fingerprint, domErrors);
                    if (last.Confirmed)
                        return last;
                }
            }
            catch (PlaywrightException)
            {
                // DOM churn while the SPA re-renders is not evidence either way; count it and keep
                // polling until the deadline, then fail closed as unconfirmed.
                domErrors++;
            }

            await Task.Delay(ReadyPollInterval, cancellationToken);
        }

        return (last ?? new SubmissionDiagnostics(
                userMessagesBefore, -1, false, false, false, false, 0, false,
                SubmissionDiagnostics.DomUnreadable))
            with { TransientDomErrors = domErrors, TimedOut = true };
    }

    private static async Task<SubmissionDiagnostics> ObserveSubmission(
        IPage page,
        ILocator composer,
        int userMessagesBefore,
        string fingerprint,
        int domErrors)
    {
        // Positive proof requires all three: a new user turn exists, the newest user turn
        // carries this instruction, and the composer no longer holds it as a draft.
        var userMessages = page.Locator(UserMessageSelector);
        var count = await userMessages.CountAsync();
        var newTurn = count > userMessagesBefore;

        var matched = false;
        if (newTurn)
        {
            var newest = Normalize(await userMessages.Nth(count - 1).InnerTextAsync(
                new() { Timeout = DomReadTimeoutMs }));
            matched = newest.Contains(fingerprint, StringComparison.Ordinal);
        }

        var composerVisible = await composer.CountAsync() > 0 && await composer.IsVisibleAsync();
        var retains = composerVisible &&
            Normalize(await ReadComposerText(composer)).Contains(fingerprint, StringComparison.Ordinal);

        var failed = !newTurn ? SubmissionDiagnostics.NoNewUserTurn
            : !matched ? SubmissionDiagnostics.FingerprintMismatch
            : retains ? SubmissionDiagnostics.ComposerRetainsDraft
            : SubmissionDiagnostics.None;

        return new SubmissionDiagnostics(
            userMessagesBefore, count, newTurn, matched, composerVisible, retains, domErrors, false, failed);
    }

    /// <summary>
    /// Read-only inspection of the open transcript for an instruction that was already delivered.
    /// Never fills, clicks, presses keys or navigates. Returns counts and booleans only.
    /// </summary>
    public static async Task<DeliveredTurnProbe> InspectDeliveredTurn(
        IPage page,
        string instruction,
        CancellationToken cancellationToken)
    {
        ArgumentException.ThrowIfNullOrWhiteSpace(instruction);
        var fingerprint = Fingerprint(instruction);

        var composer = await FindComposer(page, cancellationToken);
        var composerVisible = composer is not null && await composer.IsVisibleAsync();
        var composerEmpty = composer is not null &&
            string.IsNullOrWhiteSpace(Normalize(await ReadComposerText(composer)));

        var userMessages = page.Locator(UserMessageSelector);
        var count = await userMessages.CountAsync();
        var articles = await page.Locator("[data-turn='user'], article[data-testid^='conversation-turn']").CountAsync();
        var withId = await page.Locator(UserMessageSelector + "[data-message-id]").CountAsync();

        bool newestReadable = false, newestInner = false, newestContent = false, any = false;
        if (count > 0)
        {
            var newest = userMessages.Nth(count - 1);
            try
            {
                var inner = Normalize(await newest.InnerTextAsync(new() { Timeout = DomReadTimeoutMs }));
                newestReadable = inner.Length > 0;
                newestInner = inner.Contains(fingerprint, StringComparison.Ordinal);
                newestContent = Normalize(await newest.TextContentAsync(new() { Timeout = DomReadTimeoutMs }))
                    .Contains(fingerprint, StringComparison.Ordinal);
            }
            catch (PlaywrightException)
            {
            }

            for (var index = 0; index < count && !any; index++)
            {
                cancellationToken.ThrowIfCancellationRequested();
                try
                {
                    any = Normalize(await userMessages.Nth(index).InnerTextAsync(
                            new() { Timeout = DomReadTimeoutMs }))
                        .Contains(fingerprint, StringComparison.Ordinal);
                }
                catch (PlaywrightException)
                {
                }
            }
        }

        var pageText = Normalize(await page.Locator("body").InnerTextAsync(new() { Timeout = DomReadTimeoutMs }));
        return new DeliveredTurnProbe(
            composer is not null,
            composerVisible,
            composerEmpty,
            count,
            articles,
            newestInner,
            newestContent,
            any,
            withId,
            newestReadable,
            pageText.Contains(fingerprint, StringComparison.Ordinal));
    }

    private static async Task<string> ReadComposerText(ILocator composer)
    {
        var editable = await composer.EvaluateAsync<bool>(
            "el => el instanceof HTMLTextAreaElement || el instanceof HTMLInputElement",
            null,
            new() { Timeout = DomReadTimeoutMs });
        return editable
            ? await composer.InputValueAsync(new() { Timeout = DomReadTimeoutMs })
            : await composer.InnerTextAsync(new() { Timeout = DomReadTimeoutMs });
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
