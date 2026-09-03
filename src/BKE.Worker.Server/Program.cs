using System.Text.Json;
using System.Text.Json.Serialization;
using System.Threading.Channels;
using BKE.Worker.ChatGPT.Playwright;
using BKE.Worker.Core;
using BKE.Worker.GitHub;
using BKE.Worker.Notion;

var builder = WebApplication.CreateBuilder(new WebApplicationOptions
{
    Args = args,
    WebRootPath = Path.Combine(AppContext.BaseDirectory, "wwwroot")
});
var settings = WorkerServerSettings.FromConfiguration(builder.Configuration);

builder.Services.ConfigureHttpJsonOptions(options =>
    options.SerializerOptions.Converters.Add(new JsonStringEnumConverter()));
builder.Services.AddSingleton(settings);
builder.Services.AddSingleton(new GitHubWebhookOptions(settings.GitHubWebhookSecret));
builder.Services.AddSingleton<GitHubSignatureVerifier>();
builder.Services.AddSingleton<ProjectNavigator>();
builder.Services.AddSingleton<ConversationNavigator>();
builder.Services.AddSingleton<ComposerDriver>();
builder.Services.AddSingleton(new ChromiumHostOptions(
    settings.ChatGptProfileDirectory,
    settings.Headless,
    settings.ChatGptBaseUrl,
    settings.BrowserCdpEndpoint));
builder.Services.AddSingleton<ChromiumHost>();
builder.Services.AddSingleton<ChatGPTWebDriver>();
builder.Services.AddSingleton<IChatGPTDriver>(services => services.GetRequiredService<ChatGPTWebDriver>());
builder.Services.AddSingleton<INotionChecklistClient>(_ =>
    new NotionChecklistClient(
        new HttpClient(),
        string.IsNullOrWhiteSpace(settings.NotionToken) ? "UNCONFIGURED" : settings.NotionToken,
        new Uri(settings.NotionBaseUrl, UriKind.Absolute)));
builder.Services.AddSingleton<NotionWorkSource>(services =>
    new NotionWorkSource(
        services.GetRequiredService<INotionChecklistClient>(),
        settings.NotionPageId));
builder.Services.AddSingleton<IWorkSource>(services => services.GetRequiredService<NotionWorkSource>());
builder.Services.AddSingleton<IChecklistReconciler, ChecklistReconciler>();
builder.Services.AddSingleton<IWorkerStateStore>(_ => new JsonWorkerStateStore(settings.StateFile));
builder.Services.AddSingleton(new WorkerPolicy(MinimumDispatchInterval: settings.MinimumDispatchInterval));
builder.Services.AddSingleton<IWorkerLoop>(services => new WorkerLoop(
    services.GetRequiredService<IChatGPTDriver>(),
    services.GetRequiredService<IChecklistReconciler>(),
    services.GetRequiredService<IWorkerStateStore>(),
    services.GetRequiredService<WorkerPolicy>()));
builder.Services.AddSingleton<WorkerWakeQueue>();
builder.Services.AddSingleton<IWorkerWakeSink>(services => services.GetRequiredService<WorkerWakeQueue>());
builder.Services.AddSingleton<GitHubWebhookEndpoint>();
builder.Services.AddHostedService<WorkerHostedService>();

var app = builder.Build();

app.UseDefaultFiles();
app.UseStaticFiles();

app.MapGet("/health", () => Results.Ok(new
{
    status = "ok",
    configured = settings.IsConfigured,
    runtime = "vps-playwright"
}));

app.MapGet("/health/live", () => Results.Ok(new
{
    status = "alive",
    runtime = "vps-playwright"
}));

app.MapGet("/health/ready", () =>
{
    var payload = new
    {
        status = settings.IsConfigured ? "ready" : "not_ready",
        configured = settings.IsConfigured,
        runtime = "vps-playwright"
    };

    return settings.IsConfigured
        ? Results.Ok(payload)
        : Results.Json(payload, statusCode: StatusCodes.Status503ServiceUnavailable);
});

app.MapGet("/control/state", async (IWorkerLoop loop, CancellationToken cancellationToken) =>
    Results.Ok(await loop.GetState(cancellationToken)));

