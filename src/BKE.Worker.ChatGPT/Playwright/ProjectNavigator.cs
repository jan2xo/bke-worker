using Microsoft.Playwright;

namespace BKE.Worker.ChatGPT.Playwright;

public sealed class ChatGptNavigationException(string code) : InvalidOperationException(code);

public sealed class ProjectNavigator
{
    public async Task<IReadOnlyList<string>> ListProjects(IPage page, CancellationToken cancellationToken)
    {
        await OpenProjectsIndex(page, cancellationToken);
        var links = await page.GetByRole(AriaRole.Link).AllTextContentsAsync();
        var buttons = await page.GetByRole(AriaRole.Button).AllTextContentsAsync();

        return links.Concat(buttons)
            .Select(value => value.Trim())
            .Where(value => !string.IsNullOrWhiteSpace(value))
            .Distinct(StringComparer.Ordinal)
            .ToArray();
    }

    public async Task OpenExactProject(IPage page, string project, CancellationToken cancellationToken)
    {
        ArgumentException.ThrowIfNullOrWhiteSpace(project);
        await OpenProjectsIndex(page, cancellationToken);

        var target = page.GetByText(project, new() { Exact = true });
        var visible = await FindFirstVisible(target, cancellationToken);
        if (visible is null)
            throw new ChatGptNavigationException("PROJECT_NOT_FOUND");

        await visible.ClickAsync();
    }

    private static async Task OpenProjectsIndex(IPage page, CancellationToken cancellationToken)
    {
        cancellationToken.ThrowIfCancellationRequested();

        ILocator projects = page.GetByRole(
            AriaRole.Link,
            new() { Name = "Projects", Exact = true });
        var visible = await FindFirstVisible(projects, cancellationToken);

        if (visible is null)
        {
            projects = page.GetByRole(
                AriaRole.Button,
                new() { Name = "Projects", Exact = true });
            visible = await FindFirstVisible(projects, cancellationToken);
        }

        if (visible is null)
        {
            projects = page.GetByText("Projects", new() { Exact = true });
            visible = await FindFirstVisible(projects, cancellationToken);
        }

        if (visible is null)
            throw new ChatGptNavigationException("PROJECTS_NOT_FOUND");

        await visible.ClickAsync();
    }

    internal static async Task<ILocator?> FindFirstVisible(
        ILocator locator,
        CancellationToken cancellationToken)
    {
        var count = await locator.CountAsync();
        for (var index = 0; index < count; index++)
        {
            cancellationToken.ThrowIfCancellationRequested();
            var candidate = locator.Nth(index);
            if (await candidate.IsVisibleAsync())
                return candidate;
        }

        return null;
    }
}
