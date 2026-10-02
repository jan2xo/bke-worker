using Microsoft.Playwright;

namespace BKE.Worker.ChatGPT.Playwright;

public sealed class ConversationNavigator
{
    public async Task<IReadOnlyList<string>> ListConversations(
        IPage page,
        CancellationToken cancellationToken)
    {
        cancellationToken.ThrowIfCancellationRequested();
        var links = await page.GetByRole(AriaRole.Link).AllTextContentsAsync();

        return links
            .Select(value => value.Trim())
            .Where(value => !string.IsNullOrWhiteSpace(value))
            .Distinct(StringComparer.Ordinal)
            .ToArray();
    }

    public async Task OpenExactConversation(
        IPage page,
        string conversation,
        CancellationToken cancellationToken)
    {
        ArgumentException.ThrowIfNullOrWhiteSpace(conversation);
        var target = page.GetByText(conversation, new() { Exact = true });
        var visible = await ProjectNavigator.FindFirstVisible(target, cancellationToken);
        if (visible is null)
            throw new ChatGptNavigationException("CONTEXT_NOT_FOUND");

        await visible.ClickAsync();
    }
}
