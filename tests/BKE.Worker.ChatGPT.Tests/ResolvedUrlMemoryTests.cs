using System.Net;
using System.Net.Sockets;
using System.Text;
using BKE.Worker.ChatGPT.Playwright;
using BKE.Worker.Core;
using Xunit;

namespace BKE.Worker.ChatGPT.Tests;

public sealed class ResolvedUrlMemoryTests
{
    [Fact]
    public async Task Same_target_on_same_remembered_url_skips_redundant_navigation()
    {
        await using var server = await LoopbackServer.Start(PageHtml);
        var profile = CreateProfileDirectory();
        await using var host = new ChromiumHost(new ChromiumHostOptions(profile, Headless: true, server.BaseUrl));
        var driver = new ChatGPTWebDriver(
            host,
            new ProjectNavigator(),
            new ConversationNavigator(),
            new ComposerDriver());
        var target = ContextTarget.ProjectChat("DUMP", "Engineering Loop");

        try
        {
            await driver.OpenContext(target, CancellationToken.None);
            var page = await host.GetPage(CancellationToken.None);

            Assert.Equal(1, await ReadNavigationCount(page));

            await driver.OpenContext(target, CancellationToken.None);

            Assert.Equal(1, await ReadNavigationCount(page));
        }
        finally
        {
            DeleteProfileDirectory(profile);
        }
    }

    [Fact]
    public async Task Remembered_target_re_resolves_when_browser_url_changes()
    {
        await using var server = await LoopbackServer.Start(PageHtml);
        var profile = CreateProfileDirectory();
        await using var host = new ChromiumHost(new ChromiumHostOptions(profile, Headless: true, server.BaseUrl));
        var driver = new ChatGPTWebDriver(
            host,
            new ProjectNavigator(),
            new ConversationNavigator(),
            new ComposerDriver());
        var target = ContextTarget.ProjectChat("DUMP", "Engineering Loop");

        try
        {
            await driver.OpenContext(target, CancellationToken.None);
            var page = await host.GetPage(CancellationToken.None);
            Assert.Equal(1, await ReadNavigationCount(page));

            await page.GotoAsync(server.BaseUrl + "other");
            await driver.OpenContext(target, CancellationToken.None);

            Assert.Equal(2, await ReadNavigationCount(page));
        }
        finally
        {
            DeleteProfileDirectory(profile);
        }
    }

    private static Task<int> ReadNavigationCount(Microsoft.Playwright.IPage page) =>
        page.EvaluateAsync<int>("Number(localStorage.getItem('project-open-count') || '0')");

    private static string CreateProfileDirectory()
    {
        var path = Path.Combine(Path.GetTempPath(), "bke-worker-playwright", Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(path);
        return path;
    }

    private static void DeleteProfileDirectory(string path)
    {
        if (Directory.Exists(path))
            Directory.Delete(path, recursive: true);
    }

    private const string PageHtml = """
        <!doctype html>
        <html>
        <body>
          <button aria-label="Projects" id="projects">Projects</button>

          <section id="project-list" hidden>
            <button id="project">DUMP</button>
          </section>

          <section id="conversation-list" hidden>
            <a href="#" id="conversation">Engineering Loop</a>
          </section>

          <section id="composer" hidden>
            <textarea aria-label="Prompt"></textarea>
            <button aria-label="Send prompt" id="send">Send</button>
          </section>

          <script>
            document.getElementById('projects').addEventListener('click', () => {
              const count = Number(localStorage.getItem('project-open-count') || '0');
              localStorage.setItem('project-open-count', String(count + 1));
              document.getElementById('project-list').hidden = false;
            });

            document.getElementById('project').addEventListener('click', () => {
              document.getElementById('conversation-list').hidden = false;
            });

            document.getElementById('conversation').addEventListener('click', event => {
              event.preventDefault();
              document.getElementById('composer').hidden = false;
            });
          </script>
        </body>
        </html>
        """;

    private sealed class LoopbackServer : IAsyncDisposable
    {
        private readonly TcpListener _listener;
        private readonly CancellationTokenSource _stop = new();
        private readonly Task _serveTask;
        private readonly byte[] _body;

        private LoopbackServer(TcpListener listener, string html)
        {
            _listener = listener;
            _body = Encoding.UTF8.GetBytes(html);
            var endpoint = (IPEndPoint)_listener.LocalEndpoint;
            BaseUrl = $"http://127.0.0.1:{endpoint.Port}/";
            _serveTask = Serve(_stop.Token);
        }

        public string BaseUrl { get; }

        public static Task<LoopbackServer> Start(string html)
        {
            var listener = new TcpListener(IPAddress.Loopback, 0);
            listener.Start();
            return Task.FromResult(new LoopbackServer(listener, html));
        }

        private async Task Serve(CancellationToken cancellationToken)
        {
            while (!cancellationToken.IsCancellationRequested)
            {
                TcpClient client;
                try
                {
                    client = await _listener.AcceptTcpClientAsync(cancellationToken);
                }
                catch (OperationCanceledException)
                {
                    break;
                }

                _ = Respond(client, cancellationToken);
            }
        }

        private async Task Respond(TcpClient client, CancellationToken cancellationToken)
        {
            using (client)
            {
                await using var stream = client.GetStream();
                var requestBuffer = new byte[4096];
                _ = await stream.ReadAsync(requestBuffer, cancellationToken);

                var headers = Encoding.ASCII.GetBytes(
                    "HTTP/1.1 200 OK\r\n" +
                    "Content-Type: text/html; charset=utf-8\r\n" +
                    $"Content-Length: {_body.Length}\r\n" +
                    "Connection: close\r\n\r\n");

                await stream.WriteAsync(headers, cancellationToken);
                await stream.WriteAsync(_body, cancellationToken);
            }
        }

        public async ValueTask DisposeAsync()
        {
            _stop.Cancel();
            _listener.Stop();
            try
            {
                await _serveTask;
            }
            catch (ObjectDisposedException)
            {
            }
            finally
            {
                _stop.Dispose();
            }
        }
    }
}
