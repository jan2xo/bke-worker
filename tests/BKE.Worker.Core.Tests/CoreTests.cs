global using Xunit;
using BKE.Worker.Core;

namespace BKE.Worker.Core.Tests;

public sealed class CoreTests
{
    private static readonly WorkerIdentity Worker =
        new("worker-a");

    [Fact]
    public void Default_reasoning_is_high() =>
        Assert.Equal(
            ReasoningProfile.HIGH,
            new WorkerPolicy().DefaultReasoning);

    [Theory]
    [InlineData("worker-a", true)]
    [InlineData("a", true)]
    [InlineData("worker-01", true)]
    [InlineData("", false)]
    [InlineData("Worker-A", false)]
    [InlineData("-worker", false)]
    [InlineData("worker_a", false)]
    public void Worker_identity_has_canonical_format(
        string value,
        bool expected) =>
        Assert.Equal(
            expected,
            WorkerIdentity.IsValidId(value));

    [Fact]
    public void Assignment_prompt_locks_worker_and_pr()
    {
        var prompt =
            WorkerPrompts.ForAssignment(
                Worker,
                Assignment());

        Assert.Contains(
            "live GitHub",
            prompt,
            StringComparison.Ordinal);
        Assert.Contains(
            "worker_id=worker-a",
            prompt,
            StringComparison.Ordinal);
        Assert.Contains(
            "assigned PR #101",
            prompt,
            StringComparison.Ordinal);
        Assert.Contains(
            "bke-worker:worker-a",
            prompt,
            StringComparison.Ordinal);
        Assert.Contains(
            "owns no second open PR",
            prompt,
            StringComparison.Ordinal);
        Assert.Contains(
            "Do not invent unqueued work",
            prompt,
            StringComparison.Ordinal);
        Assert.DoesNotContain(
            "Notion",
            prompt,
            StringComparison.OrdinalIgnoreCase);
    }

    [Fact]
    public async Task Start_waits_for_GitHub_assignment()
    {
        var driver = new FakeDriver();
        var store = new FakeStore();
        var loop = Loop(driver, store);

        var result =
            await loop.Start(
                Target(),
                CancellationToken.None);

        Assert.False(result.PromptSent);
        Assert.Equal(
            WorkerRuntimeState
                .WAITING_FOR_ASSIGNMENT,
            result.State);
        Assert.Equal(
            "WAITING_FOR_ASSIGNMENT",
            result.Message);
        Assert.Empty(driver.Sent);
        Assert.Equal(
            Target(),
            store.Snapshot.Target);
        Assert.Null(store.Snapshot.Assignment);
    }

    [Fact]
    public async Task Assigned_PR_dispatches_locked_instruction()
    {
        var driver = new FakeDriver();
        var store = new FakeStore();
        var loop = Loop(driver, store);

        await loop.Start(
            Target(),
            CancellationToken.None);

        var result =
            await loop.Wake(
                AssignmentEvent(
                    "delivery-1"),
                CancellationToken.None);

        Assert.True(result.PromptSent);
        Assert.Equal(
            WorkerRuntimeState
                .WAITING_FOR_ENGINEERING_EVENT,
            result.State);
        Assert.Single(driver.Sent);
        Assert.Contains(
            "worker_id=worker-a",
            driver.Sent[0],
            StringComparison.Ordinal);
        Assert.Contains(
            "assigned PR #101",
            driver.Sent[0],
            StringComparison.Ordinal);
        Assert.Equal(
            Assignment(),
            store.Snapshot.Assignment);
        Assert.NotNull(
            store.Snapshot.LastDispatchAt);
    }

    [Fact]
    public async Task Busy_assignment_defers_without_losing_claim()
    {
        var driver =
            new FakeDriver { CanSend = false };
        var store = new FakeStore();
        var loop = Loop(driver, store);

        await loop.Start(
            Target(),
            CancellationToken.None);

        var result =
            await loop.Wake(
                AssignmentEvent(
                    "delivery-busy"),
                CancellationToken.None);

        Assert.False(result.PromptSent);
        Assert.Equal(
            "WAKE_DEFERRED_CHATGPT_NOT_SAFE_TO_INTERRUPT",
            result.Message);
        Assert.Equal(
            WorkerRuntimeState
                .WAITING_FOR_ENGINEERING_EVENT,
            store.Snapshot.State);
        Assert.Equal(
            Assignment(),
            store.Snapshot.Assignment);
        Assert.Empty(driver.Sent);
    }