app.MapGet("/control/summary", async (IWorkerLoop loop, CancellationToken cancellationToken) =>
{
    var snapshot = await loop.GetState(cancellationToken);
    return Results.Ok(new
    {
        runtime = "vps-playwright",
        ready = settings.IsConfigured,
        snapshot,
        target = snapshot.Target,
        configuration = new
        {
            notionConfigured = settings.NotionConfigured,
            notionTargetSource = true,
            notionTargetHeader = NotionChecklistClient.TargetHeader,
            probeChatGptConfigured = settings.ChatGptTargetConfigured,
            chatGptSemanticTargetConfigured = settings.ChatGptSemanticTargetConfigured,
            chatGptSemanticTargetPartial = settings.ChatGptSemanticTargetPartial,
            chatGptOverridePresent = settings.ChatGptOverridePresent,
            chatGptOverrideConfigured = settings.ChatGptOverrideConfigured,
            chatGptTargetAmbiguous = settings.ChatGptTargetAmbiguous,
            chatGptUsesNewChat = settings.ChatGptUsesNewChat,
            probeChatGptTargetMode = settings.ChatGptTargetMode,
            githubWebhookConfigured = !string.IsNullOrWhiteSpace(settings.GitHubWebhookSecret),
            browserCdpConfigured = settings.BrowserCdpConfigured
        },
        browser = new
        {
            mode = settings.BrowserCdpConfigured ? "cdp-attach" : "playwright-launch",
            liveChatGptRequiresCdp = settings.LiveChatGptBaseUrl
        },
        browserProfileDirectory = settings.ChatGptProfileDirectory,
        chatGptBaseUrl = settings.ChatGptBaseUrl
    });
});

app.MapPost("/control/reconcile", async (
    IWorkerWakeSink wakeSink,
    CancellationToken cancellationToken) =>
{
    if (!settings.IsConfigured)
        return Results.Problem(
            title: "BKE Worker is not configured",
            detail: "Configure Notion, browser runtime, and GitHub webhook secret before manual reconciliation.",
            statusCode: StatusCodes.Status503ServiceUnavailable);

    await wakeSink.Enqueue(
        new WorkerWakeEvent(WorkerWakeReason.Manual, null, DateTimeOffset.UtcNow),
        cancellationToken);

    return Results.Accepted(value: new
    {
        accepted = true,
        reason = WorkerWakeReason.Manual,
        message = "Manual Notion reconciliation queued."
    });
});

// Operator-only adapter probe. These environment target fields are intentionally
// separate from the autonomous Notion-driven target used by WorkerHostedService.
app.MapPost("/control/chatgpt/probe", async (
    IWorkerLoop loop,
    ChatGPTWebDriver driver,
    CancellationToken cancellationToken) =>
{
    if (!settings.ChatGptTargetConfigured)
    {
        var detail = settings.ChatGptTargetAmbiguous
            ? "Project + Conversation and Override Link are mutually exclusive. Select exactly one explicit target mode, or neither to use New Chat."
            : settings.ChatGptOverridePresent && !settings.ChatGptOverrideConfigured
                ? "The configured ChatGPT override URL is invalid. Use an HTTPS chatgpt.com conversation URL containing /c/<conversation-id>."
                : "Project and Conversation must be configured together. Configure both, configure only an Override Link, or leave all target fields empty to use New Chat.";

        return Results.Problem(
            title: "ChatGPT probe target is invalid",
            detail: detail,
            statusCode: StatusCodes.Status503ServiceUnavailable);
    }

    var snapshot = await loop.GetState(cancellationToken);
    if (snapshot.State is WorkerRuntimeState.DISPATCHING or
        WorkerRuntimeState.RECONCILING or
        WorkerRuntimeState.CONTINUING)
    {
        return Results.Problem(
            title: "Worker browser is active",
            detail: "Adapter probing is blocked while the worker is dispatching or reconciling. Retry from a stable worker state.",
            statusCode: StatusCodes.Status409Conflict);
    }

    var result = settings.ChatGptTargetMode switch
    {
        "override-link" => await driver.ProbeOverrideLink(settings.ChatGptOverrideUrl, cancellationToken),
        "project-chat" => await driver.ProbeExactContext(
            settings.ChatGptProject,
            settings.ChatGptConversation,
            cancellationToken),
        _ => await driver.ProbeNewChat(cancellationToken)
    };

    return result.Compatible
        ? Results.Ok(result)
        : Results.Json(result, statusCode: StatusCodes.Status503ServiceUnavailable);
});

app.MapPost("/webhooks/github", (
    HttpRequest request,
    GitHubWebhookEndpoint endpoint,
    CancellationToken cancellationToken) => endpoint.Handle(request, cancellationToken));

await app.RunAsync();

