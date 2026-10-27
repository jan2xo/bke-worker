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
                    Project: "DUMP",
                    Surface: ChatGptExecutionSurface.Chat),
                CancellationToken.None);

            Assert.True(await driver.CanSendNextTurn(CancellationToken.None));

            await driver.Send("CONTINUE FROM THE NOTION CHECKLIST.", CancellationToken.None);

            var page = await host.GetPage(CancellationToken.None);
            var submitted = await page.EvaluateAsync<string?>("localStorage.getItem('last-prompt')");
            Assert.Equal("CONTINUE FROM THE NOTION CHECKLIST.", submitted);
            Assert.Equal(
                "CONTINUE FROM THE NOTION CHECKLIST.",
                await page.EvaluateAsync<string?>(
                    "document.querySelector(\"[data-message-author-role='user']\")?.textContent"));
            Assert.Equal("", await page.EvaluateAsync<string>("document.querySelector('textarea').value"));

            await page.EvaluateAsync("document.getElementById('stop').hidden = false");
            Assert.False(await driver.CanSendNextTurn(CancellationToken.None));
        }
        finally
        {
            await host.DisposeAsync();
            DeleteProfileDirectory(profile);
        }
    }

    [Fact]
    public async Task Send_waits_for_delayed_composer_hydration()
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
                ContextTarget.ProjectChat("DUMP", "Engineering Loop"),
                CancellationToken.None);

            var page = await host.GetPage(CancellationToken.None);
            await page.EvaluateAsync("""
                const composer = document.getElementById('composer');
                composer.hidden = true;
                setTimeout(() => { composer.hidden = false; }, 600);
                """);

            await driver.Send("WAIT FOR COMPOSER", CancellationToken.None);

            var submitted = await page.EvaluateAsync<string?>("localStorage.getItem('last-prompt')");
            Assert.Equal("WAIT FOR COMPOSER", submitted);
        }
        finally
        {
            await host.DisposeAsync();
            DeleteProfileDirectory(profile);
        }
    }

    [Fact]
    public async Task Send_refuses_existing_draft_without_clearing_or_submitting_it()
    {
        await WithOpenSurface(new ComposerDriver(), async (driver, page) =>
        {
            await page.EvaluateAsync("document.querySelector('textarea').value = 'EARLIER UNCONFIRMED DRAFT'");

            var exception = await Assert.ThrowsAsync<ChatGptSendNotSubmittedException>(() =>
                driver.Send("NEW INSTRUCTION", CancellationToken.None));

            Assert.Equal("CHATGPT_COMPOSER_HAS_EXISTING_DRAFT", exception.Message);
            Assert.Equal(
                "EARLIER UNCONFIRMED DRAFT",
                await page.EvaluateAsync<string>("document.querySelector('textarea').value"));
            Assert.Null(await page.EvaluateAsync<string?>("localStorage.getItem('last-prompt')"));
            Assert.Equal(0, await UserTurnCount(page));
        });
    }

    [Fact]
    public async Task Send_has_no_enter_fallback_when_send_button_is_missing()
    {
        await WithOpenSurface(new ComposerDriver(), async (driver, page) =>
        {
            await page.EvaluateAsync("document.getElementById('send').remove()");

            var exception = await Assert.ThrowsAsync<ChatGptSendNotSubmittedException>(() =>
                driver.Send("NO BUTTON", CancellationToken.None));

            Assert.Equal("CHATGPT_SEND_BUTTON_UNAVAILABLE", exception.Message);
            Assert.Null(await page.EvaluateAsync<string?>("localStorage.getItem('enter-pressed')"));
            Assert.Equal(0, await UserTurnCount(page));
        });
    }

    [Fact]
    public async Task Send_has_no_enter_fallback_when_send_button_stays_disabled()
    {
        await WithOpenSurface(new ComposerDriver(), async (driver, page) =>
        {
            await page.EvaluateAsync("document.getElementById('send').disabled = true");

            var exception = await Assert.ThrowsAsync<ChatGptSendNotSubmittedException>(() =>
                driver.Send("DISABLED BUTTON", CancellationToken.None));

            Assert.Equal("CHATGPT_SEND_BUTTON_UNAVAILABLE", exception.Message);
            Assert.Null(await page.EvaluateAsync<string?>("localStorage.getItem('enter-pressed')"));
        });
    }

    [Fact]
    public async Task Send_waits_for_send_button_that_enables_after_input()
    {
        await WithOpenSurface(new ComposerDriver(), async (driver, page) =>
        {
            await page.EvaluateAsync("""
                const send = document.getElementById('send');
                send.disabled = true;
                document.querySelector('textarea').addEventListener('input', () => {
                  setTimeout(() => { send.disabled = false; }, 800);
                });
                """);

            await driver.Send("LATE BUTTON", CancellationToken.None);

            Assert.Equal(1, await UserTurnCount(page));
            Assert.Null(await page.EvaluateAsync<string?>("localStorage.getItem('enter-pressed')"));
        });
    }

    [Fact]
    public async Task Click_that_leaves_draft_in_composer_is_unconfirmed_not_dispatched()
    {
        await WithOpenSurface(new ComposerDriver(TimeSpan.FromSeconds(2)), async (driver, page) =>
        {
            await page.EvaluateAsync("window.bkeSubmitMode = 'retain-draft'");

            var exception = await Assert.ThrowsAsync<ChatGptSendUnconfirmedException>(() =>
                driver.Send("BKE WORKER PERSONAL PILOT", CancellationToken.None));

            Assert.Equal("CHATGPT_SEND_UNCONFIRMED", exception.Message);
            Assert.Equal(0, await UserTurnCount(page));
            Assert.Equal(
                "BKE WORKER PERSONAL PILOT",
                await page.EvaluateAsync<string>("document.querySelector('textarea').value"));
        });
    }

    [Fact]
    public async Task New_user_turn_with_different_text_is_unconfirmed()
    {
        await WithOpenSurface(new ComposerDriver(TimeSpan.FromSeconds(2)), async (driver, page) =>
        {
            await page.EvaluateAsync("window.bkeTranscriptOverride = 'SOMETHING ELSE ENTIRELY'");

            var exception = await Assert.ThrowsAsync<ChatGptSendUnconfirmedException>(() =>
                driver.Send("EXPECTED INSTRUCTION", CancellationToken.None));

            Assert.Equal("CHATGPT_SEND_UNCONFIRMED", exception.Message);
        });
    }

    [Fact]
    public async Task Confirmation_requires_a_new_turn_not_an_older_identical_one()
    {
        await WithOpenSurface(new ComposerDriver(TimeSpan.FromSeconds(2)), async (driver, page) =>
        {
            await page.EvaluateAsync("""
                const old = document.createElement('div');
                old.setAttribute('data-message-author-role', 'user');
                old.textContent = 'REPEATED INSTRUCTION';
                document.getElementById('transcript').appendChild(old);
                window.bkeSubmitMode = 'retain-draft';
                """);

            await Assert.ThrowsAsync<ChatGptSendUnconfirmedException>(() =>
                driver.Send("REPEATED INSTRUCTION", CancellationToken.None));
            Assert.Equal(1, await UserTurnCount(page));
        });
    }

    [Fact]
    public async Task Delayed_transcript_appearance_is_confirmed_within_window()
    {
        var composer = new ComposerDriver(TimeSpan.FromSeconds(6));
        await WithOpenSurface(composer, async (driver, page) =>
        {
            await page.EvaluateAsync("window.bkeSubmitMode = 'deliver-delayed'");

            await driver.Send("DELAYED BKE INSTRUCTION", CancellationToken.None);

            Assert.Equal(1, await UserTurnCount(page));
            Assert.NotNull(composer.LastSubmissionDiagnostics);
            Assert.True(composer.LastSubmissionDiagnostics!.Confirmed);
            Assert.False(composer.LastSubmissionDiagnostics.TimedOut);
        });
    }

    [Fact]
    public async Task Rerendered_user_turn_node_is_confirmed_not_lost_to_stale_locator()
    {
        var composer = new ComposerDriver(TimeSpan.FromSeconds(6));
        await WithOpenSurface(composer, async (driver, page) =>
        {
            await page.EvaluateAsync("window.bkeSubmitMode = 'deliver-replace'");

            await driver.Send("RERENDERED BKE INSTRUCTION", CancellationToken.None);

            Assert.True(composer.LastSubmissionDiagnostics!.Confirmed);
        });
    }

    [Fact]
    public async Task Contenteditable_composer_with_live_like_turn_structure_is_confirmed()
    {
        var composer = new ComposerDriver(TimeSpan.FromSeconds(4));
        await WithOpenSurface(composer, async (driver, page) =>
        {
            await page.EvaluateAsync("""
                const textarea = document.querySelector('textarea');
                const editor = document.createElement('div');
                editor.setAttribute('contenteditable', 'true');
                editor.id = 'prompt-textarea';
                editor.innerHTML = '<p><br></p>';
                textarea.replaceWith(editor);
                """);

            await driver.Send("CONTENTEDITABLE BKE INSTRUCTION", CancellationToken.None);

            Assert.True(composer.LastSubmissionDiagnostics!.Confirmed);
            Assert.Equal(1, await UserTurnCount(page));
        });
    }

    [Fact]
    public async Task Turn_delivered_but_composer_retaining_instruction_is_unconfirmed_with_predicate()
    {
        await WithOpenSurface(new ComposerDriver(TimeSpan.FromSeconds(2)), async (driver, page) =>
        {
            await page.EvaluateAsync("window.bkeSubmitMode = 'deliver-retain'");

            var exception = await Assert.ThrowsAsync<ChatGptSendUnconfirmedException>(() =>
                driver.Send("RETAINED BKE INSTRUCTION", CancellationToken.None));

            Assert.Equal("CHATGPT_SEND_UNCONFIRMED", exception.Message);
            var diagnostics = Assert.IsType<SubmissionDiagnostics>(exception.Diagnostics);
            Assert.Equal(SubmissionDiagnostics.ComposerRetainsDraft, diagnostics.FailedPredicate);
            Assert.True(diagnostics.NewUserTurnDetected);
            Assert.True(diagnostics.FingerprintMatched);
            Assert.True(diagnostics.ComposerRetainsInstruction);
            Assert.True(diagnostics.TimedOut);
        });
    }

    [Fact]
    public async Task Unconfirmed_diagnostics_name_the_failing_predicate_without_leaking_text()
    {
        const string instruction = "PRIVATE INSTRUCTION TEXT MUST NOT LEAK";
        await WithOpenSurface(new ComposerDriver(TimeSpan.FromSeconds(2)), async (driver, page) =>
        {
            await page.EvaluateAsync("window.bkeTranscriptOverride = 'SOMETHING ELSE ENTIRELY'");

            var exception = await Assert.ThrowsAsync<ChatGptSendUnconfirmedException>(() =>
                driver.Send(instruction, CancellationToken.None));

            var diagnostics = Assert.IsType<SubmissionDiagnostics>(exception.Diagnostics);
            Assert.Equal(SubmissionDiagnostics.FingerprintMismatch, diagnostics.FailedPredicate);
            Assert.Equal(0, diagnostics.UserTurnsBefore);
            Assert.Equal(1, diagnostics.UserTurnsAfter);
            var line = diagnostics.ToStatusLine();
            Assert.StartsWith("SEND_ACK_DIAG ", line);
            Assert.Contains("failed_predicate=NEWEST_USER_TURN_FINGERPRINT_MISMATCH", line);
            Assert.DoesNotContain("PRIVATE", line);
            Assert.DoesNotContain("SOMETHING ELSE", line);
            Assert.DoesNotContain("http", line);
        });
    }

    [Fact]
    public async Task Retained_draft_reports_no_new_turn_and_old_identical_turn_is_not_counted()
    {
        await WithOpenSurface(new ComposerDriver(TimeSpan.FromSeconds(2)), async (driver, page) =>
        {
            await page.EvaluateAsync("""
                const old = document.createElement('div');
                old.setAttribute('data-message-author-role', 'user');
                old.textContent = 'REPEATED INSTRUCTION';
                document.getElementById('transcript').appendChild(old);
                window.bkeSubmitMode = 'retain-draft';
                """);

            var exception = await Assert.ThrowsAsync<ChatGptSendUnconfirmedException>(() =>
                driver.Send("REPEATED INSTRUCTION", CancellationToken.None));

            var diagnostics = Assert.IsType<SubmissionDiagnostics>(exception.Diagnostics);
            Assert.Equal(SubmissionDiagnostics.NoNewUserTurn, diagnostics.FailedPredicate);
            Assert.Equal(1, diagnostics.UserTurnsBefore);
            Assert.Equal(1, diagnostics.UserTurnsAfter);
            Assert.True(diagnostics.ComposerRetainsInstruction);
            Assert.Equal(1, await UserTurnCount(page));
        });
    }

    [Fact]
    public async Task Delivered_turn_probe_is_read_only_and_reports_predicates()
    {
        await WithOpenSurface(new ComposerDriver(), async (driver, page) =>
        {
            await page.EvaluateAsync("""
                const turn = document.createElement('div');
                turn.setAttribute('data-message-author-role', 'user');
                turn.setAttribute('data-message-id', 'm-1');
                turn.textContent = 'ALREADY DELIVERED TURN ONE';
                document.getElementById('transcript').appendChild(turn);
                """);

            var hit = await ComposerDriver.InspectDeliveredTurn(page, "ALREADY DELIVERED TURN ONE", CancellationToken.None);
            var miss = await ComposerDriver.InspectDeliveredTurn(page, "NEVER SENT", CancellationToken.None);

            Assert.True(hit.ComposerFound && hit.ComposerEmpty);
            Assert.Equal(1, hit.UserRoleElements);
            Assert.Equal(1, hit.UserRoleElementsWithMessageId);
            Assert.True(hit.NewestUserRoleMatchesInnerText);
            Assert.True(hit.NewestUserRoleMatchesTextContent);
            Assert.True(hit.AnyUserRoleMatchesInnerText);
            Assert.True(hit.PageTextMatches);
            Assert.False(miss.NewestUserRoleMatchesInnerText);
            Assert.False(miss.PageTextMatches);
            Assert.DoesNotContain("ALREADY", hit.ToStatusLine());

            // Read-only: nothing was typed or clicked.
            Assert.Null(await page.EvaluateAsync<string?>("localStorage.getItem('last-prompt')"));
            Assert.Equal("", await page.EvaluateAsync<string>("document.querySelector('textarea').value"));
            Assert.Equal(1, await UserTurnCount(page));
        });
    }

    private static Task<int> UserTurnCount(Microsoft.Playwright.IPage page) =>
        page.EvaluateAsync<int>("document.querySelectorAll(\"[data-message-author-role='user']\").length");

    private static async Task WithOpenSurface(
        ComposerDriver composer,
        Func<ChatGPTWebDriver, Microsoft.Playwright.IPage, Task> body)
    {
        await using var server = await LoopbackServer.Start(PageHtml);
        var profile = CreateProfileDirectory();
        var host = new ChromiumHost(new ChromiumHostOptions(profile, Headless: true, server.BaseUrl));
        var driver = new ChatGPTWebDriver(
            host,
            new ProjectNavigator(),
            new ConversationNavigator(),
            composer);

        try
        {
            await driver.OpenContext(
                ContextTarget.ProjectChat("DUMP", "Engineering Loop"),
                CancellationToken.None);
            var page = await host.GetPage(CancellationToken.None);
            await body(driver, page);
        }
        finally
        {
            await host.DisposeAsync();
            DeleteProfileDirectory(profile);
        }
    }

    [Fact]
    public async Task Work_surface_is_rejected_before_browser_navigation_or_send()
    {
        var profile = CreateProfileDirectory();
        var host = new ChromiumHost(new ChromiumHostOptions(
            profile,
            Headless: true,
            "http://127.0.0.1:1/"));
        var driver = new ChatGPTWebDriver(
            host,
            new ProjectNavigator(),
            new ConversationNavigator(),
            new ComposerDriver());

        try
        {
            var exception = await Assert.ThrowsAsync<InvalidOperationException>(() =>
                driver.OpenContext(
                    ContextTarget.ProjectChat(
                        "DUMP",
                        "Engineering Loop",
                        ChatGptExecutionSurface.Work),
                    CancellationToken.None));

            Assert.Equal("CHATGPT_EXECUTION_SURFACE_MISMATCH", exception.Message);
        }
        finally
        {
            await host.DisposeAsync();
            DeleteProfileDirectory(profile);
        }
    }

    [Fact]
    public async Task Live_chatgpt_requires_operator_owned_cdp_browser()
    {
        var profile = CreateProfileDirectory();
        var host = new ChromiumHost(new ChromiumHostOptions(
            profile,
            Headless: false,
            "https://chatgpt.com/"));

        try
        {
            var exception = await Assert.ThrowsAsync<InvalidOperationException>(() =>
                host.GetPage(CancellationToken.None));

            Assert.Equal("LIVE_CHATGPT_REQUIRES_CDP_ATTACH", exception.Message);
        }
        finally
        {
            await host.DisposeAsync();
            DeleteProfileDirectory(profile);
        }
    }

    [Fact]
    public async Task Cdp_endpoint_must_be_loopback()
    {
        var profile = CreateProfileDirectory();
        var host = new ChromiumHost(new ChromiumHostOptions(
            profile,
            Headless: false,
            "https://chatgpt.com/",
            "http://192.0.2.10:9222"));

        try
        {
            var exception = await Assert.ThrowsAsync<InvalidOperationException>(() =>
                host.GetPage(CancellationToken.None));

            Assert.Equal("BROWSER_CDP_ENDPOINT_MUST_BE_LOOPBACK", exception.Message);
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

          <main id="transcript"></main>

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

            // Mirrors the live surface: a real submit adds a user turn and clears the composer.
            // Tests flip window.bkeSubmitMode to simulate other post-click outcomes:
            //   'deliver'          turn appears at once, composer cleared
            //   'retain-draft'     nothing delivered, draft stays in the composer
            //   'deliver-delayed'  turn appears only after window.bkeDeliverDelayMs
            //   'deliver-retain'   turn appears but the composer still holds the instruction
            //   'deliver-replace'  optimistic turn node is detached and re-rendered (SPA churn)
            window.bkeSubmitMode = 'deliver';
            window.bkeDeliverDelayMs = 1500;
            const composerBox = () => document.querySelector("textarea, [contenteditable='true']");
            const readBox = box => box instanceof HTMLTextAreaElement ? box.value : box.innerText;
            const clearBox = box => {
              if (box instanceof HTMLTextAreaElement) box.value = '';
              else box.innerHTML = '<p><br></p>';
            };
            // Live-like turn structure: an article wrapper, a screen-reader heading outside the
            // author-role node, and the text nested inside it.
            const appendTurn = text => {
              const article = document.createElement('article');
              article.setAttribute('data-turn', 'user');
              const heading = document.createElement('h5');
              heading.textContent = 'You said:';
              heading.style.position = 'absolute';
              heading.style.width = '1px';
              heading.style.height = '1px';
              heading.style.overflow = 'hidden';
              const turn = document.createElement('div');
              turn.setAttribute('data-message-author-role', 'user');
              turn.setAttribute('data-message-id', crypto.randomUUID());
              const body = document.createElement('div');
              body.style.whiteSpace = 'pre-wrap';
              body.textContent = text;
              turn.appendChild(body);
              article.append(heading, turn);
              document.getElementById('transcript').appendChild(article);
              return article;
            };
            document.getElementById('send').addEventListener('click', () => {
              const box = composerBox();
              const prompt = readBox(box);
              localStorage.setItem('last-prompt', prompt);
              const mode = window.bkeSubmitMode;
              if (mode === 'retain-draft') return;
              const text = window.bkeTranscriptOverride ?? prompt;
              if (mode === 'deliver-delayed') {
                clearBox(box);
                setTimeout(() => appendTurn(text), window.bkeDeliverDelayMs);
                return;
              }
              const article = appendTurn(text);
              if (mode === 'deliver-retain') return;
              clearBox(box);
              if (mode === 'deliver-replace') {
                const swap = () => { article.remove(); setTimeout(() => appendTurn(text), 150); };
                setTimeout(swap, 30);
              }
            });

            document.querySelector('textarea').addEventListener('keydown', event => {
              if (event.key === 'Enter') localStorage.setItem('enter-pressed', 'yes');
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
