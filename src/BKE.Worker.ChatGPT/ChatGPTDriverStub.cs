using BKE.Worker.Core;
namespace BKE.Worker.ChatGPT;
public sealed class ChatGPTDriverStub : IChatGPTDriver
{
    public Task Launch(CancellationToken c) => Task.CompletedTask;
    public Task<IReadOnlyList<ContextTarget>> GetAvailableContexts(CancellationToken c) => Task.FromResult<IReadOnlyList<ContextTarget>>([]);
    public Task OpenContext(ContextTarget t, CancellationToken c) => Task.CompletedTask;
    public Task<IReadOnlyList<ReasoningProfile>> GetAvailableReasoningProfiles(CancellationToken c) => Task.FromResult<IReadOnlyList<ReasoningProfile>>([ReasoningProfile.MEDIUM, ReasoningProfile.HIGH]);
    public Task SetReasoning(ReasoningProfile p, CancellationToken c) => Task.CompletedTask;
    public Task<ReasoningProfile> GetCurrentReasoning(CancellationToken c) => Task.FromResult(ReasoningProfile.HIGH);
    public Task Send(string i, CancellationToken c) => Task.CompletedTask;
    public Task<ExecutionState> GetExecutionState(CancellationToken c) => Task.FromResult(new ExecutionState(false, true, false));
    public Task<string?> GetLatestResponse(CancellationToken c) => Task.FromResult<string?>(null);
}
