using BKE.Worker.ChatGPT.Playwright;
using BKE.Worker.Core;

// NON-SENDING acknowledgment probe. Opens the owner's already-signed-in dedicated chat over
// loopback CDP and reports, as counts and booleans only, how the send-confirmation predicates
// see an instruction that was ALREADY delivered. It never fills, clicks, presses keys or sends.
// The instruction arrives on stdin and is never printed.
if (args.Length != 0)
{
    Console.Error.WriteLine("USAGE: <instruction on stdin> | dotnet run --project tools/BKE.Worker.ChatGPT.AckProbe");
    return 2;
}

var instruction = await Console.In.ReadToEndAsync();
if (string.IsNullOrWhiteSpace(instruction) || instruction.Length > 5000)
{
    Console.Error.WriteLine("ERROR: ACK_PROBE_INSTRUCTION_INVALID");
    return 2;
}

var overrideUrl = Environment.GetEnvironmentVariable("BKE_WORKER_CHATGPT_OVERRIDE_URL") ?? string.Empty;
var baseUrl = Environment.GetEnvironmentVariable("BKE_WORKER_CHATGPT_BASE_URL") ?? "https://chatgpt.com/";
var cdpEndpoint = Environment.GetEnvironmentVariable("BKE_WORKER_BROWSER_CDP_ENDPOINT") ?? "http://127.0.0.1:9222";
var profile = Environment.GetEnvironmentVariable("BKE_WORKER_CHATGPT_PROFILE") ?? string.Empty;
if (string.IsNullOrWhiteSpace(overrideUrl) || string.IsNullOrWhiteSpace(profile))
{
    Console.Error.WriteLine("ERROR: ACK_PROBE_TARGET_OR_PROFILE_MISSING");
    return 2;
}

await using var host = new ChromiumHost(new ChromiumHostOptions(
    profile,
    Headless: false,
    ChatGptBaseUrl: baseUrl,
    CdpEndpoint: cdpEndpoint));
var composer = new ComposerDriver();
var driver = new ChatGPTWebDriver(host, new ProjectNavigator(), new ConversationNavigator(), composer);

try
{
    await driver.Launch(CancellationToken.None);
    await driver.OpenContext(ContextTarget.OverrideLink(overrideUrl), CancellationToken.None);
    var page = await host.GetPage(CancellationToken.None);

    // Confirm the actual DOM page has the exact requested conversation route.
    // Do not output the target URL, profile path, transcript, or instruction.
    var expectedUri = new Uri(overrideUrl, UriKind.Absolute);
    var actualUri = new Uri(page.Url, UriKind.Absolute);
    var routeMatches = string.Equals(expectedUri.Scheme, actualUri.Scheme,
                           StringComparison.OrdinalIgnoreCase)
        && string.Equals(expectedUri.Host, actualUri.Host,
                         StringComparison.OrdinalIgnoreCase)
        && string.Equals(expectedUri.AbsolutePath.TrimEnd('/'),
                         actualUri.AbsolutePath.TrimEnd('/'), StringComparison.Ordinal);
    var chatTabs = page.Context.Pages.Count(tab =>
        !tab.IsClosed && Uri.TryCreate(tab.Url, UriKind.Absolute, out var tabUri)
        && string.Equals(tabUri.Host, "chatgpt.com", StringComparison.OrdinalIgnoreCase));

    Console.WriteLine(
        "ACK_PROBE_TARGET route_matches=" + (routeMatches ? "1" : "0") +
        " chatgpt_tabs=" + chatTabs);
    if (!routeMatches || chatTabs != 1)
    {
        Console.Error.WriteLine("BLOCKED:ACK_PROBE_TARGET_NOT_UNIQUE_OR_MISMATCHED");
        Console.WriteLine("ACK_PROBE_COMPLETE:NOTHING_SENT");
        return 2;
    }

    // A sendable composer may hydrate before the transcript. Observe passively
    // for up to 20 seconds; no composer action, wake, or journal mutation occurs.
    // These probes contain only counts, booleans, and status codes.
    DeliveredTurnProbe? probe = null;
    for (var attempt = 0; attempt < 20; attempt++)
    {
        probe = await ComposerDriver.InspectDeliveredTurn(
            page, instruction, CancellationToken.None);
        if (probe.PageTextMatches || probe.AnyUserRoleMatchesInnerText)
            break;
        if (attempt < 19)
            await Task.Delay(TimeSpan.FromSeconds(1));
    }

    if (probe is null)
        throw new InvalidOperationException("ACK_PROBE_NO_OBSERVATIONS");
    Console.WriteLine(probe.ToStatusLine());
    Console.WriteLine("ACK_PROBE_TRANSCRIPT_STATE:" +
        (probe.AnyUserRoleMatchesInnerText || probe.PageTextMatches
            ? "PRIOR_INSTRUCTION_VISIBLE"
            : probe.UserRoleElements == 0 && probe.UserTurnArticles == 0
                ? "NO_MESSAGE_TURNS_VISIBLE"
                : "TURNS_VISIBLE_INSTRUCTION_NOT_MATCHED"));
    Console.WriteLine("ACK_PROBE_COMPLETE:NOTHING_SENT");
    return 0;
}
catch (Exception ex)
{
    // Error codes only; Playwright messages can contain URLs or page text.
    Console.Error.WriteLine("ERROR: ACK_PROBE_FAILED:" + ex.GetType().Name);
    Console.Error.WriteLine("ACK_PROBE_COMPLETE:NOTHING_SENT");
    return 1;
}
