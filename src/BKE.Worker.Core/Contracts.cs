namespace BKE.Worker.Core;

public enum ContextTargetType { RecentChat, ProjectChat, NewChat, OverrideLink }
public enum ChatGptExecutionSurface { Chat, Work }

public sealed record ContextTarget(
    ContextTargetType Type,
    string? Conversation = null,
    string? Project = null,
    ChatGptExecutionSurface Surface = ChatGptExecutionSurface.Chat,
    string? OverrideUrl = null)
{
    public static ContextTarget NewChat(
        ChatGptExecutionSurface surface = ChatGptExecutionSurface.Chat) =>
        new(ContextTargetType.NewChat, Surface: surface);

    public static ContextTarget ProjectChat(
        string project,
        string conversation,
        ChatGptExecutionSurface surface = ChatGptExecutionSurface.Chat) =>
        new(ContextTargetType.ProjectChat, conversation, project, surface);

    public static ContextTarget OverrideLink(
        string overrideUrl,
        ChatGptExecutionSurface surface = ChatGptExecutionSurface.Chat) =>
        new(ContextTargetType.OverrideLink, Surface: surface, OverrideUrl: overrideUrl);
}

public enum ReasoningProfile { DEFAULT, MEDIUM, HIGH, MAX_AVAILABLE }

public sealed record ExecutionState(
    bool IsRunning,
    bool IsComplete,
    bool IsFailed,
    string? FailureReason = null);

public sealed record WorkerPolicy(
    ReasoningProfile DefaultReasoning = ReasoningProfile.HIGH,
    TimeSpan? MinimumDispatchInterval = null)
{
    public TimeSpan DispatchInterval =>
        MinimumDispatchInterval ?? TimeSpan.FromSeconds(30);
}

public static class WorkerPrompts
{
    public const string ContinueAutonomousEngineering =
        "CONTINUE AUTONOMOUS ENGINEERING. " +
        "Recover the canonical Project Source and live GitHub state before acting. " +
        "If an engineering PR is active, recover its intent and exact head, finish implementation, " +
        "run only its declared minimum complete certification graph, verify exact-head proof, " +
        "SHA-lock merge when good, and write the durable merge checkpoint. " +
        "If that intent is complete and another explicitly queued engineering intent exists, " +
        "start a fresh branch from current main, open a NEW PR using .github/pull_request_template.md, " +
        "declare its certification graph, and execute it. " +
        "Never reuse an old or merged feature branch for a new intent. " +
        "Do not invent unqueued work. Keep production and security locks in force.";
}

public enum WorkerRuntimeState
{
    IDLE,
    DISPATCHING,
    WAITING_FOR_ENGINEERING_EVENT,
    CONTINUING,
    BLOCKED,
    FAILED
}

public enum WorkerWakeReason
{
    GitHubPush,
    Heartbeat,
    Manual
}

public sealed record EngineeringTarget(
    string Project,
    string Conversation,
    ReasoningProfile ReasoningProfile = ReasoningProfile.HIGH,
    string Instruction = WorkerPrompts.ContinueAutonomousEngineering,
    ChatGptExecutionSurface Surface = ChatGptExecutionSurface.Chat,
    string? OverrideUrl = null)
{
    public bool UsesOverrideLink => !string.IsNullOrWhiteSpace(OverrideUrl);
    public bool HasProject => !string.IsNullOrWhiteSpace(Project);
    public bool HasConversation => !string.IsNullOrWhiteSpace(Conversation);
    public bool HasProjectChat => HasProject && HasConversation;
    public bool HasPartialProjectChat => HasProject != HasConversation;
    public bool HasAmbiguousExplicitTargets =>
        UsesOverrideLink && (HasProject || HasConversation);
    public bool UsesNewChat => !UsesOverrideLink && !HasProject && !HasConversation;

    public ContextTarget ResolveContextTarget()
    {
        if (HasAmbiguousExplicitTargets)
            throw new InvalidOperationException("CHATGPT_TARGET_AMBIGUOUS");

        if (HasPartialProjectChat)
            throw new InvalidOperationException("CHATGPT_TARGET_INCOMPLETE");

        if (UsesOverrideLink)
            return ContextTarget.OverrideLink(OverrideUrl!, Surface);

        if (HasProjectChat)
            return ContextTarget.ProjectChat(Project, Conversation, Surface);

        return ContextTarget.NewChat(Surface);
    }
}

public sealed record WorkerSnapshot(
    WorkerRuntimeState State,
    EngineeringTarget? Target,
    DateTimeOffset? LastDispatchAt,
    string? LastGitHubDeliveryId,
    DateTimeOffset? LastWakeAt,
    string? Failure)
{
    public static WorkerSnapshot Empty { get; } = new(
        WorkerRuntimeState.IDLE,
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

    Task<bool> CanSendNextTurn(CancellationToken cancellationToken) =>
        Task.FromResult(true);
}

public interface IWorkerStateStore
{
    Task<WorkerSnapshot> Load(CancellationToken cancellationToken);
    Task Save(WorkerSnapshot snapshot, CancellationToken cancellationToken);
}

public interface IWorkerWakeSink
{
    ValueTask Enqueue(
        WorkerWakeEvent wakeEvent,
        CancellationToken cancellationToken);
}

public interface IWorkerLoop
{
    Task<WorkerLoopResult> Start(
        EngineeringTarget target,
        CancellationToken cancellationToken);

    Task<WorkerLoopResult> Wake(
        WorkerWakeReason reason,
        string? deliveryId,
        CancellationToken cancellationToken);

    Task<WorkerSnapshot> GetState(CancellationToken cancellationToken);
}
