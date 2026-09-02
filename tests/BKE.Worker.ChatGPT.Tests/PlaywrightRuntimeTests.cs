using System.Net;
using System.Net.Sockets;
using System.Text;
using BKE.Worker.ChatGPT.Playwright;
using BKE.Worker.Core;
using Xunit;

namespace BKE.Worker.ChatGPT.Tests;

public sealed class PlaywrightRuntimeTests
{
    [Fact]
    public async Task Persistent_chromium_profile_survives_restart()
    {
        await using var server = await LoopbackServer.Start(PageHtml);
        var profile = CreateProfileDirectory();
        var host = new ChromiumHost(new ChromiumHostOptions(profile, Headless: true, server.BaseUrl));

        try
        {
            var page = await host.GetPage(CancellationToken.None);
            await page.GotoAsync(server.BaseUrl);
            await page.EvaluateAsync("localStorage.setItem('bke-worker-marker', 'persisted')");

            await host.Restart(CancellationToken.None);

            page = await host.GetPage(CancellationToken.None);
            await page.GotoAsync(server.BaseUrl);
            var marker = await page.EvaluateAsync<string?>("localStorage.getItem('bke-worker-marker')");

            Assert.Equal("persisted", marker);
        }
        finally
        {
            await host.DisposeAsync();
            DeleteProfileDirectory(profile);
        }
    }

    [Fact]
    public async Task Controlled_chatgpt_surface_supports_exact_project_conversation_send_and_idle_guard()
    {
        await using var server = await LoopbackServer.Start(PageHtml);
        var profile = CreateProfileDirectory();
        var host = new ChromiumHost(new ChromiumHostOptions(profile, Headless: true, server.BaseUrl));
        var driver = new ChatGPTWebDriver(
            host,
            new ProjectNavigator(),
            new ConversationNavigator(),
            new ComposerDriver());

        try
        {
            await driver.OpenContext(
                new ContextTarget(
                    ContextTargetType.ProjectChat,
                    Conversation: "Engineering Loop",
                    Project: "DUMP"),
                CancellationToken.None);

            Assert.True(await driver.CanSendNextTurn(CancellationToken.None));

            await driver.Send("CONTINUE FROM THE NOTION CHECKLIST.", CancellationToken.None);

            var page = await host.GetPage(CancellationToken.None);
            var submitted = await page.EvaluateAsync<string?>("localStorage.getItem('last-prompt')");
            Assert.Equal("CONTINUE FROM THE NOTION CHECKLIST.", submitted);

            await page.EvaluateAsync("document.getElementById('stop').hidden = false");
            Assert.False(await driver.CanSendNextTurn(CancellationToken.None));
        }
        finally
        {
            await host.DisposeAsync();
            DeleteProfileDirectory(profile);
        }
    }

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
            <button id="wrong-project">DUMP OLD</button>
            <button id="project">DUMP</button>
          </section>

          <section id="conversation-list" hidden>
            <a href="#" id="wrong-conversation">Engineering Loop OLD</a>
            <a href="#" id="conversation">Engineering Loop</a>
          </section>

          <section id="composer" hidden>
            <textarea aria-label="Prompt"></textarea>
            <button aria-label="Send prompt" id="send">Send</button>
            <button aria-label="Stop generating" id="stop" hidden>Stop</button>
          </section>

          <script>
            document.getElementById('projects').addEventListener('click', () => {
              document.getElementById('project-list').hidden = false;
            });

            document.getElementById('project').addEventListener('click', () => {
              document.getElementById('conversation-list').hidden = false;
            });

            document.getElementById('conversation').addEventListener('click', event => {
              event.preventDefault();
              document.getElementById('composer').hidden = false;
            });

            document.getElementById('send').addEventListener('click', () => {
              const prompt = document.querySelector('textarea').value;
              localStorage.setItem('last-prompt', prompt);
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
