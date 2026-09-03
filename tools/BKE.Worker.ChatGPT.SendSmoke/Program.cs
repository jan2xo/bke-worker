using BKE.Worker.ChatGPT.Playwright;
using BKE.Worker.Core;

if (args.Length != 1 || string.IsNullOrWhiteSpace(args[0]))
{
    Console.Error.WriteLine("USAGE: dotnet run --project tools/BKE.Worker.ChatGPT.SendSmoke -- \"message\"");
    return 2;
}

var message = args[0];
if (message.Length > 5000)
{
    Console.Error.WriteLine("ERROR: send-smoke message must be 5000 characters or fewer.");
    return 2;
}

var project = Environment.GetEnvironmentVariable("BKE_WORKER_CHATGPT_PROJECT") ?? string.Empty;
var conversation = Environment.GetEnvironmentVariable("BKE_WORKER_CHATGPT_CONVERSATION") ?? string.Empty;
var overrideUrl = Environment.GetEnvironmentVariable("BKE_WORKER_CHATGPT_OVERRIDE_URL") ?? string.Empty;
var baseUrl = Environment.GetEnvironmentVariable("BKE_WORKER_CHATGPT_BASE_URL") ?? "https://chatgpt.com/";
var cdpEndpoint = Environment.GetEnvironmentVariable("BKE_WORKER_BROWSER_CDP_ENDPOINT") ?? "http://127.0.0.1:9222";
var profile = Environment.GetEnvironmentVariable("BKE_WORKER_CHATGPT_PROFILE")
    ?? Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.UserProfile), "snap/chromium/common/bke-worker-chatgpt-profile");

var hasProject = !string.IsNullOrWhiteSpace(project);
var hasConversation = !string.IsNullOrWhiteSpace(conversation);
var hasOverride = !string.IsNullOrWhiteSpace(overrideUrl);

if (hasOverride && (hasProject || hasConversation))
{
    Console.Error.WriteLine("ERROR: CHATGPT_TARGET_AMBIGUOUS");
    return 2;
}

if (hasProject != hasConversation)
{
    Console.Error.WriteLine("ERROR: CHATGPT_TARGET_INCOMPLETE");
    return 2;
}

var target = hasOverride
    ? ContextTarget.OverrideLink(overrideUrl)
    : hasProject
        ? ContextTarget.ProjectChat(project, conversation)
        : ContextTarget.NewChat();

await using var host = new ChromiumHost(new ChromiumHostOptions(
    profile,
    Headless: false,
    ChatGptBaseUrl: baseUrl,
    CdpEndpoint: cdpEndpoint));

var composer = new ComposerDriver();
var driver = new ChatGPTWebDriver(
    host,
    new ProjectNavigator(),
    new ConversationNavigator(),
    composer);

try
{
    await driver.Launch(CancellationToken.None);
    await driver.OpenContext(target, CancellationToken.None);

    var page = await host.GetPage(CancellationToken.None);
    Console.WriteLine("waiting: stable composer readiness");
    if (!await composer.WaitUntilCanSendNextTurn(
            page,
            CancellationToken.None,
            TimeSpan.FromSeconds(15)))
    {
        var state = await composer.Probe(page, CancellationToken.None);
        Console.Error.WriteLine(state.TurnBusy
            ? "ERROR: CHATGPT_TURN_NOT_IDLE"
            : "ERROR: CHATGPT_COMPOSER_NOT_AVAILABLE");
        return 3;
    }

    await driver.Send(message, CancellationToken.None);
    page = await host.GetPage(CancellationToken.None);

    Console.WriteLine("LIVE CHATGPT SEND SMOKE DISPATCHED");
    Console.WriteLine($"target: {target.Type}");
    Console.WriteLine($"url: {page.Url}");
    return 0;
}
catch (Exception ex)
{
    Console.Error.WriteLine($"ERROR: {ex.Message}");
    return 1;
}