    [Fact]
    public async Task Matching_push_continues_assigned_PR()
    {
        var driver = new FakeDriver();
        var store = new FakeStore();
        var loop = Loop(driver, store);

        await StartAndAssign(
            loop,
            driver);

        var result =
            await loop.Wake(
                PushEvent(
                    "delivery-push",
                    "refs/heads/feat/pr-a"),
                CancellationToken.None);

        Assert.True(result.PromptSent);
        Assert.Equal(2, driver.Sent.Count);
        Assert.Equal(
            "delivery-push",
            store
                .Snapshot
                .LastGitHubDeliveryId);
    }

    [Fact]
    public async Task Unrelated_push_is_ignored()
    {
        var driver = new FakeDriver();
        var store = new FakeStore();
        var loop = Loop(driver, store);

        await StartAndAssign(
            loop,
            driver);

        var result =
            await loop.Wake(
                PushEvent(
                    "delivery-other",
                    "refs/heads/feat/pr-b"),
                CancellationToken.None);

        Assert.False(result.PromptSent);
        Assert.Equal(
            "PUSH_NOT_ASSIGNED_TO_WORKER",
            result.Message);
        Assert.Single(driver.Sent);
    }

    [Fact]
    public async Task Second_PR_assignment_blocks_worker()
    {
        var driver = new FakeDriver();
        var store = new FakeStore();
        var loop = Loop(driver, store);

        await StartAndAssign(
            loop,
            driver);

        var result =
            await loop.Wake(
                AssignmentEvent(
                    "delivery-2",
                    new PullRequestAssignment(
                        202,
                        "feat/pr-b",
                        Sha('b'))),
                CancellationToken.None);

        Assert.False(result.PromptSent);
        Assert.Equal(
            WorkerRuntimeState.BLOCKED,
            result.State);
        Assert.Equal(
            "WORKER_ALREADY_ASSIGNED_TO_DIFFERENT_PR",
            result.Message);
        Assert.Single(driver.Sent);
        Assert.Equal(
            Assignment(),
            store.Snapshot.Assignment);
    }

    [Fact]
    public async Task Ambiguous_assignment_blocks_worker()
    {
        var driver = new FakeDriver();
        var store = new FakeStore();
        var loop = Loop(driver, store);

        await StartAndAssign(
            loop,
            driver);

        var result =
            await loop.Wake(
                new WorkerWakeEvent(
                    WorkerWakeReason
                        .AssignmentConflict,
                    "delivery-conflict",
                    DateTimeOffset.UtcNow,
                    PullRequestNumber: 101),
                CancellationToken.None);

        Assert.False(result.PromptSent);
        Assert.Equal(
            WorkerRuntimeState.BLOCKED,
            result.State);
        Assert.Equal(
            "AMBIGUOUS_PR_ASSIGNMENT",
            result.Message);
        Assert.Single(driver.Sent);
    }

    [Fact]
    public async Task Assignment_revocation_stops_continuation()
    {
        var driver = new FakeDriver();
        var store = new FakeStore();
        var loop = Loop(driver, store);

        await StartAndAssign(
            loop,
            driver);

        var revoked =
            await loop.Wake(
                new WorkerWakeEvent(
                    WorkerWakeReason
                        .AssignmentRevoked,
                    "delivery-revoke",
                    DateTimeOffset.UtcNow,
                    PullRequestNumber: 101),
                CancellationToken.None);

        Assert.False(revoked.PromptSent);
        Assert.Equal(
            WorkerRuntimeState
                .WAITING_FOR_ASSIGNMENT,
            revoked.State);
        Assert.Null(
            store.Snapshot.Assignment);

        var push =
            await loop.Wake(
                PushEvent(
                    "delivery-after-revoke",
                    "refs/heads/feat/pr-a"),
                CancellationToken.None);

        Assert.False(push.PromptSent);
        Assert.Equal(
            "NO_ACTIVE_PR_ASSIGNMENT",
            push.Message);
        Assert.Single(driver.Sent);
    }

    [Fact]
    public async Task Duplicate_GitHub_delivery_is_ignored()
    {
        var driver = new FakeDriver();
        var store = new FakeStore();
        var loop = Loop(driver, store);

        await loop.Start(
            Target(),
            CancellationToken.None);
        await loop.Wake(
            AssignmentEvent(
                "same-delivery"),
            CancellationToken.None);

        var duplicate =
            await loop.Wake(
                AssignmentEvent(
                    "same-delivery"),
                CancellationToken.None);

        Assert.True(
            duplicate.DuplicateIgnored);
        Assert.Single(driver.Sent);
    }

