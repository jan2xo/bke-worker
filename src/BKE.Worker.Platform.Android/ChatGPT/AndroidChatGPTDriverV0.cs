using BKE.Worker.Core;
using BKE.Worker.Platform.Android.Execution;
using BKE.Worker.Platform.Android.Reasoning;

namespace BKE.Worker.Platform.Android.ChatGPT;

public sealed class AndroidChatGPTDriverV0(
    IAndroidReasoningSelector reasoningSelector,
    Func<CancellationToken, Task> launch,
    Func<ContextTarget, CancellationToken, Task> openContext,
    Func<string, CancellationToken, Task> send,
    Func<CancellationToken, Task<ExecutionState>> observe,
    Func<CancellationToken, Task<string?>> capture) : IChatGPTDriver
{
    private readonly AndroidReasoningVerifier _reasoning = new(reasoningSelector);

    public Task Launch(CancellationToken cancellationToken) => launch(cancellationToken);
    public Task<IReadOnlyList<ContextTarget>> GetAvailableContexts(CancellationToken cancellationToken) =>
        Task.FromResult<IReadOnlyList<ContextTarget>>([]);
    public Task OpenContext(ContextTarget target, CancellationToken cancellationToken) => openContext(target, cancellationToken);
    public Task<IReadOnlyList<ReasoningProfile>> GetAvailableReasoningProfiles(CancellationToken cancellationToken) =>
        reasoningSelector.DiscoverAsync(cancellationToken);
    public async Task SetReasoning(ReasoningProfile profile, CancellationToken cancellationToken)
    {
        if (!await _reasoning.SelectAndVerifyAsync(profile, cancellationToken))
            throw new InvalidOperationException("REASONING_VERIFICATION_FAILED");
    }
    public async Task<ReasoningProfile> GetCurrentReasoning(CancellationToken cancellationToken) =>
        await reasoningSelector.ReadSelectedAsync(cancellationToken) ??
        throw new InvalidOperationException("REASONING_SELECTOR_NOT_FOUND");
    public Task Send(string instruction, CancellationToken cancellationToken) => send(instruction, cancellationToken);
    public Task<ExecutionState> GetExecutionState(CancellationToken cancellationToken) => observe(cancellationToken);
    public Task<string?> GetLatestResponse(CancellationToken cancellationToken) => capture(cancellationToken);
}
