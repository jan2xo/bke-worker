using Microsoft.Playwright;

namespace BKE.Worker.ChatGPT.Playwright;

public sealed class ChatGptNavigationException(string code) : InvalidOperationException(code);

public sealed class ProjectNavigator
{
    public async Task<IReadOnlyList<string>> ListProjects(IPage page, CancellationToken cancellationToken)
    {
        await EnsureSidebarOpen(page, cancellationToken);
        _ = await TryOpenProjectsIndex(page, cancellationToken);

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
        cancellationToken.ThrowIfCancellationRequested();

        await EnsureSidebarOpen(page, cancellationToken);

        var visible = await FindExactProject(page, project, cancellationToken);
        if (visible is not null)
        {
            await visible.ClickAsync();
            return;
        }

        if (await TryOpenProjectsIndex(page, cancellationToken))
        {
            visible = await FindExactProject(page, project, cancellationToken);
            if (visible is not null)
            {
                await visible.ClickAsync();
                return;
            }
        }

        throw new ChatGptNavigationException("PROJECT_NOT_FOUND");
    }

    private static async Task EnsureSidebarOpen(IPage page, CancellationToken cancellationToken)
    {
        cancellationToken.ThrowIfCancellationRequested();

        foreach (var label in new[] { "Open sidebar", "Show sidebar", "Open navigation", "Show navigation" })
        {
            var opener = page.GetByRole(
                AriaRole.Button,
                new() { Name = label, Exact = true });
            var visible = await FindFirstVisible(opener, cancellationToken);
            if (visible is null)
                continue;

            await visible.ClickAsync();
            return;
        }
    }

    private static async Task<ILocator?> FindExactProject(
        IPage page,
        string project,
        CancellationToken cancellationToken)
    {
        var link = page.GetByRole(
            AriaRole.Link,
            new() { Name = project, Exact = true });
        var visible = await FindFirstVisible(link, cancellationToken);
        if (visible is not null)
            return visible;

        var button = page.GetByRole(
            AriaRole.Button,
            new() { Name = project, Exact = true });
        visible = await FindFirstVisible(button, cancellationToken);
        if (visible is not null)
            return visible;

        return await FindFirstVisible(
            page.GetByText(project, new() { Exact = true }),
            cancellationToken);
    }

    private static async Task<bool> TryOpenProjectsIndex(IPage page, CancellationToken cancellationToken)
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
            return false;

        await visible.ClickAsync();
        return true;
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
