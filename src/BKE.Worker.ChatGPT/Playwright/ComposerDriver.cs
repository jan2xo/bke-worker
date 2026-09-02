using System.Text.RegularExpressions;
using Microsoft.Playwright;

namespace BKE.Worker.ChatGPT.Playwright;

public sealed class ComposerDriver
{
    private static readonly Regex StopPattern = new("stop", RegexOptions.IgnoreCase);
    private static readonly Regex SendPattern = new("^send", RegexOptions.IgnoreCase);

    public async Task<bool> CanSendNextTurn(IPage page, CancellationToken cancellationToken)
    {
        cancellationToken.ThrowIfCancellationRequested();
        if (page.IsClosed)
            return false;

        var stopButtons = page.GetByRole(AriaRole.Button, new() { NameRegex = StopPattern });
        if (await ProjectNavigator.FindFirstVisible(stopButtons, cancellationToken) is not null)
            return false;

        return await FindComposer(page, cancellationToken) is not null;
    }

    public async Task Send(IPage page, string instruction, CancellationToken cancellationToken)
    {
        ArgumentException.ThrowIfNullOrWhiteSpace(instruction);
        var composer = await FindComposer(page, cancellationToken);
        if (composer is null)
            throw new InvalidOperationException("CHATGPT_COMPOSER_NOT_AVAILABLE");

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
