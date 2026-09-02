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
    settings.ChatGptBaseUrl));
builder.Services.AddSingleton<ChromiumHost>();
builder.Services.AddSingleton<IChatGPTDriver, ChatGPTWebDriver>();
builder.Services.AddSingleton<INotionChecklistClient>(_ =>
    new NotionChecklistClient(
        new HttpClient(),
        string.IsNullOrWhiteSpace(settings.NotionToken) ? "UNCONFIGURED" : settings.NotionToken,
        new Uri(settings.NotionBaseUrl, UriKind.Absolute)));
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
        target = settings.IsConfigured ? settings.Target : null,
        configuration = new
        {
            notionConfigured = !string.IsNullOrWhiteSpace(settings.NotionToken) && !string.IsNullOrWhiteSpace(settings.NotionPageId),
            chatGptConfigured = !string.IsNullOrWhiteSpace(settings.ChatGptProject) && !string.IsNullOrWhiteSpace(settings.ChatGptConversation),
            githubWebhookConfigured = !string.IsNullOrWhiteSpace(settings.GitHubWebhookSecret)
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
            detail: "Configure Notion, ChatGPT target, and GitHub webhook secret before manual reconciliation.",
            statusCode: StatusCodes.Status503ServiceUnavailable);

    await wakeSink.Enqueue(
        new WorkerWakeEvent(WorkerWakeReason.Manual, null, DateTimeOffset.UtcNow),
        cancellationToken);

    return Results.Accepted(value: new
    {
        accepted = true,
        reason = WorkerWakeReason.Manual,
        message = "Manual reconciliation queued."
    });
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
    string ChatGptBaseUrl,
    string GitHubWebhookSecret,
    string ChatGptProfileDirectory,
    string StateFile,
    bool Headless,
    TimeSpan WebhookDebounce,
    TimeSpan RecoveryInterval,
    TimeSpan MinimumDispatchInterval)
{
    public bool IsConfigured =>
        !string.IsNullOrWhiteSpace(NotionToken) &&
        !string.IsNullOrWhiteSpace(NotionPageId) &&
        !string.IsNullOrWhiteSpace(ChatGptProject) &&
        !string.IsNullOrWhiteSpace(ChatGptConversation) &&
        !string.IsNullOrWhiteSpace(GitHubWebhookSecret);

    public EngineeringTarget Target => new(
        ChatGptProject,
        ChatGptConversation,
        NotionPageId);

    public static WorkerServerSettings FromConfiguration(IConfiguration configuration)
    {
        return new WorkerServerSettings(
            configuration["BKE_WORKER_NOTION_TOKEN"] ?? string.Empty,
            configuration["BKE_WORKER_NOTION_PAGE"] ?? string.Empty,
            configuration["BKE_WORKER_NOTION_BASE_URL"] ?? "https://api.notion.com/",
            configuration["BKE_WORKER_CHATGPT_PROJECT"] ?? string.Empty,
            configuration["BKE_WORKER_CHATGPT_CONVERSATION"] ?? string.Empty,
            configuration["BKE_WORKER_CHATGPT_BASE_URL"] ?? "https://chatgpt.com/",
            configuration["BKE_WORKER_GITHUB_WEBHOOK_SECRET"] ?? string.Empty,
            configuration["BKE_WORKER_CHATGPT_PROFILE"] ?? "/var/lib/bke-worker/chatgpt-profile",
            configuration["BKE_WORKER_STATE_FILE"] ?? "/var/lib/bke-worker/state/worker.json",
            ParseBool(configuration["BKE_WORKER_HEADLESS"], defaultValue: true),
            TimeSpan.FromSeconds(ParsePositiveInt(configuration["BKE_WORKER_WEBHOOK_DEBOUNCE_SECONDS"], 10)),
            TimeSpan.FromSeconds(ParsePositiveInt(configuration["BKE_WORKER_RECOVERY_SECONDS"], 300)),
            TimeSpan.FromSeconds(ParsePositiveInt(configuration["BKE_WORKER_MIN_DISPATCH_SECONDS"], 30)));
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
    WorkerWakeQueue wakeQueue,
    WorkerServerSettings settings,
    ILogger<WorkerHostedService> logger) : BackgroundService
{
    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        if (!settings.IsConfigured)
        {
            logger.LogWarning("BKE Worker is running unconfigured; set Notion, ChatGPT target, and GitHub webhook environment variables.");
            await Task.Delay(Timeout.InfiniteTimeSpan, stoppingToken);
            return;
        }

        var start = await loop.Start(settings.Target, stoppingToken);
        logger.LogInformation("Worker startup result: {State} {Message}", start.State, start.Message);

        await Task.WhenAll(
            ConsumeWakeEvents(stoppingToken),
            RunRecoveryTimer(stoppingToken));
    }

    private async Task ConsumeWakeEvents(CancellationToken cancellationToken)
    {
        await foreach (var wakeEvent in wakeQueue.Reader.ReadAllAsync(cancellationToken))
        {
            if (wakeEvent.Reason == WorkerWakeReason.GitHubPush)
                await Task.Delay(settings.WebhookDebounce, cancellationToken);

            var result = await loop.Wake(wakeEvent.Reason, wakeEvent.DeliveryId, cancellationToken);
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

    private static bool IsActive(WorkerRuntimeState state) => state is
        WorkerRuntimeState.DISPATCHING or
        WorkerRuntimeState.WAITING_FOR_ENGINEERING_EVENT or
        WorkerRuntimeState.RECONCILING or
        WorkerRuntimeState.CONTINUING;
}
