using Microsoft.Playwright;

namespace BKE.Worker.ChatGPT.Playwright;

public sealed class ChatGptNavigationException(string code) : InvalidOperationException(code);

public sealed class ProjectNavigator
{
    private const int NavigationTimeoutMs = 10_000;
    private const int ProjectRenderTimeoutMs = 10_000;

    public async Task<IReadOnlyList<string>> ListProjects(IPage page, CancellationToken cancellationToken)
    {
        if (!await OpenProjectsIndex(page, cancellationToken))
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

        // Controlled/legacy surfaces can expose the exact project directly. Preserve that path,
        // but current chatgpt.com normally exposes a Projects navigation link first.
        var visible = await FindExactProject(page, project, cancellationToken);
        if (visible is not null)
        {
            await visible.ClickAsync();
            return;
        }

        if (!await OpenProjectsIndex(page, cancellationToken))
            throw new ChatGptNavigationException("PROJECTS_NOT_FOUND");

        // /projects is an SPA route. Route completion does not imply that the project cards have
        // rendered yet, so wait for the exact semantic target rather than racing the next click.
        await WaitForExactProject(page, project, cancellationToken);

        visible = await FindExactProject(page, project, cancellationToken);
        if (visible is null)
            throw new ChatGptNavigationException("PROJECT_NOT_FOUND");

        await visible.ClickAsync();
    }

    private static async Task<bool> OpenProjectsIndex(IPage page, CancellationToken cancellationToken)
    {
        cancellationToken.ThrowIfCancellationRequested();

        if (IsProjectsRoute(page.Url))
            return true;

        var projects = await FindProjectsLink(page, cancellationToken);
        if (projects is null)
        {
            await EnsureRecentsExpanded(page, cancellationToken);
            projects = await FindProjectsLink(page, cancellationToken);
        }

        if (projects is null)
        {
            await EnsureSidebarOpen(page, cancellationToken);
            await EnsureRecentsExpanded(page, cancellationToken);
            projects = await FindProjectsLink(page, cancellationToken);
        }

        if (projects is null)
            return false;

        var href = await projects.GetAttributeAsync("href");
        var navigatesToProjects = IsProjectsHref(href);

        try
        {
            await projects.ClickAsync(new() { Timeout = NavigationTimeoutMs });
        }
        catch (PlaywrightException)
        {
            return false;
        }

        if (navigatesToProjects)
        {
            try
            {
                await page.WaitForURLAsync(
                    "**/projects*",
                    new()
                    {
                        Timeout = NavigationTimeoutMs,
                        WaitUntil = WaitUntilState.DOMContentLoaded
                    });
            }
            catch (PlaywrightException)
            {
                if (!IsProjectsRoute(page.Url))
                    return false;
            }
        }

        cancellationToken.ThrowIfCancellationRequested();
        return true;
    }

    private static async Task<ILocator?> FindProjectsLink(
        IPage page,
        CancellationToken cancellationToken)
    {
        var links = page.GetByRole(
            AriaRole.Link,
            new() { Name = "Projects", Exact = true });
        var count = await links.CountAsync();

        for (var index = 0; index < count; index++)
        {
            cancellationToken.ThrowIfCancellationRequested();
            var candidate = links.Nth(index);
            if (!await candidate.IsVisibleAsync())
                continue;

            var href = await candidate.GetAttributeAsync("href");
            if (IsProjectsHref(href))
                return candidate;
        }

        return null;
    }

    private static async Task EnsureRecentsExpanded(IPage page, CancellationToken cancellationToken)
    {
        cancellationToken.ThrowIfCancellationRequested();

        var recents = page.GetByRole(
            AriaRole.Button,
            new() { Name = "Recents", Exact = true });
        var visible = await FindFirstVisible(recents, cancellationToken);
        if (visible is null)
            return;

        var expanded = await visible.GetAttributeAsync("aria-expanded");
        if (string.Equals(expanded, "true", StringComparison.OrdinalIgnoreCase))
            return;

        try
        {
            await visible.ClickAsync(new() { Timeout = NavigationTimeoutMs });
        }
        catch (PlaywrightException)
        {
            // Fail closed later if the Projects link still cannot be discovered.
        }
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

            if (await IsControlledSurfaceVisible(page, visible, cancellationToken))
                return;

            try
            {
                await visible.ClickAsync(new() { Timeout = 1500 });
            }
            catch (PlaywrightException)
            {
                // Do not bypass actionability or force the click.
            }

            return;
        }
    }

    private static async Task<bool> IsControlledSurfaceVisible(
        IPage page,
        ILocator control,
        CancellationToken cancellationToken)
    {
        cancellationToken.ThrowIfCancellationRequested();
        var controlledId = await control.GetAttributeAsync("aria-controls");
        if (string.IsNullOrWhiteSpace(controlledId))
            return false;

        var escapedId = controlledId
            .Replace("\\", "\\\\", StringComparison.Ordinal)
            .Replace("\"", "\\\"", StringComparison.Ordinal);

        var controlledSurface = page.Locator($"[id=\"{escapedId}\"]");
        return await FindFirstVisible(controlledSurface, cancellationToken) is not null;
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

    private static bool IsProjectsHref(string? href) =>
        !string.IsNullOrWhiteSpace(href) &&
        (string.Equals(href, "/projects", StringComparison.OrdinalIgnoreCase) ||
         href.StartsWith("/projects?", StringComparison.OrdinalIgnoreCase) ||
         href.StartsWith("/projects#", StringComparison.OrdinalIgnoreCase));

    private static bool IsProjectsRoute(string? url)
    {
        if (!Uri.TryCreate(url, UriKind.Absolute, out var current))
            return false;

        return string.Equals(current.AbsolutePath.TrimEnd('/'), "/projects", StringComparison.OrdinalIgnoreCase);
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
