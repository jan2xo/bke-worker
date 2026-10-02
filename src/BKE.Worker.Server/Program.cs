using System.Text.Json;
using System.Text.Json.Serialization;
using System.Threading.Channels;
using BKE.Worker.ChatGPT.Playwright;
using BKE.Worker.Core;
using BKE.Worker.GitHub;

var builder = WebApplication.CreateBuilder(new WebApplicationOptions
{
    Args = args,
    WebRootPath = Path.Combine(
        AppContext.BaseDirectory,
        "wwwroot")
});
var settings =
    WorkerServerSettings.FromConfiguration(
        builder.Configuration);

builder.Services.ConfigureHttpJsonOptions(options =>
    options.SerializerOptions.Converters.Add(
        new JsonStringEnumConverter()));
builder.Services.AddSingleton(settings);
builder.Services.AddSingleton(
    new GitHubWebhookOptions(
        settings.GitHubWebhookSecret));
builder.Services.AddSingleton<GitHubSignatureVerifier>();
builder.Services.AddSingleton<ProjectNavigator>();
builder.Services.AddSingleton<ConversationNavigator>();
builder.Services.AddSingleton<ComposerDriver>();
builder.Services.AddSingleton(
    new ChromiumHostOptions(
        settings.ChatGptProfileDirectory,
        settings.Headless,
        settings.ChatGptBaseUrl,
        settings.BrowserCdpEndpoint));
builder.Services.AddSingleton<ChromiumHost>();
builder.Services.AddSingleton<ChatGPTWebDriver>();
builder.Services.AddSingleton<IChatGPTDriver>(
    services =>
        services.GetRequiredService<ChatGPTWebDriver>());
builder.Services.AddSingleton<IWorkerStateStore>(
    _ => new JsonWorkerStateStore(settings.StateFile));
builder.Services.AddSingleton(
    new WorkerPolicy(
        MinimumDispatchInterval:
            settings.MinimumDispatchInterval));
builder.Services.AddSingleton<IWorkerLoop>(
    services => new WorkerLoop(
        services.GetRequiredService<IChatGPTDriver>(),
        services.GetRequiredService<IWorkerStateStore>(),
        services.GetRequiredService<WorkerPolicy>()));
builder.Services.AddSingleton<WorkerWakeQueue>();
builder.Services.AddSingleton<IWorkerWakeSink>(
    services =>
        services.GetRequiredService<WorkerWakeQueue>());
builder.Services.AddSingleton<GitHubWebhookEndpoint>();
builder.Services.AddHostedService<WorkerHostedService>();

var app = builder.Build();

app.UseDefaultFiles();
app.UseStaticFiles();

app.MapGet(
    "/health",
    () => Results.Ok(new
    {
        status = "ok",
        configured = settings.IsConfigured,
        runtime = "github-native-playwright",
        heartbeatSeconds =
            (int)settings.HeartbeatInterval.TotalSeconds,
    }));

app.MapGet(
    "/health/live",
    () => Results.Ok(new
    {
        status = "alive",
        runtime = "github-native-playwright",
    }));

app.MapGet(
    "/health/ready",
    () =>
    {
        var payload = new
        {
            status =
                settings.IsConfigured
                    ? "ready"
                    : "not_ready",
            configured = settings.IsConfigured,
            runtime = "github-native-playwright",
            heartbeatSeconds =
                (int)settings.HeartbeatInterval.TotalSeconds,
        };

        return settings.IsConfigured
            ? Results.Ok(payload)
            : Results.Json(
                payload,
                statusCode:
                    StatusCodes
                        .Status503ServiceUnavailable);
    });

app.MapGet(
    "/control/state",
    async (
        IWorkerLoop loop,
        CancellationToken cancellationToken) =>
        Results.Ok(
            await loop.GetState(cancellationToken)));

