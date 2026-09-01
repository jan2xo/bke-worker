namespace BKE.Worker.Core;

public enum ContextTargetType { RecentChat, ProjectChat, NewChat }
public sealed record ContextTarget(ContextTargetType Type, string? Conversation = null, string? Project = null)
{
    public static ContextTarget NewChat() => new(ContextTargetType.NewChat);
}
public enum ReasoningProfile { DEFAULT, MEDIUM, HIGH, MAX_AVAILABLE }
public enum WorkStatus { TODO, RUNNING, DONE, FAILED, OWNER_DECISION }
public sealed record WorkItem(string Id, string Instruction, ContextTarget ContextTarget, ReasoningProfile ReasoningProfile = ReasoningProfile.DEFAULT, int Priority = 0, int RetryCount = 0, WorkStatus Status = WorkStatus.TODO, string? Result = null, string? StopReason = null);
public sealed record ExecutionState(bool IsRunning, bool IsComplete, bool IsFailed, string? FailureReason = null);
public sealed record WorkerPolicy(ReasoningProfile DefaultReasoning = ReasoningProfile.HIGH);

public interface IWorkSource
{
    Task<WorkItem?> GetNextRunnableTask(CancellationToken cancellationToken);
    Task<bool> ClaimTask(WorkItem task, CancellationToken cancellationToken);
    Task CompleteTask(WorkItem task, string result, CancellationToken cancellationToken);
    Task FailTask(WorkItem task, string reason, bool ownerDecision, CancellationToken cancellationToken);
}
public interface IWorkStateStore { }
public interface IContextResolver { ContextTarget Resolve(WorkItem task); }
public interface IReasoningResolver { ReasoningProfile Resolve(ReasoningProfile requested, WorkerPolicy policy); }
public interface IChatGPTDriver
{
    Task Launch(CancellationToken cancellationToken);
    Task<IReadOnlyList<ContextTarget>> GetAvailableContexts(CancellationToken cancellationToken);
    Task OpenContext(ContextTarget target, CancellationToken cancellationToken);
    Task<IReadOnlyList<ReasoningProfile>> GetAvailableReasoningProfiles(CancellationToken cancellationToken);
    Task SetReasoning(ReasoningProfile profile, CancellationToken cancellationToken);
    Task<ReasoningProfile> GetCurrentReasoning(CancellationToken cancellationToken);
    Task Send(string instruction, CancellationToken cancellationToken);
    Task<ExecutionState> GetExecutionState(CancellationToken cancellationToken);
    Task<string?> GetLatestResponse(CancellationToken cancellationToken);
}
public interface IWorkerLoop { Task RunOnce(CancellationToken cancellationToken); }

public sealed class ReasoningResolver : IReasoningResolver
{
    public ReasoningProfile Resolve(ReasoningProfile requested, WorkerPolicy policy) => requested == ReasoningProfile.DEFAULT ? policy.DefaultReasoning : requested;
}
public sealed class WorkerLoop(IWorkSource source, IChatGPTDriver driver, IContextResolver contexts, IReasoningResolver reasoning, WorkerPolicy policy) : IWorkerLoop
{
    public async Task RunOnce(CancellationToken ct)
    {
        var task = await source.GetNextRunnableTask(ct);
        if (task is null) return;
        if (!await source.ClaimTask(task, ct)) return;
        try
        {
            await driver.Launch(ct);
            await driver.OpenContext(contexts.Resolve(task), ct);
            var effective = reasoning.Resolve(task.ReasoningProfile, policy);
            await driver.SetReasoning(effective, ct);
            if (await driver.GetCurrentReasoning(ct) != effective) throw new InvalidOperationException("Reasoning profile could not be verified.");
            await driver.Send(task.Instruction, ct);
            ExecutionState state;
            do { state = await driver.GetExecutionState(ct); } while (!state.IsComplete && !state.IsFailed);
            if (state.IsFailed) throw new InvalidOperationException(state.FailureReason ?? "ChatGPT execution failed.");
            await source.CompleteTask(task, await driver.GetLatestResponse(ct) ?? string.Empty, ct);
        }
        catch (InvalidOperationException ex) { await source.FailTask(task, ex.Message, ex.Message.Contains("owner", StringComparison.OrdinalIgnoreCase), ct); }
    }
}
