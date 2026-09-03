using BKE.Worker.Core;
using Microsoft.Playwright;

namespace BKE.Worker.ChatGPT.Playwright;

public sealed record ChatGptAdapterProbeResult(
    bool Compatible,
    bool Authenticated,
    string Project,
    string Conversation,
    bool ComposerAvailable,
    bool TurnBusy,
    bool CanSendNextTurn,
    string? CurrentUrl,
    string? Failure,
    DateTimeOffset CheckedAt,
    string? OverrideUrl = null);

public sealed class ChatGPTWebDriver(
    ChromiumHost host,
    ProjectNavigator projects,
    ConversationNavigator conversations,
    ComposerDriver composer) : IChatGPTDriver
{
    private const string ExecutionSurfaceMismatch = "CHATGPT_EXECUTION_SURFACE_MISMATCH";
    private const string OverrideUrlInvalid = "CHATGPT_OVERRIDE_URL_INVALID";
    private ReasoningProfile _compatibilityReasoning = ReasoningProfile.HIGH;

    public async Task Launch(CancellationToken cancellationToken)
    {
        var page = await host.GetPage(cancellationToken);
        var baseUri = new Uri(host.Options.ChatGptBaseUrl, UriKind.Absolute);
        if (!Uri.TryCreate(page.Url, UriKind.Absolute, out var current) || !IsSameOrigin(current, baseUri))
        {
            await page.GotoAsync(host.Options.ChatGptBaseUrl, new() { WaitUntil = WaitUntilState.DOMContentLoaded });
        }

        await ThrowIfAuthenticationRequired(page, cancellationToken);
    }

    public Task<ChatGptAdapterProbeResult> ProbeExactContext(
        string project,
        string conversation,
        CancellationToken cancellationToken) =>
        ProbeTarget(
            ContextTarget.ProjectChat(project, conversation, ChatGptExecutionSurface.Chat),
            project,
            conversation,
            null,
            cancellationToken);

    public Task<ChatGptAdapterProbeResult> ProbeOverrideLink(
        string overrideUrl,
        CancellationToken cancellationToken) =>
        ProbeTarget(
            ContextTarget.OverrideLink(overrideUrl, ChatGptExecutionSurface.Chat),
            string.Empty,
            string.Empty,
            overrideUrl,
            cancellationToken);

    private async Task<ChatGptAdapterProbeResult> ProbeTarget(
        ContextTarget target,
        string project,
        string conversation,
        string? overrideUrl,
        CancellationToken cancellationToken)
    {
        string? currentUrl = null;
        var checkedAt = DateTimeOffset.UtcNow;
        try
        {
            await Launch(cancellationToken);
            currentUrl = (await host.GetPage(cancellationToken)).Url;

            await OpenContext(target, cancellationToken);

            var page = await host.GetPage(cancellationToken);
            currentUrl = page.Url;
            await ThrowIfAuthenticationRequired(page, cancellationToken);

            var composerState = await composer.Probe(page, cancellationToken);
            if (!composerState.ComposerAvailable && !composerState.TurnBusy)
                throw new InvalidOperationException("CHATGPT_COMPOSER_NOT_AVAILABLE");

            return new ChatGptAdapterProbeResult(
                Compatible: true,
                Authenticated: true,
                Project: project,
                Conversation: conversation,
                ComposerAvailable: composerState.ComposerAvailable,
                TurnBusy: composerState.TurnBusy,
                CanSendNextTurn: composerState.CanSendNextTurn,
                CurrentUrl: currentUrl,
                Failure: null,
                CheckedAt: checkedAt,
                OverrideUrl: overrideUrl);
        }
        catch (OperationCanceledException) when (cancellationToken.IsCancellationRequested)
        {
            throw;
        }
        catch (Exception ex)
        {
            return new ChatGptAdapterProbeResult(
                Compatible: false,
                Authenticated: !ex.Message.Contains("CHATGPT_AUTH_REQUIRED", StringComparison.Ordinal),
                Project: project,
                Conversation: conversation,
                ComposerAvailable: false,
                TurnBusy: false,
                CanSendNextTurn: false,
                CurrentUrl: currentUrl,
                Failure: ex.Message,
                CheckedAt: checkedAt,
                OverrideUrl: overrideUrl);
        }
    }

    public async Task<IReadOnlyList<ContextTarget>> GetAvailableContexts(CancellationToken cancellationToken)
    {
        var page = await host.GetPage(cancellationToken);
        var names = await projects.ListProjects(page, cancellationToken);
        return names.Select(name => new ContextTarget(
            ContextTargetType.ProjectChat,
            Project: name,
            Surface: ChatGptExecutionSurface.Chat)).ToArray();
    }

    public async Task<IReadOnlyList<string>> ListProjects(CancellationToken cancellationToken)
    {
        await Launch(cancellationToken);
        return await projects.ListProjects(await host.GetPage(cancellationToken), cancellationToken);
    }

    public async Task<IReadOnlyList<string>> ListConversations(
        string project,
        CancellationToken cancellationToken)
    {
        await Launch(cancellationToken);
        var page = await host.GetPage(cancellationToken);
        await projects.OpenExactProject(page, project, cancellationToken);
        return await conversations.ListConversations(page, cancellationToken);
    }

    public async Task OpenContext(ContextTarget target, CancellationToken cancellationToken)
    {
        // This driver is specifically the persistent Chat conversation adapter.
        // Work is a distinct agentic surface and must never be silently substituted.
        if (target.Surface != ChatGptExecutionSurface.Chat)
            throw new InvalidOperationException(ExecutionSurfaceMismatch);

        if (target.Type == ContextTargetType.OverrideLink)
        {
            await OpenOverrideLink(target.OverrideUrl, cancellationToken);
            return;
        }

        if (target.Type != ContextTargetType.ProjectChat ||
            string.IsNullOrWhiteSpace(target.Project) ||
            string.IsNullOrWhiteSpace(target.Conversation))
        {
            throw new InvalidOperationException("PROJECT_CONTEXT_REQUIRED");
        }

        await Launch(cancellationToken);
        for (var attempt = 0; attempt < 2; attempt++)
        {
            var page = await host.GetPage(cancellationToken);
            try
            {
                await projects.OpenExactProject(page, target.Project, cancellationToken);
                await conversations.OpenExactConversation(page, target.Conversation, cancellationToken);
                return;
            }
            catch (ChatGptNavigationException) when (attempt == 0)
            {
                await ResetUi(page, cancellationToken);
            }
        }

        throw new InvalidOperationException("CONTEXT_NOT_FOUND");
    }

    public Task<IReadOnlyList<ReasoningProfile>> GetAvailableReasoningProfiles(CancellationToken cancellationToken) =>
        Task.FromResult<IReadOnlyList<ReasoningProfile>>([ReasoningProfile.DEFAULT, ReasoningProfile.MEDIUM, ReasoningProfile.HIGH, ReasoningProfile.MAX_AVAILABLE]);

    // Retained for the legacy driver contract. V1 web orchestration does not manipulate ChatGPT's model/reasoning UI.
    public Task SetReasoning(ReasoningProfile profile, CancellationToken cancellationToken)
    {
        _compatibilityReasoning = profile;
        return Task.CompletedTask;
    }

    public Task<ReasoningProfile> GetCurrentReasoning(CancellationToken cancellationToken) =>
        Task.FromResult(_compatibilityReasoning);

    public async Task Send(string instruction, CancellationToken cancellationToken)
    {
        var page = await host.GetPage(cancellationToken);
        await ThrowIfAuthenticationRequired(page, cancellationToken);
        await composer.Send(page, instruction, cancellationToken);
    }

    public async Task<bool> CanSendNextTurn(CancellationToken cancellationToken)
    {
        var page = await host.GetPage(cancellationToken);
        await ThrowIfAuthenticationRequired(page, cancellationToken);
        return await composer.CanSendNextTurn(page, cancellationToken);
    }

    public async Task<ExecutionState> GetExecutionState(CancellationToken cancellationToken)
    {
        var idle = await CanSendNextTurn(cancellationToken);
        return new ExecutionState(!idle, idle, false);
    }

    public Task<string?> GetLatestResponse(CancellationToken cancellationToken) =>
        Task.FromResult<string?>(null);

    private async Task OpenOverrideLink(string? overrideUrl, CancellationToken cancellationToken)
    {
        if (!TryParseConversationOverride(overrideUrl, out var targetUri, out var conversationId))
            throw new InvalidOperationException(OverrideUrlInvalid);

        await Launch(cancellationToken);
        var page = await host.GetPage(cancellationToken);
        try
        {
            await page.GotoAsync(
                targetUri.AbsoluteUri,
                new()
                {
                    WaitUntil = WaitUntilState.DOMContentLoaded,
                    Timeout = 15_000
                });
        }
        catch (PlaywrightException)
        {
            throw new InvalidOperationException("CONTEXT_NOT_FOUND");
        }

        await ThrowIfAuthenticationRequired(page, cancellationToken);

        if (!Uri.TryCreate(page.Url, UriKind.Absolute, out var landed) ||
            !IsChatGptHost(landed) ||
            !ContainsConversationId(landed, conversationId))
        {
            throw new InvalidOperationException("CONTEXT_NOT_FOUND");
        }
    }

    private async Task ResetUi(IPage page, CancellationToken cancellationToken)
    {
        cancellationToken.ThrowIfCancellationRequested();
        await page.GotoAsync(host.Options.ChatGptBaseUrl, new() { WaitUntil = WaitUntilState.DOMContentLoaded });
        await ThrowIfAuthenticationRequired(page, cancellationToken);
    }

    private static bool TryParseConversationOverride(
        string? value,
        out Uri uri,
        out string conversationId)
    {
        uri = null!;
        conversationId = string.Empty;

        if (!Uri.TryCreate(value, UriKind.Absolute, out var parsed) ||
            !string.Equals(parsed.Scheme, Uri.UriSchemeHttps, StringComparison.OrdinalIgnoreCase) ||
            !IsChatGptHost(parsed))
        {
            return false;
        }

        var segments = parsed.AbsolutePath
            .Split('/', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries);
        for (var index = 0; index < segments.Length - 1; index++)
        {
            if (!string.Equals(segments[index], "c", StringComparison.OrdinalIgnoreCase))
                continue;

            if (string.IsNullOrWhiteSpace(segments[index + 1]))
                return false;

            conversationId = segments[index + 1];
            uri = parsed;
            return true;
        }

        return false;
    }

    private static bool ContainsConversationId(Uri uri, string conversationId)
    {
        var segments = uri.AbsolutePath
            .Split('/', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries);
        for (var index = 0; index < segments.Length - 1; index++)
        {
            if (string.Equals(segments[index], "c", StringComparison.OrdinalIgnoreCase) &&
                string.Equals(segments[index + 1], conversationId, StringComparison.OrdinalIgnoreCase))
            {
                return true;
            }
        }

        return false;
    }

    private static bool IsChatGptHost(Uri uri) =>
        string.Equals(uri.Host, "chatgpt.com", StringComparison.OrdinalIgnoreCase) ||
        string.Equals(uri.Host, "www.chatgpt.com", StringComparison.OrdinalIgnoreCase);

    private static bool IsSameOrigin(Uri left, Uri right) =>
        string.Equals(left.Scheme, right.Scheme, StringComparison.OrdinalIgnoreCase) &&
        string.Equals(left.Host, right.Host, StringComparison.OrdinalIgnoreCase) &&
        left.Port == right.Port;

    private static async Task ThrowIfAuthenticationRequired(
        IPage page,
        CancellationToken cancellationToken)
    {
        if (Uri.TryCreate(page.Url, UriKind.Absolute, out var current) &&
            string.Equals(current.Host, "auth.openai.com", StringComparison.OrdinalIgnoreCase))
        {
            throw new InvalidOperationException("CHATGPT_AUTH_REQUIRED");
        }

        var login = page.GetByRole(AriaRole.Button, new() { Name = "Log in", Exact = true });
        if (await ProjectNavigator.FindFirstVisible(login, cancellationToken) is not null)
            throw new InvalidOperationException("CHATGPT_AUTH_REQUIRED");
    }
}