app.MapGet(
    "/control/summary",
    async (
        IWorkerLoop loop,
        CancellationToken cancellationToken) =>
    {
        var snapshot =
            await loop.GetState(cancellationToken);
        return Results.Ok(new
        {
            runtime = "github-native-playwright",
            ready = settings.IsConfigured,
            engineeringAuthority = "github",
            oneIntentPerPullRequest = true,
            freshBranchFromCurrentMain = true,
            pullRequestTemplate =
                ".github/pull_request_template.md",
            heartbeatSeconds =
                (int)settings
                    .HeartbeatInterval
                    .TotalSeconds,
            snapshot,
            target = snapshot.Target,
            configuration = new
            {
                githubWebhookConfigured =
                    !string.IsNullOrWhiteSpace(
                        settings
                            .GitHubWebhookSecret),
                chatGptTargetConfigured =
                    settings.ChatGptTargetConfigured,
                chatGptTargetMode =
                    settings.ChatGptTargetMode,
                browserCdpConfigured =
                    settings.BrowserCdpConfigured,
            },
            browser = new
            {
                mode =
                    settings.BrowserCdpConfigured
                        ? "cdp-attach"
                        : "playwright-launch",
                liveChatGptRequiresCdp =
                    settings.LiveChatGptBaseUrl,
            },
            browserProfileDirectory =
                settings.ChatGptProfileDirectory,
            chatGptBaseUrl =
                settings.ChatGptBaseUrl,
        });
    });

app.MapPost(
    "/control/continue",
    async (
        IWorkerWakeSink wakeSink,
        CancellationToken cancellationToken) =>
    {
        if (!settings.IsConfigured)
        {
            return Results.Problem(
                title:
                    "BKE Worker is not configured",
                detail:
                    "Configure the deterministic ChatGPT target, loopback browser CDP for live chatgpt.com, and GitHub webhook secret before manual continuation.",
                statusCode:
                    StatusCodes
                        .Status503ServiceUnavailable);
        }

        await wakeSink.Enqueue(
            new WorkerWakeEvent(
                WorkerWakeReason.Manual,
                null,
                DateTimeOffset.UtcNow),
            cancellationToken);

        return Results.Accepted(value: new
        {
            accepted = true,
            reason = WorkerWakeReason.Manual,
            message =
                "Manual autonomous engineering continuation queued.",
        });
    });

app.MapPost(
    "/control/chatgpt/probe",
    async (
        IWorkerLoop loop,
        ChatGPTWebDriver driver,
        CancellationToken cancellationToken) =>
    {
        if (!settings.ChatGptTargetConfigured)
        {
            var detail =
                settings.ChatGptTargetAmbiguous
                    ? "Project + Conversation and Override Link are mutually exclusive."
                    : settings.ChatGptOverridePresent &&
                      !settings.ChatGptOverrideConfigured
                        ? "The configured ChatGPT override URL is invalid. Use an HTTPS chatgpt.com conversation URL containing /c/<conversation-id>."
                        : "Project and Conversation must be configured together, or configure an Override Link.";

            return Results.Problem(
                title:
                    "ChatGPT target is invalid",
                detail: detail,
                statusCode:
                    StatusCodes
                        .Status503ServiceUnavailable);
        }

        var snapshot =
            await loop.GetState(cancellationToken);

        if (snapshot.State is
            WorkerRuntimeState.DISPATCHING or
            WorkerRuntimeState.CONTINUING)
        {
            return Results.Problem(
                title:
                    "Worker browser is active",
                detail:
                    "Adapter probing is blocked while the worker is dispatching.",
                statusCode:
                    StatusCodes.Status409Conflict);
        }

        var result =
            settings.ChatGptTargetMode switch
            {
                "override-link" =>
                    await driver.ProbeOverrideLink(
                        settings.ChatGptOverrideUrl,
                        cancellationToken),
                "project-chat" =>
                    await driver.ProbeExactContext(
                        settings.ChatGptProject,
                        settings.ChatGptConversation,
                        cancellationToken),
                _ =>
                    await driver.ProbeNewChat(
                        cancellationToken),
            };

        return result.Compatible
            ? Results.Ok(result)
            : Results.Json(
                result,
                statusCode:
                    StatusCodes
                        .Status503ServiceUnavailable);
    });

