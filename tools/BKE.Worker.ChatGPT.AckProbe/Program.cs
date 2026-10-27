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

    // Read-only wait for the transcript to hydrate. Readiness is only observed, never acted on.
    await composer.WaitUntilCanSendNextTurn(page, CancellationToken.None, TimeSpan.FromSeconds(15));
    var probe = await ComposerDriver.InspectDeliveredTurn(page, instruction, CancellationToken.None);
    Console.WriteLine(probe.ToStatusLine());
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