    [Fact]
    public async Task Nonconsecutive_GitHub_redelivery_is_ignored()
    {
        var driver = new FakeDriver();
        var store = new FakeStore();
        var loop = Loop(driver, store);

        await loop.Start(
            Target(),
            CancellationToken.None);
        await loop.Wake(
            AssignmentEvent(
                "delivery-a"),
            CancellationToken.None);
        await loop.Wake(
            PushEvent(
                "delivery-b",
                "refs/heads/feat/pr-b"),
            CancellationToken.None);

        var duplicate =
            await loop.Wake(
                AssignmentEvent(
                    "delivery-a"),
                CancellationToken.None);

        Assert.True(
            duplicate.DuplicateIgnored);
        Assert.Single(driver.Sent);
        Assert.Contains(
            "delivery-a",
            store.Snapshot
                .RecentGitHubDeliveryIds!);
        Assert.Contains(
            "delivery-b",
            store.Snapshot
                .RecentGitHubDeliveryIds!);
    }

    [Theory]
    [InlineData(
        WorkerRuntimeState.DISPATCHING)]
    [InlineData(
        WorkerRuntimeState.CONTINUING)]
    public async Task Restart_with_uncertain_send_blocks_without_resending(
        WorkerRuntimeState state)
    {
        var driver = new FakeDriver();
        var store =
            new FakeStore(
                new WorkerSnapshot(
                    state,
                    Target(),
                    null,
                    null,
                    null,
                    null,
                    Assignment()));
        var loop = Loop(driver, store);

        var result =
            await loop.Start(
                Target(),
                CancellationToken.None);

        Assert.Equal(
            WorkerRuntimeState.BLOCKED,
            result.State);
        Assert.Equal(
            "DISPATCH_OUTCOME_UNKNOWN_AFTER_RESTART",
            result.Message);
        Assert.Empty(driver.Sent);
    }

    [Fact]
    public async Task Persisted_block_requires_explicit_manual_continue()
    {
        var target = Target();
        var driver = new FakeDriver();
        var store =
            new FakeStore(
                new WorkerSnapshot(
                    WorkerRuntimeState.BLOCKED,
                    target,
                    null,
                    null,
                    null,
                    "DISPATCH_OUTCOME_UNKNOWN_AFTER_RESTART",
                    Assignment()));
        var loop = Loop(driver, store);

        var heartbeat =
            await loop.Wake(
                new WorkerWakeEvent(
                    WorkerWakeReason.Heartbeat,
                    null,
                    DateTimeOffset.UtcNow),
                CancellationToken.None);

        Assert.False(heartbeat.PromptSent);
        Assert.Equal(
            WorkerRuntimeState.BLOCKED,
            store.Snapshot.State);
        Assert.Empty(driver.Sent);

        var manual =
            await loop.Wake(
                new WorkerWakeEvent(
                    WorkerWakeReason.Manual,
                    null,
                    DateTimeOffset.UtcNow),
                CancellationToken.None);

        Assert.True(manual.PromptSent);
        Assert.Single(driver.Sent);
        Assert.Equal(
            WorkerRuntimeState
                .WAITING_FOR_ENGINEERING_EVENT,
            store.Snapshot.State);
    }

    [Fact]
    public async Task Work_surface_fails_closed_before_assignment()
    {
        var driver = new FakeDriver();
        var store = new FakeStore();
        var loop = Loop(driver, store);

        var result =
            await loop.Start(
                Target() with
                {
                    Surface =
                        ChatGptExecutionSurface.Work,
                },
                CancellationToken.None);

        Assert.Equal(
            WorkerRuntimeState.BLOCKED,
            result.State);
        Assert.Equal(
            "CHATGPT_EXECUTION_SURFACE_MISMATCH",
            result.Message);
        Assert.Equal(0, driver.LaunchCalls);
        Assert.Empty(driver.Sent);
    }

    [Fact]
    public async Task Authentication_required_blocks_without_send()
    {
        var driver = new FakeDriver
        {
            LaunchFailure =
                new InvalidOperationException(
                    "CHATGPT_AUTH_REQUIRED"),
        };
        var store =
            new FakeStore(
                new WorkerSnapshot(
                    WorkerRuntimeState.IDLE,
                    null,
                    null,
                    null,
                    null,
                    null,
                    Assignment()));
        var loop = Loop(driver, store);

        var result =
            await loop.Start(
                Target(),
                CancellationToken.None);

        Assert.Equal(
            WorkerRuntimeState.BLOCKED,
            result.State);
        Assert.Equal(
            "CHATGPT_AUTH_REQUIRED",
            result.Message);
        Assert.Empty(driver.Sent);
    }