app.MapPost(
    "/webhooks/github",
    (
        HttpRequest request,
        GitHubWebhookEndpoint endpoint,
        CancellationToken cancellationToken) =>
        endpoint.Handle(
            request,
            cancellationToken));

await app.RunAsync();

public sealed record WorkerServerSettings(
    string ChatGptProject,
    string ChatGptConversation,
    string ChatGptOverrideUrl,
    string ChatGptBaseUrl,
    string GitHubWebhookSecret,
    string ChatGptProfileDirectory,
    string StateFile,
    string BrowserCdpEndpoint,
    bool Headless,
    TimeSpan WebhookDebounce,
    TimeSpan HeartbeatInterval,
    TimeSpan MinimumDispatchInterval)
{
    public bool ChatGptProjectPresent =>
        !string.IsNullOrWhiteSpace(ChatGptProject);

    public bool ChatGptConversationPresent =>
        !string.IsNullOrWhiteSpace(
            ChatGptConversation);

    public bool ChatGptSemanticTargetConfigured =>
        ChatGptProjectPresent &&
        ChatGptConversationPresent;

    public bool ChatGptSemanticTargetPartial =>
        ChatGptProjectPresent !=
        ChatGptConversationPresent;

    public bool ChatGptOverridePresent =>
        !string.IsNullOrWhiteSpace(
            ChatGptOverrideUrl);

    public bool ChatGptOverrideConfigured =>
        ChatGptOverridePresent &&
        IsValidChatGptConversationOverride(
            ChatGptOverrideUrl);

    public bool ChatGptTargetAmbiguous =>
        ChatGptOverridePresent &&
        (ChatGptProjectPresent ||
         ChatGptConversationPresent);

    public bool ChatGptUsesNewChat =>
        !ChatGptOverridePresent &&
        !ChatGptProjectPresent &&
        !ChatGptConversationPresent;

    public bool ChatGptTargetConfigured =>
        !ChatGptTargetAmbiguous &&
        !ChatGptSemanticTargetPartial &&
        (ChatGptOverridePresent
            ? ChatGptOverrideConfigured
            : true);

    public string ChatGptTargetMode =>
        ChatGptTargetAmbiguous
            ? "invalid-ambiguous"
            : ChatGptOverridePresent
                ? ChatGptOverrideConfigured
                    ? "override-link"
                    : "invalid-override"
                : ChatGptSemanticTargetPartial
                    ? "invalid-incomplete"
                    : ChatGptSemanticTargetConfigured
                        ? "project-chat"
                        : "new-chat";

    public bool LiveChatGptBaseUrl =>
        Uri.TryCreate(
            ChatGptBaseUrl,
            UriKind.Absolute,
            out var uri) &&
        string.Equals(
            uri.Host,
            "chatgpt.com",
            StringComparison.OrdinalIgnoreCase);

    public bool BrowserCdpConfigured =>
        !string.IsNullOrWhiteSpace(
            BrowserCdpEndpoint) &&
        Uri.TryCreate(
            BrowserCdpEndpoint,
            UriKind.Absolute,
            out var uri) &&
        uri.IsLoopback;

    public bool BrowserRuntimeConfigured =>
        !LiveChatGptBaseUrl ||
        BrowserCdpConfigured;

    public bool IsConfigured =>
        BrowserRuntimeConfigured &&
        ChatGptTargetConfigured &&
        !string.IsNullOrWhiteSpace(
            GitHubWebhookSecret);

    public EngineeringTarget Target =>
        new(
            ChatGptProject,
            ChatGptConversation,
            OverrideUrl:
                ChatGptOverrideUrl);

    public static WorkerServerSettings FromConfiguration(
        IConfiguration configuration) =>
        new(
            configuration[
                "BKE_WORKER_CHATGPT_PROJECT"] ??
                string.Empty,
            configuration[
                "BKE_WORKER_CHATGPT_CONVERSATION"] ??
                string.Empty,
            configuration[
                "BKE_WORKER_CHATGPT_OVERRIDE_URL"] ??
                string.Empty,
            configuration[
                "BKE_WORKER_CHATGPT_BASE_URL"] ??
                "https://chatgpt.com/",
            configuration[
                "BKE_WORKER_GITHUB_WEBHOOK_SECRET"] ??
                string.Empty,
            configuration[
                "BKE_WORKER_CHATGPT_PROFILE"] ??
                "/var/lib/bke-worker/chatgpt-profile",
            configuration[
                "BKE_WORKER_STATE_FILE"] ??
                "/var/lib/bke-worker/state/worker.json",
            configuration[
                "BKE_WORKER_BROWSER_CDP_ENDPOINT"] ??
                string.Empty,
            ParseBool(
                configuration[
                    "BKE_WORKER_HEADLESS"],
                defaultValue: true),
            TimeSpan.FromSeconds(
                ParsePositiveInt(
                    configuration[
                        "BKE_WORKER_WEBHOOK_DEBOUNCE_SECONDS"],
                    10)),
            TimeSpan.FromSeconds(
                ParsePositiveInt(
                    configuration[
                        "BKE_WORKER_HEARTBEAT_SECONDS"],
                    1800)),
            TimeSpan.FromSeconds(
                ParsePositiveInt(
                    configuration[
                        "BKE_WORKER_MIN_DISPATCH_SECONDS"],
                    30)));

    private static bool IsValidChatGptConversationOverride(
        string value)
    {
        if (!Uri.TryCreate(
                value,
                UriKind.Absolute,
                out var uri) ||
            !string.Equals(
                uri.Scheme,
                Uri.UriSchemeHttps,
                StringComparison.OrdinalIgnoreCase) ||
            !(string.Equals(
                  uri.Host,
                  "chatgpt.com",
                  StringComparison.OrdinalIgnoreCase) ||
              string.Equals(
                  uri.Host,
                  "www.chatgpt.com",
                  StringComparison.OrdinalIgnoreCase)))
        {
            return false;
        }

        var segments =
            uri.AbsolutePath.Split(
                '/',
                StringSplitOptions
                    .RemoveEmptyEntries |
                StringSplitOptions
                    .TrimEntries);

        for (
            var index = 0;
            index < segments.Length - 1;
            index++)
        {
            if (string.Equals(
                    segments[index],
                    "c",
                    StringComparison.OrdinalIgnoreCase) &&
                !string.IsNullOrWhiteSpace(
                    segments[index + 1]))
            {
                return true;
            }
        }

        return false;
    }

    private static bool ParseBool(
        string? value,
        bool defaultValue) =>
        bool.TryParse(
            value,
            out var parsed)
            ? parsed
            : defaultValue;

    private static int ParsePositiveInt(
        string? value,
        int defaultValue) =>
        int.TryParse(
            value,
            out var parsed) &&
        parsed > 0
            ? parsed
            : defaultValue;
}

