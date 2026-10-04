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

public sealed record WorkerIdentity(string Id)
{
    public const string AssignmentLabelPrefix = "bke-worker:";

    public bool IsValid => IsValidId(Id);

    public string AssignmentLabel =>
        AssignmentLabelPrefix + Id;

    public static bool IsValidId(string? value)
    {
        if (string.IsNullOrWhiteSpace(value) ||
            value.Length > 63)
        {
            return false;
        }

        if (!IsLowerAlphaNumeric(value[0]))
            return false;

        foreach (var character in value)
        {
            if (!IsLowerAlphaNumeric(character) &&
                character != '-')
            {
                return false;
            }
        }

        return true;
    }

    private static bool IsLowerAlphaNumeric(char value) =>
        value is >= 'a' and <= 'z' ||
        value is >= '0' and <= '9';
}

public sealed record PullRequestAssignment(
    int Number,
    string HeadRef,
    string HeadSha)
{
    public bool IsValid =>
        Number > 0 &&
        !string.IsNullOrWhiteSpace(HeadRef) &&
        !HeadRef.StartsWith(
            "refs/",
            StringComparison.Ordinal) &&
        HeadSha.Length == 40 &&
        HeadSha.All(character =>
            character is >= '0' and <= '9' ||
            character is >= 'a' and <= 'f');
}

public static class WorkerPrompts
{
    public const string CanonicalInstructionsPath =
        "BKE-WORKER-CANONICAL-PROJECT-EXECUTION-INSTRUCTIONS.md";

    public const string CanonicalControlRepository =
        "jan2xo/bke-worker";

    public const string ContinueAutonomousEngineering =
        "CONTINUE AUTONOMOUS ENGINEERING. " +
        "This worker may run in a ChatGPT account with no BKE project, memory, or prior chat context. " +
        "Before acting, read " + CanonicalInstructionsPath +
        " from current main of jan2xo/bke-worker" +
        " and treat that main-branch file as the canonical BKE Worker execution contract; " +
        "if it cannot be recovered, stop fail-closed. " +
        "Do not substitute ChatGPT project configuration, memory, prior chats, " +
        "or unrelated external planning state for that contract. " +
        "Then recover the live GitHub state before acting. " +
        "If an engineering PR is active, recover its intent and exact head, finish implementation, " +
        "run only its declared minimum complete certification graph, verify exact-head proof, " +
        "SHA-lock merge when good, and write the durable merge checkpoint. " +
        "If that intent is complete and another explicitly queued engineering intent exists, " +
        "start a fresh branch from current main, open a NEW PR using .github/pull_request_template.md, " +
        "declare its certification graph, and execute it. " +
        "Never reuse an old or merged feature branch for a new intent. " +
        "Do not invent unqueued work. Keep production and security locks in force.";

    public static string ForAssignment(
        WorkerIdentity worker,
        PullRequestAssignment assignment,
        string baseInstruction =
            ContinueAutonomousEngineering) =>
        baseInstruction + " " +
        $"WORKER OWNERSHIP LOCK: worker_id={worker.Id}; assigned PR #{assignment.Number}; " +
        $"expected assignment label={worker.AssignmentLabel}; " +
        $"expected head ref={assignment.HeadRef}; expected head SHA={assignment.HeadSha}. " +
        "Before any engineering action, recover live GitHub and verify the assigned PR is open, " +
        $"has exactly one {AssignmentLabelPrefixForPrompt()} label and it is {worker.AssignmentLabel}, " +
        $"and verify worker_id={worker.Id} owns no second open PR. " +
        "Verify the live assigned PR head ref and SHA exactly match the ownership lock before acting. " +
        "If ownership or the exact head is missing, duplicated, stale, or ambiguous, stop without changing code, " +
        "certifying, or merging. Never act on another worker's PR.";

    private static string AssignmentLabelPrefixForPrompt() =>
        $"'{WorkerIdentity.AssignmentLabelPrefix}<worker_id>'";
}

public enum WorkerRuntimeState
{
    IDLE,
    WAITING_FOR_ASSIGNMENT,
    DISPATCHING,
    WAITING_FOR_ENGINEERING_EVENT,
    CONTINUING,
    BLOCKED,
    FAILED
}

public enum WorkerWakeReason
{
    GitHubPush,
    GitHubPullRequest,
    AssignmentRevoked,
    AssignmentConflict,
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
    string? Failure,
    PullRequestAssignment? Assignment = null,
    string[]? RecentGitHubDeliveryIds = null)
{
    public static WorkerSnapshot Empty { get; } = new(
        WorkerRuntimeState.IDLE,
        null,
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
    DateTimeOffset ReceivedAt,
    PullRequestAssignment? Assignment = null,
    int? PullRequestNumber = null,
    string? GitHubRef = null);

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
        WorkerWakeEvent wakeEvent,
        CancellationToken cancellationToken);

    Task<WorkerSnapshot> GetState(CancellationToken cancellationToken);
}