public sealed record WorkerServerSettings(
    string NotionToken,
    string NotionPageId,
    string NotionBaseUrl,
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
    TimeSpan RecoveryInterval,
    TimeSpan MinimumDispatchInterval)
{
    public bool NotionConfigured =>
        !string.IsNullOrWhiteSpace(NotionToken) &&
        !string.IsNullOrWhiteSpace(NotionPageId);

    public bool ChatGptProjectPresent => !string.IsNullOrWhiteSpace(ChatGptProject);
    public bool ChatGptConversationPresent => !string.IsNullOrWhiteSpace(ChatGptConversation);

    public bool ChatGptSemanticTargetConfigured =>
        ChatGptProjectPresent && ChatGptConversationPresent;

    public bool ChatGptSemanticTargetPartial =>
        ChatGptProjectPresent != ChatGptConversationPresent;

    public bool ChatGptOverridePresent =>
        !string.IsNullOrWhiteSpace(ChatGptOverrideUrl);

    public bool ChatGptOverrideConfigured =>
        ChatGptOverridePresent && IsValidChatGptConversationOverride(ChatGptOverrideUrl);

    public bool ChatGptTargetAmbiguous =>
        ChatGptOverridePresent && (ChatGptProjectPresent || ChatGptConversationPresent);

    public bool ChatGptUsesNewChat =>
        !ChatGptOverridePresent && !ChatGptProjectPresent && !ChatGptConversationPresent;

    // Probe/send-smoke target configuration only. The autonomous loop target is read from Notion.
    public bool ChatGptTargetConfigured =>
        !ChatGptTargetAmbiguous &&
        !ChatGptSemanticTargetPartial &&
        (ChatGptOverridePresent ? ChatGptOverrideConfigured : true);

    public string ChatGptTargetMode =>
        ChatGptTargetAmbiguous ? "invalid-ambiguous" :
        ChatGptOverridePresent ? (ChatGptOverrideConfigured ? "override-link" : "invalid-override") :
        ChatGptSemanticTargetPartial ? "invalid-incomplete" :
        ChatGptSemanticTargetConfigured ? "project-chat" :
        "new-chat";

    public bool LiveChatGptBaseUrl =>
        Uri.TryCreate(ChatGptBaseUrl, UriKind.Absolute, out var uri) &&
        string.Equals(uri.Host, "chatgpt.com", StringComparison.OrdinalIgnoreCase);

    public bool BrowserCdpConfigured =>
        !string.IsNullOrWhiteSpace(BrowserCdpEndpoint) &&
        Uri.TryCreate(BrowserCdpEndpoint, UriKind.Absolute, out var uri) &&
        uri.IsLoopback;

    public bool BrowserRuntimeConfigured =>
        !LiveChatGptBaseUrl || BrowserCdpConfigured;

    public bool IsConfigured =>
        NotionConfigured &&
        BrowserRuntimeConfigured &&
        !string.IsNullOrWhiteSpace(GitHubWebhookSecret);

    public EngineeringTarget Target => new(
        ChatGptProject,
        ChatGptConversation,
        NotionPageId,
        OverrideUrl: ChatGptOverrideUrl);

    public static WorkerServerSettings FromConfiguration(IConfiguration configuration)
    {
        return new WorkerServerSettings(
            configuration["BKE_WORKER_NOTION_TOKEN"] ?? string.Empty,
            configuration["BKE_WORKER_NOTION_PAGE"] ?? string.Empty,
            configuration["BKE_WORKER_NOTION_BASE_URL"] ?? "https://api.notion.com/",
            configuration["BKE_WORKER_CHATGPT_PROJECT"] ?? string.Empty,
            configuration["BKE_WORKER_CHATGPT_CONVERSATION"] ?? string.Empty,
            configuration["BKE_WORKER_CHATGPT_OVERRIDE_URL"] ?? string.Empty,
            configuration["BKE_WORKER_CHATGPT_BASE_URL"] ?? "https://chatgpt.com/",
            configuration["BKE_WORKER_GITHUB_WEBHOOK_SECRET"] ?? string.Empty,
            configuration["BKE_WORKER_CHATGPT_PROFILE"] ?? "/var/lib/bke-worker/chatgpt-profile",
            configuration["BKE_WORKER_STATE_FILE"] ?? "/var/lib/bke-worker/state/worker.json",
            configuration["BKE_WORKER_BROWSER_CDP_ENDPOINT"] ?? string.Empty,
            ParseBool(configuration["BKE_WORKER_HEADLESS"], defaultValue: true),
            TimeSpan.FromSeconds(ParsePositiveInt(configuration["BKE_WORKER_WEBHOOK_DEBOUNCE_SECONDS"], 10)),
            TimeSpan.FromSeconds(ParsePositiveInt(configuration["BKE_WORKER_RECOVERY_SECONDS"], 300)),
            TimeSpan.FromSeconds(ParsePositiveInt(configuration["BKE_WORKER_MIN_DISPATCH_SECONDS"], 30)));
    }

    private static bool IsValidChatGptConversationOverride(string value)
    {
        if (!Uri.TryCreate(value, UriKind.Absolute, out var uri) ||
            !string.Equals(uri.Scheme, Uri.UriSchemeHttps, StringComparison.OrdinalIgnoreCase) ||
            !(string.Equals(uri.Host, "chatgpt.com", StringComparison.OrdinalIgnoreCase) ||
              string.Equals(uri.Host, "www.chatgpt.com", StringComparison.OrdinalIgnoreCase)))
        {
            return false;
        }

        var segments = uri.AbsolutePath
            .Split('/', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries);
        for (var index = 0; index < segments.Length - 1; index++)
        {
            if (string.Equals(segments[index], "c", StringComparison.OrdinalIgnoreCase) &&
                !string.IsNullOrWhiteSpace(segments[index + 1]))
            {
                return true;
            }
        }

        return false;
    }

    private static bool ParseBool(string? value, bool defaultValue) =>
        bool.TryParse(value, out var parsed) ? parsed : defaultValue;

    private static int ParsePositiveInt(string? value, int defaultValue) =>
        int.TryParse(value, out var parsed) && parsed > 0 ? parsed : defaultValue;
}