public sealed class JsonWorkerStateStore(
    string path) : IWorkerStateStore
{
    private static readonly JsonSerializerOptions
        SerializerOptions = new()
        {
            WriteIndented = true,
            Converters =
            {
                new JsonStringEnumConverter(),
            },
        };

    private readonly SemaphoreSlim _mutex =
        new(1, 1);

    public async Task<WorkerSnapshot> Load(
        CancellationToken cancellationToken)
    {
        await _mutex.WaitAsync(
            cancellationToken);
        try
        {
            if (!File.Exists(path))
                return WorkerSnapshot.Empty;

            var json =
                await File.ReadAllTextAsync(
                    path,
                    cancellationToken);
            return
                JsonSerializer
                    .Deserialize<WorkerSnapshot>(
                        json,
                        SerializerOptions) ??
                WorkerSnapshot.Empty;
        }
        finally
        {
            _mutex.Release();
        }
    }

    public async Task Save(
        WorkerSnapshot snapshot,
        CancellationToken cancellationToken)
    {
        await _mutex.WaitAsync(
            cancellationToken);
        try
        {
            var directory =
                Path.GetDirectoryName(path);
            if (!string.IsNullOrWhiteSpace(
                    directory))
            {
                Directory.CreateDirectory(
                    directory);
            }

            var temp = path + ".tmp";
            var json =
                JsonSerializer.Serialize(
                    snapshot,
                    SerializerOptions);
            await File.WriteAllTextAsync(
                temp,
                json,
                cancellationToken);
            File.Move(
                temp,
                path,
                overwrite: true);
        }
        finally
        {
            _mutex.Release();
        }
    }
}

