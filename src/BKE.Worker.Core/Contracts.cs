namespace BKE.Worker.Core;

public enum ContextTargetType { RecentChat, ProjectChat, NewChat }

public sealed record ContextTarget(ContextTargetType Type, string? Conversation = null, string? Project = null)
{
    public static ContextTarget NewChat() => new(ContextTargetType.NewChat);
    public static ContextTarget ProjectChat(string project, string conversation) =>
        new(ContextTargetType.ProjectChat, conversation, project);
}

public enum ReasoningProfile { DEFAULT, MEDIUM, HIGH, MAX_AVAILABLE }
public enum WorkStatus { TODO, RUNNING, DONE, FAILED, OWNER_DECISION }

public sealed record WorkItem(
    string Id,
    string Instruction,
    ContextTarget ContextTarget,
    ReasoningProfile ReasoningProfile = ReasoningProfile.DEFAULT,
    int Priority = 0,
    int RetryCount = 0,
    WorkStatus Status = WorkStatus.TODO,
    string? Result = null,
    string? StopReason = null);

public sealed record ExecutionState(bool IsRunning, bool IsComplete, bool IsFailed, string? FailureReason = null);

public sealed record WorkerPolicy(
    ReasoningProfile DefaultReasoning = ReasoningProfile.HIGH,
    TimeSpan? MinimumDispatchInterval = null)
{
    public TimeSpan DispatchInterval => MinimumDispatchInterval ?? TimeSpan.FromSeconds(30);
}

public static class WorkerPrompts
{
    public const string ContinueFromNotionChecklist = "CONTINUE FROM THE NOTION CHECKLIST.";
}

public enum WorkerRuntimeState
{
    IDLE,
    DISPATCHING,
    WAITING_FOR_ENGINEERING_EVENT,
    RECONCILING,
    CONTINUING,
    COMPLETE,
    BLOCKED,
    FAILED
}

public enum WorkerWakeReason
{
    GitHubPush,
    RecoveryTimer,
    Manual
}

public sealed record EngineeringTarget(
    string Project,
    string Conversation,
    string NotionPageId,
    ReasoningProfile ReasoningProfile = ReasoningProfile.HIGH,
    string Instruction = WorkerPrompts.ContinueFromNotionChecklist);

public sealed record ChecklistGate(string Id, string Text, bool Checked);

public sealed record ChecklistReconciliation(
    ChecklistGate? CurrentGate,
    ChecklistGate? FirstUncheckedGate,
    bool AllComplete);

public sealed record WorkerSnapshot(
    WorkerRuntimeState State,
    EngineeringTarget? Target,
    string? CurrentChecklistIdentifier,
    DateTimeOffset? LastDispatchAt,
    string? LastGitHubDeliveryId,
    DateTimeOffset? LastReconciliationAt,
    string? Failure)
{
    public static WorkerSnapshot Empty { get; } = new(
        WorkerRuntimeState.IDLE,
        null,
        null,
        null,
        null,
        null,
        null);
}

public sealed record WorkerLoopResult(
    WorkerRuntimeState State,
    bool PromptSent,
    bool DuplicateIgnored,
    string Message);

public sealed record WorkerWakeEvent(
    WorkerWakeReason Reason,
    string? DeliveryId,
    DateTimeOffset ReceivedAt);

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

    Task<bool> CanSendNextTurn(CancellationToken cancellationToken) => Task.FromResult(true);
}

public interface IChecklistReconciler
{
    Task<ChecklistReconciliation> Reconcile(
        string notionPageId,
        string? currentChecklistIdentifier,
        CancellationToken cancellationToken);
}

public interface IWorkerStateStore
{
    Task<WorkerSnapshot> Load(CancellationToken cancellationToken);
    Task Save(WorkerSnapshot snapshot, CancellationToken cancellationToken);
}

public interface IWorkerWakeSink
{
    ValueTask Enqueue(WorkerWakeEvent wakeEvent, CancellationToken cancellationToken);
}

public interface IWorkerLoop
{
    Task<WorkerLoopResult> Start(EngineeringTarget target, CancellationToken cancellationToken);
    Task<WorkerLoopResult> Wake(WorkerWakeReason reason, string? deliveryId, CancellationToken cancellationToken);
    Task<WorkerSnapshot> GetState(CancellationToken cancellationToken);
}

public sealed class ReasoningResolver : IReasoningResolver
{
    public ReasoningProfile Resolve(ReasoningProfile requested, WorkerPolicy policy) =>
        requested == ReasoningProfile.DEFAULT ? policy.DefaultReasoning : requested;
}