public sealed class JsonWorkerStateStore(string path) : IWorkerStateStore
{
    private static readonly JsonSerializerOptions SerializerOptions = new()
    {
        WriteIndented = true,
        Converters = { new JsonStringEnumConverter() }
    };

    private readonly SemaphoreSlim _mutex = new(1, 1);

    public async Task<WorkerSnapshot> Load(CancellationToken cancellationToken)
    {
        await _mutex.WaitAsync(cancellationToken);
        try
        {
            if (!File.Exists(path))
                return WorkerSnapshot.Empty;

            var json = await File.ReadAllTextAsync(path, cancellationToken);
            return JsonSerializer.Deserialize<WorkerSnapshot>(json, SerializerOptions) ?? WorkerSnapshot.Empty;
        }
        finally
        {
            _mutex.Release();
        }
    }

    public async Task Save(WorkerSnapshot snapshot, CancellationToken cancellationToken)
    {
        await _mutex.WaitAsync(cancellationToken);
        try
        {
            var directory = Path.GetDirectoryName(path);
            if (!string.IsNullOrWhiteSpace(directory))
                Directory.CreateDirectory(directory);

            var temp = path + ".tmp";
            var json = JsonSerializer.Serialize(snapshot, SerializerOptions);
            await File.WriteAllTextAsync(temp, json, cancellationToken);
            File.Move(temp, path, overwrite: true);
        }
        finally
        {
            _mutex.Release();
        }
    }
}

public sealed class WorkerWakeQueue : IWorkerWakeSink
{
    private readonly Channel<WorkerWakeEvent> _channel = Channel.CreateUnbounded<WorkerWakeEvent>(
        new UnboundedChannelOptions
        {
            SingleReader = true,
            SingleWriter = false,
            AllowSynchronousContinuations = false
        });

    public ChannelReader<WorkerWakeEvent> Reader => _channel.Reader;

    public ValueTask Enqueue(WorkerWakeEvent wakeEvent, CancellationToken cancellationToken) =>
        _channel.Writer.WriteAsync(wakeEvent, cancellationToken);
}

