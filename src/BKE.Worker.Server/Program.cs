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

builder.Services.ConfigureHttpJsonOptions(options =>
    options.SerializerOptions.Converters.Add(new JsonStringEnumConverter()));
builder.Services.AddSingleton(settings);
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
builder.Services.AddSingleton<IWorkerStateStore>(_ => new JsonWorkerStateStore(settings.StateFile));
builder.Services.AddSingleton<NotionCheckboxWatchdog>();
builder.Services.AddHostedService<NotionCheckboxWatchdogHostedService>();

var app = builder.Build();

app.UseDefaultFiles();
app.UseStaticFiles();

app.MapGet("/health", () => Results.Ok(new
{
    status = "ok",
    configured = settings.IsConfigured,
    runtime = "notion-checkbox-watchdog"
}));

app.MapGet("/health/live", () => Results.Ok(new
{
    status = "alive",
    runtime = "notion-checkbox-watchdog"
}));

app.MapGet("/health/ready", () =>
{
    var payload = new
    {
        status = settings.IsConfigured ? "ready" : "not_ready",
        configured = settings.IsConfigured,
        runtime = "notion-checkbox-watchdog"
    };

    return settings.IsConfigured
        ? Results.Ok(payload)
        : Results.Json(payload, statusCode: StatusCodes.Status503ServiceUnavailable);
});

app.MapGet("/control/projects", async (
    NotionCheckboxWatchdog watchdog,
    CancellationToken cancellationToken) =>
{
    if (!settings.IsConfigured)
        return Results.Problem(
            title: "BKE Worker is not configured",
            detail: "Configure the Notion token, deterministic ChatGPT conversation URL, and loopback Chromium CDP.",
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
    if (!settings.IsConfigured)
        return Results.Problem(
            title: "BKE Worker is not configured",
            detail: "Configure the Notion token, deterministic ChatGPT conversation URL, and loopback Chromium CDP.",
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
    try
    {
        currentTask = await watchdog.GetCurrentTask(cancellationToken);
    }
    catch
    {
        // Summary must remain readable while a Notion failure is surfaced in runtime state/logs.
    }

    return Results.Ok(new
    {
        runtime = "notion-checkbox-watchdog",
        ready = settings.IsConfigured,
        snapshot,
        currentTask,
        configuration = new
        {
            notionConfigured = settings.NotionConfigured,
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
            title: "BKE Worker is not configured",
            detail: "Notion token, deterministic ChatGPT override URL, and loopback CDP are required.",
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

public sealed record WorkerServerSettings(
    string NotionToken,
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
    public bool NotionConfigured =>
        !string.IsNullOrWhiteSpace(NotionToken);

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
        NotionConfigured &&
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
            configuration["BKE_WORKER_NOTION_TOKEN"] ?? string.Empty,
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