public sealed class WorkerWakeQueue :
    IWorkerWakeSink
{
    private readonly Channel<WorkerWakeEvent>
        _channel =
            Channel.CreateUnbounded<WorkerWakeEvent>(
                new UnboundedChannelOptions
                {
                    SingleReader = true,
                    SingleWriter = false,
                    AllowSynchronousContinuations =
                        false,
                });

    public ChannelReader<WorkerWakeEvent>
        Reader => _channel.Reader;

    public ValueTask Enqueue(
        WorkerWakeEvent wakeEvent,
        CancellationToken cancellationToken) =>
        _channel.Writer.WriteAsync(
            wakeEvent,
            cancellationToken);
}

public sealed class WorkerHostedService(
    IWorkerLoop loop,
    WorkerWakeQueue wakeQueue,
    WorkerServerSettings settings,
    ILogger<WorkerHostedService> logger)
    : BackgroundService
{
    protected override async Task ExecuteAsync(
        CancellationToken stoppingToken)
    {
        if (!settings.IsConfigured)
        {
            logger.LogWarning(
                "BKE Worker is unconfigured; set deterministic ChatGPT target, loopback browser CDP for live chatgpt.com, and GitHub webhook secret.");
            await Task.Delay(
                Timeout.InfiniteTimeSpan,
                stoppingToken);
            return;
        }

        var start =
            await loop.Start(
                settings.Target,
                stoppingToken);

        logger.LogInformation(
            "Worker startup result: {State} {Message}",
            start.State,
            start.Message);

        await Task.WhenAll(
            ConsumeWakeEvents(stoppingToken),
            RunHeartbeat(stoppingToken));
    }

    private async Task ConsumeWakeEvents(
        CancellationToken cancellationToken)
    {
        await foreach (
            var wakeEvent in
            wakeQueue.Reader.ReadAllAsync(
                cancellationToken))
        {
            if (wakeEvent.Reason ==
                WorkerWakeReason.GitHubPush)
            {
                await Task.Delay(
                    settings.WebhookDebounce,
                    cancellationToken);
            }

            var result =
                await loop.Wake(
                    wakeEvent.Reason,
                    wakeEvent.DeliveryId,
                    cancellationToken);

            logger.LogInformation(
                "Worker wake {Reason}: {State} {Message} promptSent={PromptSent}",
                wakeEvent.Reason,
                result.State,
                result.Message,
                result.PromptSent);
        }
    }

    private async Task RunHeartbeat(
        CancellationToken cancellationToken)
    {
        using var timer =
            new PeriodicTimer(
                settings.HeartbeatInterval);

        while (
            await timer.WaitForNextTickAsync(
                cancellationToken))
        {
            var state =
                await loop.GetState(
                    cancellationToken);

            if (state.State !=
                WorkerRuntimeState
                    .WAITING_FOR_ENGINEERING_EVENT)
            {
                continue;
            }

            var result =
                await loop.Wake(
                    WorkerWakeReason.Heartbeat,
                    null,
                    cancellationToken);

            logger.LogInformation(
                "Heartbeat: {State} {Message} promptSent={PromptSent}",
                result.State,
                result.Message,
                result.PromptSent);
        }
    }
}
