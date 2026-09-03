using BKE.Worker.ChatGPT.Playwright;
using BKE.Worker.Core;
using BKE.Worker.Notion;

var notionToken = Environment.GetEnvironmentVariable("BKE_WORKER_NOTION_TOKEN") ?? string.Empty;
var notionPage = Environment.GetEnvironmentVariable("BKE_WORKER_NOTION_PAGE") ?? string.Empty;
var notionBaseUrl = Environment.GetEnvironmentVariable("BKE_WORKER_NOTION_BASE_URL") ?? "https://api.notion.com/";
var chatGptBaseUrl = Environment.GetEnvironmentVariable("BKE_WORKER_CHATGPT_BASE_URL") ?? "https://chatgpt.com/";
var cdpEndpoint = Environment.GetEnvironmentVariable("BKE_WORKER_BROWSER_CDP_ENDPOINT") ?? "http://127.0.0.1:9222";
var profile = Environment.GetEnvironmentVariable("BKE_WORKER_CHATGPT_PROFILE")
    ?? Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.UserProfile), "snap/chromium/common/bke-worker-chatgpt-profile");

if (string.IsNullOrWhiteSpace(notionToken) || notionToken == "REPLACE_ME")
{
    Console.Error.WriteLine("ERROR: BKE_WORKER_NOTION_TOKEN is required.");
    return 2;
}

if (string.IsNullOrWhiteSpace(notionPage) || notionPage == "REPLACE_ME")
{
    Console.Error.WriteLine("ERROR: BKE_WORKER_NOTION_PAGE is required.");
    return 2;
}

using var http = new HttpClient();
var notion = new NotionChecklistClient(
    http,
    notionToken,
    new Uri(notionBaseUrl, UriKind.Absolute));
var workSource = new NotionWorkSource(notion, notionPage);
var reconciler = new ChecklistReconciler(notion);

await using var host = new ChromiumHost(new ChromiumHostOptions(
    profile,
    Headless: false,
    ChatGptBaseUrl: chatGptBaseUrl,
    CdpEndpoint: cdpEndpoint));
var driver = new ChatGPTWebDriver(
    host,
    new ProjectNavigator(),
    new ConversationNavigator(),
    new ComposerDriver());

try
{
    // Permanent guard: authentication must be known-good before the first Notion read.
    await driver.Launch(CancellationToken.None);

    var target = await workSource.GetNextEngineeringTarget(CancellationToken.None);
    if (target is null)
    {
        Console.Error.WriteLine("ERROR: NO_UNCHECKED_NOTION_TASK");
        return 3;
    }

    var context = target.ResolveContextTarget();
    Console.WriteLine("NOTION TARGET RESOLVED");
    Console.WriteLine($"  notionPage: {target.NotionPageId}");
    Console.WriteLine($"  targetType: {context.Type}");
    if (context.Type == ContextTargetType.ProjectChat)
    {
        Console.WriteLine($"  project: {context.Project}");
        Console.WriteLine($"  conversation: {context.Conversation}");
    }
    else if (context.Type == ContextTargetType.OverrideLink)
    {
        Console.WriteLine($"  override: {context.OverrideUrl}");
    }

    var store = new MemoryStateStore();
    var loop = new WorkerLoop(
        driver,
        reconciler,
        store,
        new WorkerPolicy(MinimumDispatchInterval: TimeSpan.Zero));

    var result = await loop.Start(target, CancellationToken.None);
    if (!result.PromptSent || result.State != WorkerRuntimeState.WAITING_FOR_ENGINEERING_EVENT)
    {
        Console.Error.WriteLine($"ERROR: NOTION_DISPATCH_NOT_CERTIFIED state={result.State} message={result.Message}");
        return 4;
    }

    var page = await host.GetPage(CancellationToken.None);
    Console.WriteLine("PHASE 6B NOTION DISPATCH SMOKE GREEN");
    Console.WriteLine($"  state: {result.State}");
    Console.WriteLine($"  promptSent: {result.PromptSent}");
    Console.WriteLine($"  url: {page.Url}");
    Console.WriteLine("  guard: no GitHub webhook; no Notion checkbox mutation; process exits after one dispatch");
    return 0;
}
catch (OperationCanceledException)
{
    throw;
}
catch (Exception ex)
{
    Console.Error.WriteLine($"ERROR: {ex.Message}");
    return 1;
}

sealed class MemoryStateStore : IWorkerStateStore
{
    private WorkerSnapshot _snapshot = WorkerSnapshot.Empty;

    public Task<WorkerSnapshot> Load(CancellationToken cancellationToken) =>
        Task.FromResult(_snapshot);

    public Task Save(WorkerSnapshot snapshot, CancellationToken cancellationToken)
    {
        _snapshot = snapshot;
        return Task.CompletedTask;
    }
}
