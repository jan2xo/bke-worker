using System.Text.Json.Serialization;
using BKE.Worker.ChatGPT.Playwright;
using BKE.Worker.Core;
using BKE.Worker.Notion;

var builder = WebApplication.CreateBuilder(new WebApplicationOptions
{
    Args = args,
    WebRootPath = Path.Combine(AppContext.BaseDirectory, "wwwroot")
});
var settings = WorkerServerSettings.FromConfiguration(builder.Configuration);
var notionConnection = new NotionRuntimeConnection(settings.NotionBaseUrl);

builder.Services.ConfigureHttpJsonOptions(options =>
    options.SerializerOptions.Converters.Add(new JsonStringEnumConverter()));
builder.Services.AddSingleton(settings);
builder.Services.AddSingleton(notionConnection);
builder.Services.AddSingleton<INotionChecklistClient>(notionConnection);
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
builder.Services.AddSingleton<IWorkerStateStore>(_ => new JsonWorkerStateStore(settings.StateFile));
builder.Services.AddSingleton<NotionCheckboxWatchdog>();
builder.Services.AddHostedService<NotionCheckboxWatchdogHostedService>();

var app = builder.Build();

app.UseDefaultFiles();
app.UseStaticFiles();

bool IsReady() => settings.IsConfigured && notionConnection.IsConnected;

app.MapGet("/health", () => Results.Ok(new
{
    status = "ok",
    configured = settings.IsConfigured,
    notionConnected = notionConnection.IsConnected,
    runtime = "notion-checkbox-watchdog"
}));

app.MapGet("/health/live", () => Results.Ok(new
{
    status = "alive",
    runtime = "notion-checkbox-watchdog"
}));

app.MapGet("/health/ready", () =>
{
    var ready = IsReady();
    var payload = new
    {
        status = ready ? "ready" : "not_ready",
        configured = settings.IsConfigured,
        notionConnected = notionConnection.IsConnected,
        runtime = "notion-checkbox-watchdog"
    };

    return ready
        ? Results.Ok(payload)
        : Results.Json(payload, statusCode: StatusCodes.Status503ServiceUnavailable);
});

app.MapPost("/control/notion/connect", async (
    NotionConnectRequest request,
    NotionCheckboxWatchdog watchdog,
    CancellationToken cancellationToken) =>
{
    var snapshot = await watchdog.GetState(cancellationToken);
    if (IsActive(snapshot.State))
        return Results.Problem(
            title: "Cannot replace Notion connection while watchdog is active",
            detail: "Stop the watchdog before changing the in-memory Notion secret.",
            statusCode: StatusCodes.Status409Conflict);

    try
    {
        await notionConnection.Connect(request.Secret, cancellationToken);
        return Results.Ok(new { connected = true });
    }
    catch (Exception ex) when (ex is not OperationCanceledException)
    {
        return Results.Problem(
            title: "Notion connection failed",
            detail: ex.Message,
            statusCode: StatusCodes.Status401Unauthorized);
    }
});

app.MapPost("/control/notion/disconnect", async (
    NotionCheckboxWatchdog watchdog,
    CancellationToken cancellationToken) =>
{
    var snapshot = await watchdog.GetState(cancellationToken);
    if (IsActive(snapshot.State))
        return Results.Problem(
            title: "Cannot disconnect Notion while watchdog is active",
            detail: "Stop the watchdog first.",
            statusCode: StatusCodes.Status409Conflict);

    notionConnection.Disconnect();
    return Results.Ok(new { connected = false });
});

app.MapGet("/control/projects", async (
    NotionCheckboxWatchdog watchdog,
    CancellationToken cancellationToken) =>
{
    if (!notionConnection.IsConnected)
        return Results.Problem(
            title: "Notion is not connected",
            detail: "Enter a Notion integration secret in the operator UI.",
            statusCode: StatusCodes.Status503ServiceUnavailable);

    try
    {
        return Results.Ok(await watchdog.GetProjects(cancellationToken));
    }
    catch (Exception ex) when (ex is not OperationCanceledException)
    {
        return Results.Problem(
            title: "Unable to discover ENGINEERING Notion pages",
            detail: ex.Message,
            statusCode: StatusCodes.Status503ServiceUnavailable);
    }
});

