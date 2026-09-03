using BKE.Worker.ChatGPT.Playwright;
using Xunit;

namespace BKE.Worker.ChatGPT.Tests;

public sealed class ProjectNavigatorModernUiTests
{
    [Fact]
    public async Task Exact_project_can_be_opened_directly_from_visible_sidebar()
    {
        var profile = CreateProfileDirectory();
        var host = new ChromiumHost(new ChromiumHostOptions(
            profile,
            Headless: true,
            "http://127.0.0.1:1/"));

        try
        {
            var page = await host.GetPage(CancellationToken.None);
            await page.SetContentAsync("""
                <!doctype html>
                <html>
                <body>
                  <nav aria-label="Sidebar">
                    <a href="#" id="project">BKE Worker</a>
                  </nav>
                  <script>
                    document.getElementById('project').addEventListener('click', event => {
                      event.preventDefault();
                      document.body.dataset.projectOpened = 'true';
                    });
                  </script>
                </body>
                </html>
                """);

            await new ProjectNavigator().OpenExactProject(
                page,
                "BKE Worker",
                CancellationToken.None);

            Assert.Equal(
                "true",
                await page.GetAttributeAsync("body", "data-project-opened"));
        }
        finally
        {
            await host.DisposeAsync();
            DeleteProfileDirectory(profile);
        }
    }

    [Fact]
    public async Task Visible_exact_project_is_preferred_over_sidebar_opener()
    {
        var profile = CreateProfileDirectory();
        var host = new ChromiumHost(new ChromiumHostOptions(
            profile,
            Headless: true,
            "http://127.0.0.1:1/"));

        try
        {
            var page = await host.GetPage(CancellationToken.None);
            await page.SetContentAsync("""
                <!doctype html>
                <html>
                <body>
                  <button aria-label="Open sidebar" id="open-sidebar">Open sidebar</button>
                  <nav aria-label="Sidebar">
                    <a href="#" id="project">BKE Worker</a>
                  </nav>
                  <script>
                    document.getElementById('open-sidebar').addEventListener('click', () => {
                      document.body.dataset.sidebarOpenerClicked = 'true';
                    });
                    document.getElementById('project').addEventListener('click', event => {
                      event.preventDefault();
                      document.body.dataset.projectOpened = 'true';
                    });
                  </script>
                </body>
                </html>
                """);

            await new ProjectNavigator().OpenExactProject(
                page,
                "BKE Worker",
                CancellationToken.None);

            Assert.Equal(
                "true",
                await page.GetAttributeAsync("body", "data-project-opened"));
            Assert.Null(await page.GetAttributeAsync("body", "data-sidebar-opener-clicked"));
        }
        finally
        {
            await host.DisposeAsync();
            DeleteProfileDirectory(profile);
        }
    }

    [Fact]
    public async Task Collapsed_sidebar_is_opened_semantically_before_exact_project_selection()
    {
        var profile = CreateProfileDirectory();
        var host = new ChromiumHost(new ChromiumHostOptions(
            profile,
            Headless: true,
            "http://127.0.0.1:1/"));

        try
        {
            var page = await host.GetPage(CancellationToken.None);
            await page.SetContentAsync("""
                <!doctype html>
                <html>
                <body>
                  <button aria-label="Open sidebar" id="open-sidebar">Open sidebar</button>
                  <nav aria-label="Sidebar" id="sidebar" hidden>
                    <a href="#" id="project">BKE Worker</a>
                  </nav>
                  <script>
                    document.getElementById('open-sidebar').addEventListener('click', () => {
                      document.getElementById('sidebar').hidden = false;
                      document.getElementById('open-sidebar').hidden = true;
                    });
                    document.getElementById('project').addEventListener('click', event => {
                      event.preventDefault();
                      document.body.dataset.projectOpened = 'true';
                    });
                  </script>
                </body>
                </html>
                """);

            await new ProjectNavigator().OpenExactProject(
                page,
                "BKE Worker",
                CancellationToken.None);

            Assert.Equal(
                "true",
                await page.GetAttributeAsync("body", "data-project-opened"));
        }
        finally
        {
            await host.DisposeAsync();
            DeleteProfileDirectory(profile);
        }
    }

    private static string CreateProfileDirectory()
    {
        var path = Path.Combine(
            Path.GetTempPath(),
            "bke-worker-project-nav",
            Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(path);
        return path;
    }

    private static void DeleteProfileDirectory(string path)
    {
        if (Directory.Exists(path))
            Directory.Delete(path, recursive: true);
    }
}