public sealed class WorkerHostedService(
    IWorkerLoop loop,
    NotionWorkSource workSource,
    IChatGPTDriver driver,
    IWorkerStateStore stateStore,
    WorkerWakeQueue wakeQueue,
    WorkerServerSettings settings,
    ILogger<WorkerHostedService> logger) : BackgroundService
{
    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        if (!settings.IsConfigured)
        {
            logger.LogWarning("BKE Worker is running unconfigured; set Notion page/token, loopback browser CDP for live chatgpt.com, and GitHub webhook environment variables.");
            await Task.Delay(Timeout.InfiniteTimeSpan, stoppingToken);
            return;
        }

        var start = await StartFromNotion(stoppingToken);
        logger.LogInformation("Worker startup result: {State} {Message}", start.State, start.Message);

        await Task.WhenAll(
            ConsumeWakeEvents(stoppingToken),
            RunRecoveryTimer(stoppingToken));
    }

    private async Task<WorkerLoopResult> StartFromNotion(CancellationToken cancellationToken)
    {
        var existing = await stateStore.Load(cancellationToken);

        // Preserve crash-safety and active-loop semantics without rereading Notion on restart.
        if (existing.Target is not null && IsActive(existing.State))
            return await loop.Start(existing.Target, cancellationToken);

        // GUARD: human authentication is checked before the first Notion task/target read.
        try
        {
            await driver.Launch(cancellationToken);
        }
        catch (OperationCanceledException) when (cancellationToken.IsCancellationRequested)
        {
            throw;
        }
        catch (Exception ex)
        {
            return await PersistStartupFailure(existing, ex, cancellationToken);
        }

        EngineeringTarget? target;
        try
        {
            target = await workSource.GetNextEngineeringTarget(cancellationToken);
        }
        catch (OperationCanceledException) when (cancellationToken.IsCancellationRequested)
        {
            throw;
        }
        catch (Exception ex)
        {
            return await PersistStartupFailure(existing, ex, cancellationToken);
        }

        if (target is null)
        {
            var complete = existing with
            {
                State = WorkerRuntimeState.COMPLETE,
                Target = null,
                CurrentChecklistIdentifier = null,
                LastReconciliationAt = DateTimeOffset.UtcNow,
                Failure = null
            };
            await stateStore.Save(complete, cancellationToken);
            return new(complete.State, false, false, "NO_UNCHECKED_NOTION_TASK");
        }

        return await loop.Start(target, cancellationToken);
    }

    private async Task ConsumeWakeEvents(CancellationToken cancellationToken)
    {
        await foreach (var wakeEvent in wakeQueue.Reader.ReadAllAsync(cancellationToken))
        {
            if (wakeEvent.Reason == WorkerWakeReason.GitHubPush)
                await Task.Delay(settings.WebhookDebounce, cancellationToken);

            var state = await loop.GetState(cancellationToken);
            var result = wakeEvent.Reason == WorkerWakeReason.Manual && !IsActive(state.State)
                ? await StartFromNotion(cancellationToken)
                : await loop.Wake(wakeEvent.Reason, wakeEvent.DeliveryId, cancellationToken);

            logger.LogInformation(
                "Worker wake {Reason}: {State} {Message} promptSent={PromptSent}",
                wakeEvent.Reason,
                result.State,
                result.Message,
                result.PromptSent);
        }
    }

    private async Task RunRecoveryTimer(CancellationToken cancellationToken)
    {
        using var timer = new PeriodicTimer(settings.RecoveryInterval);
        while (await timer.WaitForNextTickAsync(cancellationToken))
        {
            var state = await loop.GetState(cancellationToken);
            if (!IsActive(state.State))
                continue;

            var result = await loop.Wake(WorkerWakeReason.RecoveryTimer, null, cancellationToken);
            logger.LogInformation(
                "Recovery reconciliation: {State} {Message} promptSent={PromptSent}",
                result.State,
                result.Message,
                result.PromptSent);
        }
    }

    private async Task<WorkerLoopResult> PersistStartupFailure(
        WorkerSnapshot existing,
        Exception exception,
        CancellationToken cancellationToken)
    {
        var failure = exception.Message;
        var blocked = failure.Contains("CHATGPT_AUTH_REQUIRED", StringComparison.Ordinal) ||
                      failure.Contains("CHATGPT_TARGET_AMBIGUOUS", StringComparison.Ordinal) ||
                      failure.Contains("CHATGPT_TARGET_INCOMPLETE", StringComparison.Ordinal) ||
                      failure.Contains("CHATGPT_OVERRIDE_URL_INVALID", StringComparison.Ordinal) ||
                      failure.Contains("NOTION_TARGET_BLOCK_AMBIGUOUS", StringComparison.Ordinal) ||
                      failure.Contains("NOTION_TARGET_BLOCK_INVALID", StringComparison.Ordinal) ||
                      failure.Contains("LIVE_CHATGPT_REQUIRES_CDP_ATTACH", StringComparison.Ordinal) ||
                      failure.Contains("BROWSER_CDP_ENDPOINT_MUST_BE_LOOPBACK", StringComparison.Ordinal);

        var failed = existing with
        {
            State = blocked ? WorkerRuntimeState.BLOCKED : WorkerRuntimeState.FAILED,
            Target = null,
            CurrentChecklistIdentifier = null,
            Failure = failure
        };
        await stateStore.Save(failed, cancellationToken);
        return new(failed.State, false, false, failure);
    }

    private static bool IsActive(WorkerRuntimeState state) => state is
        WorkerRuntimeState.DISPATCHING or
        WorkerRuntimeState.WAITING_FOR_ENGINEERING_EVENT or
        WorkerRuntimeState.RECONCILING or
        WorkerRuntimeState.CONTINUING;
}