app.MapGet("/control/options", async (
    string? pageId,
    NotionCheckboxWatchdog watchdog,
    CancellationToken cancellationToken) =>
{
    if (!notionConnection.IsConnected)
        return Results.Problem(
            title: "Notion is not connected",
            detail: "Enter a Notion integration secret in the operator UI.",
            statusCode: StatusCodes.Status503ServiceUnavailable);

    if (string.IsNullOrWhiteSpace(pageId))
        return Results.Problem(
            title: "Engineering page is required",
            detail: "Select one discovered ENGINEERING: Notion page before loading tasks and instructions.",
            statusCode: StatusCodes.Status400BadRequest);

    try
    {
        return Results.Ok(await watchdog.GetOptions(pageId, cancellationToken));
    }
    catch (Exception ex) when (ex is not OperationCanceledException)
    {
        return Results.Problem(
            title: "Unable to read selected ENGINEERING Notion page",
            detail: ex.Message,
            statusCode: StatusCodes.Status503ServiceUnavailable);
    }
});

app.MapGet("/control/summary", async (
    NotionCheckboxWatchdog watchdog,
    CancellationToken cancellationToken) =>
{
    var snapshot = await watchdog.GetState(cancellationToken);
    NotionChecklistTask? currentTask = null;
    if (notionConnection.IsConnected)
    {
        try
        {
            currentTask = await watchdog.GetCurrentTask(cancellationToken);
        }
        catch
        {
            // Summary must remain readable while a Notion failure is surfaced in runtime state/logs.
        }
    }

    return Results.Ok(new
    {
        runtime = "notion-checkbox-watchdog",
        ready = IsReady(),
        snapshot,
        currentTask,
        configuration = new
        {
            notionConnected = notionConnection.IsConnected,
            notionSecretSource = "operator-ui-memory-only",
            notionProjectDiscovery = $"title-prefix:{NotionCheckboxWatchdog.EngineeringPagePrefix}",
            namesDiscoverIdsExecute = true,
            workerTargetSource = "configuration",
            autonomousOverrideConfigured = settings.AutonomousOverrideConfigured,
            githubWakeAuthority = false,
            browserCdpConfigured = settings.BrowserCdpConfigured,
            watchdogSeconds = settings.WatchdogInterval.TotalSeconds,
            idleRetrySeconds = settings.IdleRetryInterval.TotalSeconds
        },
        activeNotionPageId = snapshot.Target?.NotionPageId,
        browserProfileDirectory = settings.ChatGptProfileDirectory,
        chatGptOverrideUrl = settings.ChatGptOverrideUrl,
        chatGptBaseUrl = settings.ChatGptBaseUrl
    });
});

app.MapPost("/control/start", async (
    WatchdogStartRequest request,
    NotionCheckboxWatchdog watchdog,
    CancellationToken cancellationToken) =>
{
    if (!settings.IsConfigured)
        return Results.Problem(
            title: "BKE Worker host is not configured",
            detail: "Deterministic ChatGPT override URL and loopback CDP are required.",
            statusCode: StatusCodes.Status503ServiceUnavailable);

    if (!notionConnection.IsConnected)
        return Results.Problem(
            title: "Notion is not connected",
            detail: "Connect a Notion integration secret in the operator UI before starting.",
            statusCode: StatusCodes.Status503ServiceUnavailable);

    try
    {
        return Results.Ok(await watchdog.Start(request, cancellationToken));
    }
    catch (Exception ex) when (ex is not OperationCanceledException)
    {
        return Results.Problem(
            title: "Unable to start watchdog",
            detail: ex.Message,
            statusCode: StatusCodes.Status409Conflict);
    }
});

app.MapPost("/control/stop", async (
    NotionCheckboxWatchdog watchdog,
    CancellationToken cancellationToken) =>
    Results.Ok(await watchdog.Stop(cancellationToken)));

