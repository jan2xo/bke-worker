using System.Text.RegularExpressions;
using Microsoft.Playwright;

namespace BKE.Worker.ChatGPT.Playwright;

public sealed record ComposerProbe(
    bool ComposerAvailable,
    bool TurnBusy,
    bool CanSendNextTurn);

public sealed class ComposerDriver
{
    private static readonly Regex StopPattern = new("stop", RegexOptions.IgnoreCase);
    private static readonly Regex SendPattern = new("^send", RegexOptions.IgnoreCase);
    private static readonly TimeSpan DefaultReadyTimeout = TimeSpan.FromSeconds(15);
    private static readonly TimeSpan StableReadyWindow = TimeSpan.FromMilliseconds(750);
    private static readonly TimeSpan ReadyPollInterval = TimeSpan.FromMilliseconds(100);

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

    public async Task<bool> CanSendNextTurn(IPage page, CancellationToken cancellationToken) =>
        (await Probe(page, cancellationToken)).CanSendNextTurn;

    public async Task<bool> WaitUntilCanSendNextTurn(
        IPage page,
        CancellationToken cancellationToken,
        TimeSpan? timeout = null)
    {
        var ready = await WaitForStableComposer(
            page,
            timeout ?? DefaultReadyTimeout,
            cancellationToken);
        return ready is not null;
    }

    public async Task Send(IPage page, string instruction, CancellationToken cancellationToken)
    {
        ArgumentException.ThrowIfNullOrWhiteSpace(instruction);

        var composer = await WaitForStableComposer(page, DefaultReadyTimeout, cancellationToken);
        if (composer is null)
        {
            var state = await Probe(page, cancellationToken);
            throw new InvalidOperationException(
                state.TurnBusy
                    ? "CHATGPT_TURN_NOT_IDLE"
                    : "CHATGPT_COMPOSER_NOT_AVAILABLE");
        }

        await composer.FillAsync(instruction);

        var sendButtons = page.GetByRole(AriaRole.Button, new() { NameRegex = SendPattern });
        var send = await ProjectNavigator.FindFirstVisible(sendButtons, cancellationToken);
        if (send is not null && await send.IsEnabledAsync())
        {
            await send.ClickAsync();
            return;
        }

        await composer.PressAsync("Enter");
    }

    private static async Task<ILocator?> WaitForStableComposer(
        IPage page,
        TimeSpan timeout,
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
                if (DateTimeOffset.UtcNow - readySince >= StableReadyWindow)
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
