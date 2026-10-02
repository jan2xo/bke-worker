using BKE.Worker.ChatGPT.Playwright;
using Xunit;

namespace BKE.Worker.ChatGPT.Tests;

public sealed class LiveProjectDirectoryNavigationTests
{
    [Fact]
    public async Task Live_chatgpt_uses_projects_href_directly_and_waits_for_project_row()
    {
        var profile = CreateProfileDirectory();
        var host = new ChromiumHost(new ChromiumHostOptions(
            profile,
            Headless: true,
            "http://127.0.0.1:1/"));

        try
        {
            var page = await host.GetPage(CancellationToken.None);
            await page.RouteAsync("https://chatgpt.com/**", async route =>
            {
                var path = new Uri(route.Request.Url).AbsolutePath;
                var body = path == "/projects"
                    ? """
                        <!doctype html>
                        <html>
                        <body>
                          <div role="grid" aria-label="Projects">
                            <script>
                              setTimeout(() => {
                                const row = document.createElement('div');
                                row.setAttribute('role', 'row');
                                row.setAttribute('tabindex', '0');
                                row.innerHTML = '<div role="gridcell"><div>BKE Worker</div></div><div role="gridcell">Today</div>';
                                row.addEventListener('click', () => {
                                  document.body.dataset.projectRowClicked = 'true';
                                });
                                document.querySelector('[role="grid"]').appendChild(row);
                              }, 300);
                            </script>
                          </div>
                        </body>
                        </html>
                        """
                    : """
                        <!doctype html>
                        <html>
                        <body>
                          <button aria-label="Open sidebar" onclick="localStorage.setItem('sidebar-clicked','true')">Open sidebar</button>
                          <button aria-expanded="false" onclick="localStorage.setItem('recents-clicked','true')">Recents</button>
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

            await page.GotoAsync("https://chatgpt.com/");

            await new ProjectNavigator().OpenExactProject(
                page,
                "BKE Worker",
                CancellationToken.None);

            Assert.Equal("/projects", new Uri(page.Url).AbsolutePath);
            Assert.Equal(
                "true",
                await page.GetAttributeAsync("body", "data-project-row-clicked"));
            Assert.Null(await page.EvaluateAsync<string?>("localStorage.getItem('sidebar-clicked')"));
            Assert.Null(await page.EvaluateAsync<string?>("localStorage.getItem('recents-clicked')"));
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
            "bke-worker-live-project-nav",
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