    [Fact]
    public void Worker_snapshot_has_no_parallel_task_database()
    {
        var properties =
            typeof(WorkerSnapshot)
                .GetProperties()
                .Select(property =>
                    property.Name)
                .ToArray();

        Assert.DoesNotContain(
            properties,
            name =>
                name.Contains(
                    "Notion",
                    StringComparison
                        .OrdinalIgnoreCase) ||
                name.Contains(
                    "Checklist",
                    StringComparison
                        .OrdinalIgnoreCase) ||
                name.Contains(
                    "TaskQueue",
                    StringComparison
                        .OrdinalIgnoreCase));
        Assert.Contains(
            nameof(
                WorkerSnapshot.Assignment),
            properties);
    }

    private static WorkerLoop Loop(
        FakeDriver driver,
        FakeStore store) =>
        new(
            driver,
            store,
            new WorkerPolicy(
                MinimumDispatchInterval:
                    TimeSpan.Zero),
            Worker);

    private static async Task StartAndAssign(
        WorkerLoop loop,
        FakeDriver driver)
    {
        await loop.Start(
            Target(),
            CancellationToken.None);
        var assigned =
            await loop.Wake(
                AssignmentEvent(
                    "delivery-assignment"),
                CancellationToken.None);
        Assert.True(assigned.PromptSent);
        Assert.Single(driver.Sent);
    }

    private static WorkerWakeEvent
        AssignmentEvent(
            string delivery,
            PullRequestAssignment? assignment =
                null) =>
        new(
            WorkerWakeReason.GitHubPullRequest,
            delivery,
            DateTimeOffset.UtcNow,
            Assignment:
                assignment ??
                Assignment(),
            PullRequestNumber:
                (assignment ??
                 Assignment()).Number);

    private static WorkerWakeEvent PushEvent(
        string delivery,
        string gitHubRef) =>
        new(
            WorkerWakeReason.GitHubPush,
            delivery,
            DateTimeOffset.UtcNow,
            GitHubRef: gitHubRef);

    private static PullRequestAssignment
        Assignment() =>
        new(
            101,
            "feat/pr-a",
            Sha('a'));

    private static string Sha(char value) =>
        new(value, 40);

    private static EngineeringTarget Target() =>
        new(
            "BKE Worker",
            "Worker Engineering");

    private sealed class FakeStore(
        WorkerSnapshot? initial = null)
        : IWorkerStateStore
    {
        public WorkerSnapshot Snapshot
        {
            get;
            private set;
        } =
            initial ??
            WorkerSnapshot.Empty;

        public Task<WorkerSnapshot> Load(
            CancellationToken cancellationToken) =>
            Task.FromResult(Snapshot);

        public Task Save(
            WorkerSnapshot snapshot,
            CancellationToken cancellationToken)
        {
            Snapshot = snapshot;
            return Task.CompletedTask;
        }
    }

    private sealed class FakeDriver :
        IChatGPTDriver
    {
        public List<string> Sent { get; } = [];
        public List<ContextTarget> Opened { get; } = [];
        public int LaunchCalls { get; private set; }
        public bool CanSend { get; set; } = true;
        public Exception? LaunchFailure { get; set; }

        public Task Launch(
            CancellationToken cancellationToken)
        {
            LaunchCalls++;
            return LaunchFailure is null
                ? Task.CompletedTask
                : Task.FromException(
                    LaunchFailure);
        }

        public Task<IReadOnlyList<ContextTarget>>
            GetAvailableContexts(
                CancellationToken cancellationToken) =>
            Task.FromResult<
                IReadOnlyList<ContextTarget>>([]);

        public Task OpenContext(
            ContextTarget target,
            CancellationToken cancellationToken)
        {
            Opened.Add(target);
            return Task.CompletedTask;
        }

        public Task<IReadOnlyList<
            ReasoningProfile>>
            GetAvailableReasoningProfiles(
                CancellationToken cancellationToken) =>
            Task.FromResult<
                IReadOnlyList<ReasoningProfile>>(
                [ReasoningProfile.HIGH]);

        public Task SetReasoning(
            ReasoningProfile profile,
            CancellationToken cancellationToken) =>
            Task.CompletedTask;

        public Task<ReasoningProfile>
            GetCurrentReasoning(
                CancellationToken cancellationToken) =>
            Task.FromResult(
                ReasoningProfile.HIGH);

        public Task Send(
            string instruction,
            CancellationToken cancellationToken)
        {
            Sent.Add(instruction);
            return Task.CompletedTask;
        }

        public Task<ExecutionState>
            GetExecutionState(
                CancellationToken cancellationToken) =>
            Task.FromResult(
                new ExecutionState(
                    !CanSend,
                    CanSend,
                    false));

        public Task<string?>
            GetLatestResponse(
                CancellationToken cancellationToken) =>
            Task.FromResult<string?>(null);

        public Task<bool>
            CanSendNextTurn(
                CancellationToken cancellationToken) =>
            Task.FromResult(CanSend);
    }
}
