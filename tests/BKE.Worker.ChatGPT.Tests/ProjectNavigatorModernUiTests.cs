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
    public async Task Visible_aria_controlled_sidebar_is_not_opened_again()
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
                  <button aria-label="Open sidebar"
                          aria-expanded="false"
                          aria-controls="stage-slideover-sidebar"
                          id="open-sidebar">Open sidebar</button>
                  <div id="stage-slideover-sidebar">
                    <a href="#">Other navigation</a>
                  </div>
                  <script>
                    document.getElementById('open-sidebar').addEventListener('click', () => {
                      document.body.dataset.sidebarOpenerClicked = 'true';
                    });
                  </script>
                </body>
                </html>
                """);

            await Assert.ThrowsAsync<ChatGptNavigationException>(() =>
                new ProjectNavigator().ListProjects(
                    page,
                    CancellationToken.None));

            Assert.Null(await page.GetAttributeAsync("body", "data-sidebar-opener-clicked"));
        }
        finally
        {
            await host.DisposeAsync();
            DeleteProfileDirectory(profile);
        }
    }

    [Fact]
    public async Task Collapsed_sidebar_is_opened_semantically_before_projects_navigation()
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
                  <button aria-label="Open sidebar" aria-controls="sidebar" id="open-sidebar">Open sidebar</button>
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

    [Fact]
    public async Task Projects_navigation_waits_for_route_and_delayed_project_render()
    {
        var profile = CreateProfileDirectory();
        var host = new ChromiumHost(new ChromiumHostOptions(
            profile,
            Headless: true,
            "http://127.0.0.1:1/"));

        try
        {
            var page = await host.GetPage(CancellationToken.None);
            await page.RouteAsync("http://chatgpt.test/**", async route =>
            {
                var body = new Uri(route.Request.Url).AbsolutePath == "/projects"
                    ? """
                        <!doctype html>
                        <html>
                        <body>
                          <script>
                            setTimeout(() => {
                              const project = document.createElement('a');
                              project.href = '#';
                              project.id = 'project';
                              project.textContent = 'BKE Worker';
                              project.addEventListener('click', event => {
                                event.preventDefault();
                                document.body.dataset.projectOpened = 'true';
                              });
                              document.body.appendChild(project);
                            }, 300);
                          </script>
                        </body>
                        </html>
                        """
                    : """
                        <!doctype html>
                        <html>
                        <body>
                          <button aria-expanded="true">Recents</button>
                          <a href="/projects">Projects</a>
                        </body>
                        </html>
                        """;

                await route.FulfillAsync(new()
                {
                    Status = 200,
                    ContentType = "text/html",
                    Body = body
                });
            });

            await page.GotoAsync("http://chatgpt.test/");

            await new ProjectNavigator().OpenExactProject(
                page,
                "BKE Worker",
                CancellationToken.None);

            Assert.Equal("/projects", new Uri(page.Url).AbsolutePath);
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
