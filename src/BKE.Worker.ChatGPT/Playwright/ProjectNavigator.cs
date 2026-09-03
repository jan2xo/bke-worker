using Microsoft.Playwright;

namespace BKE.Worker.ChatGPT.Playwright;

public sealed class ChatGptNavigationException(string code) : InvalidOperationException(code);

public sealed class ProjectNavigator
{
    private const int NavigationTimeoutMs = 10_000;
    private const int ProjectRenderTimeoutMs = 10_000;
    private const string LiveProjectsUrl = "https://chatgpt.com/projects";

    public async Task<IReadOnlyList<string>> ListProjects(IPage page, CancellationToken cancellationToken)
    {
        if (IsLiveChatGpt(page.Url))
        {
            await OpenLiveProjectsDirectory(page, cancellationToken);
            var rows = page.GetByRole(AriaRole.Row);
            var values = new List<string>();
            var count = await rows.CountAsync();

            for (var index = 0; index < count; index++)
            {
                cancellationToken.ThrowIfCancellationRequested();
                var row = rows.Nth(index);
                if (!await row.IsVisibleAsync())
                    continue;

                var text = (await row.InnerTextAsync()).Trim();
                if (!string.IsNullOrWhiteSpace(text))
                    values.Add(text);
            }

            return values.Distinct(StringComparer.Ordinal).ToArray();
        }

        if (!await OpenControlledProjectsIndex(page, cancellationToken))
            throw new ChatGptNavigationException("PROJECTS_NOT_FOUND");

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

        if (IsLiveChatGpt(page.Url))
        {
            await OpenLiveProjectsDirectory(page, cancellationToken);
            await WaitForExactProject(page, project, cancellationToken);

            var row = await FindExactProjectRow(page, project, cancellationToken);
            if (row is null)
                throw new ChatGptNavigationException("PROJECT_NOT_FOUND");

            await row.ClickAsync(new() { Timeout = NavigationTimeoutMs });
            return;
        }

        // Controlled fixtures from the earlier certification phases can expose the exact
        // project directly or behind a semantic Projects control. Preserve that behavior
        // independently from the current live chatgpt.com adapter.
        var visible = await FindExactProject(page, project, cancellationToken);
        if (visible is not null)
        {
            await visible.ClickAsync();
            return;
        }

        if (!await OpenControlledProjectsIndex(page, cancellationToken))
            throw new ChatGptNavigationException("PROJECTS_NOT_FOUND");

        await WaitForExactProject(page, project, cancellationToken);

        visible = await FindExactProject(page, project, cancellationToken);
        if (visible is null)
            throw new ChatGptNavigationException("PROJECT_NOT_FOUND");

        await visible.ClickAsync();
    }

    private static async Task OpenLiveProjectsDirectory(
        IPage page,
        CancellationToken cancellationToken)
    {
        cancellationToken.ThrowIfCancellationRequested();

        if (!IsProjectsRoute(page.Url))
        {
            try
            {
                // Current live ChatGPT exposes Projects at the stable href /projects.
                // Use the route directly instead of racing responsive sidebar controls.
                await page.GotoAsync(
                    LiveProjectsUrl,
                    new()
                    {
                        Timeout = NavigationTimeoutMs,
                        WaitUntil = WaitUntilState.DOMContentLoaded
                    });
            }
            catch (PlaywrightException)
            {
                throw new ChatGptNavigationException("PROJECTS_NOT_FOUND");
            }
        }

        if (!IsProjectsRoute(page.Url))
            throw new ChatGptNavigationException("PROJECTS_NOT_FOUND");

        cancellationToken.ThrowIfCancellationRequested();
    }

    private static async Task<ILocator?> FindExactProjectRow(
        IPage page,
        string project,
        CancellationToken cancellationToken)
    {
        var rows = page.GetByRole(AriaRole.Row);
        var count = await rows.CountAsync();

        for (var index = 0; index < count; index++)
        {
            cancellationToken.ThrowIfCancellationRequested();
            var row = rows.Nth(index);
            if (!await row.IsVisibleAsync())
                continue;

            var exactName = row.GetByText(project, new() { Exact = true });
            if (await FindFirstVisible(exactName, cancellationToken) is not null)
                return row;
        }

        return null;
    }

    private static async Task<bool> OpenControlledProjectsIndex(
        IPage page,
        CancellationToken cancellationToken)
    {
        cancellationToken.ThrowIfCancellationRequested();

        if (IsProjectsRoute(page.Url))
            return true;

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

        try
        {
            await visible.ClickAsync(new() { Timeout = NavigationTimeoutMs });
            return true;
        }
        catch (PlaywrightException)
        {
            return false;
        }
    }

    private static async Task WaitForExactProject(
        IPage page,
        string project,
        CancellationToken cancellationToken)
    {
        cancellationToken.ThrowIfCancellationRequested();

        var target = page.GetByText(project, new() { Exact = true }).First;
        try
        {
            await target.WaitForAsync(new()
            {
                State = WaitForSelectorState.Visible,
                Timeout = ProjectRenderTimeoutMs
            });
        }
        catch (PlaywrightException)
        {
            throw new ChatGptNavigationException("PROJECT_NOT_FOUND");
        }

        cancellationToken.ThrowIfCancellationRequested();
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

    private static bool IsLiveChatGpt(string? url)
    {
        if (!Uri.TryCreate(url, UriKind.Absolute, out var current))
            return false;

        return string.Equals(current.Host, "chatgpt.com", StringComparison.OrdinalIgnoreCase) ||
               string.Equals(current.Host, "www.chatgpt.com", StringComparison.OrdinalIgnoreCase);
    }

    private static bool IsProjectsRoute(string? url)
    {
        if (!Uri.TryCreate(url, UriKind.Absolute, out var current))
            return false;

        return string.Equals(
            current.AbsolutePath.TrimEnd('/'),
            "/projects",
            StringComparison.OrdinalIgnoreCase);
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