app.MapPost("/control/check-now", async (
    NotionCheckboxWatchdog watchdog,
    CancellationToken cancellationToken) =>
    Results.Ok(await watchdog.Tick(cancellationToken)));

app.MapPost("/control/chatgpt/probe", async (
    ChatGPTWebDriver driver,
    CancellationToken cancellationToken) =>
{
    if (!settings.AutonomousOverrideConfigured)
        return Results.Problem(
            title: "ChatGPT target is invalid",
            detail: "Configure one HTTPS chatgpt.com conversation URL containing /c/<conversation-id>.",
            statusCode: StatusCodes.Status503ServiceUnavailable);

    var result = await driver.ProbeOverrideLink(settings.ChatGptOverrideUrl, cancellationToken);
    return result.Compatible
        ? Results.Ok(result)
        : Results.Json(result, statusCode: StatusCodes.Status503ServiceUnavailable);
});

await app.RunAsync();

static bool IsActive(WorkerRuntimeState state) => state is
    WorkerRuntimeState.WAITING_FOR_ENGINEERING_EVENT or
    WorkerRuntimeState.DISPATCHING or
    WorkerRuntimeState.CONTINUING;

public sealed record WorkerServerSettings(
    string NotionBaseUrl,
    string ChatGptOverrideUrl,
    string ChatGptBaseUrl,
    string ChatGptProfileDirectory,
    string StateFile,
    string BrowserCdpEndpoint,
    bool Headless,
    TimeSpan WatchdogInterval,
    TimeSpan IdleRetryInterval)
{
    public bool AutonomousOverrideConfigured =>
        IsValidChatGptConversationOverride(ChatGptOverrideUrl);

    public bool LiveChatGptBaseUrl =>
        Uri.TryCreate(ChatGptBaseUrl, UriKind.Absolute, out var uri) &&
        string.Equals(uri.Host, "chatgpt.com", StringComparison.OrdinalIgnoreCase);

    public bool BrowserCdpConfigured =>
        !string.IsNullOrWhiteSpace(BrowserCdpEndpoint) &&
        Uri.TryCreate(BrowserCdpEndpoint, UriKind.Absolute, out var uri) &&
        uri.IsLoopback;

    public bool IsConfigured =>
        AutonomousOverrideConfigured &&
        (!LiveChatGptBaseUrl || BrowserCdpConfigured);

    // The Notion page is selected at runtime. This target exists only to resolve
    // the fixed ChatGPT conversation before an engineering page has been selected.
    public EngineeringTarget Target => new(
        string.Empty,
        string.Empty,
        string.Empty,
        Instruction: string.Empty,
        Surface: ChatGptExecutionSurface.Chat,
        OverrideUrl: ChatGptOverrideUrl);

    public static WorkerServerSettings FromConfiguration(IConfiguration configuration)
    {
        return new WorkerServerSettings(
            configuration["BKE_WORKER_NOTION_BASE_URL"] ?? "https://api.notion.com/",
            configuration["BKE_WORKER_CHATGPT_OVERRIDE_URL"] ?? string.Empty,
            configuration["BKE_WORKER_CHATGPT_BASE_URL"] ?? "https://chatgpt.com/",
            configuration["BKE_WORKER_CHATGPT_PROFILE"] ?? "/var/lib/bke-worker/chatgpt-profile",
            configuration["BKE_WORKER_STATE_FILE"] ?? "/var/lib/bke-worker/state/notion-watchdog.json",
            configuration["BKE_WORKER_BROWSER_CDP_ENDPOINT"] ?? string.Empty,
            ParseBool(configuration["BKE_WORKER_HEADLESS"], defaultValue: true),
            TimeSpan.FromSeconds(ParsePositiveInt(configuration["BKE_WORKER_WATCHDOG_SECONDS"], 2)),
            TimeSpan.FromSeconds(ParsePositiveInt(configuration["BKE_WORKER_IDLE_RETRY_SECONDS"], 5)));
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
