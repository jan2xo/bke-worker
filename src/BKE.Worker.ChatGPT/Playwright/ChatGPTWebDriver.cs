using BKE.Worker.Core;
using Microsoft.Playwright;

namespace BKE.Worker.ChatGPT.Playwright;

public sealed class ChatGPTWebDriver(
    ChromiumHost host,
    ProjectNavigator projects,
    ConversationNavigator conversations,
    ComposerDriver composer) : IChatGPTDriver
{
    private ReasoningProfile _compatibilityReasoning = ReasoningProfile.HIGH;

    public async Task Launch(CancellationToken cancellationToken)
    {
        var page = await host.GetPage(cancellationToken);
        if (!Uri.TryCreate(page.Url, UriKind.Absolute, out var current) ||
            !string.Equals(current.Host, "chatgpt.com", StringComparison.OrdinalIgnoreCase))
        {
            await page.GotoAsync(host.Options.ChatGptBaseUrl, new() { WaitUntil = WaitUntilState.DOMContentLoaded });
        }

        await ThrowIfAuthenticationRequired(page, cancellationToken);
    }

    public async Task<IReadOnlyList<ContextTarget>> GetAvailableContexts(CancellationToken cancellationToken)
    {
        var page = await host.GetPage(cancellationToken);
        var names = await projects.ListProjects(page, cancellationToken);
        return names.Select(name => new ContextTarget(ContextTargetType.ProjectChat, Project: name)).ToArray();
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

    private async Task ResetUi(IPage page, CancellationToken cancellationToken)
    {
        cancellationToken.ThrowIfCancellationRequested();
        await page.GotoAsync(host.Options.ChatGptBaseUrl, new() { WaitUntil = WaitUntilState.DOMContentLoaded });
        await ThrowIfAuthenticationRequired(page, cancellationToken);
    }

    private static async Task ThrowIfAuthenticationRequired(
        IPage page,
        CancellationToken cancellationToken)
    {
        var login = page.GetByRole(AriaRole.Button, new() { Name = "Log in", Exact = true });
        if (await ProjectNavigator.FindFirstVisible(login, cancellationToken) is not null)
            throw new InvalidOperationException("CHATGPT_AUTH_REQUIRED");
    }
}
