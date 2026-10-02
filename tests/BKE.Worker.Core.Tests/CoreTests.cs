global using Xunit;
using BKE.Worker.Core;

namespace BKE.Worker.Core.Tests;

public sealed class CoreTests
{
    [Fact]
    public void Default_reasoning_is_high() =>
        Assert.Equal(
            ReasoningProfile.HIGH,
            new WorkerPolicy().DefaultReasoning);

    [Fact]
    public void Autonomous_prompt_locks_GitHub_PR_execution_model()
    {
        var prompt =
            WorkerPrompts.ContinueAutonomousEngineering;

        Assert.Contains(
            "live GitHub state",
            prompt,
            StringComparison.Ordinal);
        Assert.Contains(
            "current main",
            prompt,
            StringComparison.Ordinal);
        Assert.Contains(
            "NEW PR",
            prompt,
            StringComparison.Ordinal);
        Assert.Contains(
            ".github/pull_request_template.md",
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
    public async Task Start_dispatches_locked_instruction_when_safe()
    {
        var driver = new FakeDriver();
        var store = new FakeStore();
        var loop = new WorkerLoop(
            driver,
            store,
            new WorkerPolicy(
                MinimumDispatchInterval:
                    TimeSpan.Zero));

        var result =
            await loop.Start(
                Target(),
                CancellationToken.None);

        Assert.True(result.PromptSent);
        Assert.Equal(
            WorkerRuntimeState
                .WAITING_FOR_ENGINEERING_EVENT,
            result.State);
        Assert.Single(driver.Sent);
        Assert.Equal(
            WorkerPrompts
                .ContinueAutonomousEngineering,
            driver.Sent[0]);
        Assert.Single(driver.Opened);
        Assert.NotNull(
            store.Snapshot.LastDispatchAt);
    }

    [Fact]
    public async Task Start_defers_when_chatgpt_is_not_safe()
    {
        var driver =
            new FakeDriver { CanSend = false };
        var store = new FakeStore();
        var loop = new WorkerLoop(
            driver,
            store,
            new WorkerPolicy(
                MinimumDispatchInterval:
                    TimeSpan.Zero));

        var result =
            await loop.Start(
                Target(),
                CancellationToken.None);

        Assert.False(result.PromptSent);
        Assert.Equal(
            "WAKE_DEFERRED_CHATGPT_NOT_SAFE_TO_INTERRUPT",
            result.Message);
        Assert.Equal(
            WorkerRuntimeState
                .WAITING_FOR_ENGINEERING_EVENT,
            store.Snapshot.State);
        Assert.Empty(driver.Sent);
    }

    [Fact]
    public async Task GitHub_push_continues_same_target_when_safe()
    {
        var driver = new FakeDriver();
        var store = new FakeStore();
        var loop = new WorkerLoop(
            driver,
            store,
            new WorkerPolicy(
                MinimumDispatchInterval:
                    TimeSpan.Zero));

        await loop.Start(
            Target(),
            CancellationToken.None);

        var result =
            await loop.Wake(
                WorkerWakeReason.GitHubPush,
                "delivery-1",
                CancellationToken.None);

        Assert.True(result.PromptSent);
        Assert.Equal(2, driver.Sent.Count);
        Assert.Equal(
            "delivery-1",
            store.Snapshot.LastGitHubDeliveryId);
        Assert.NotNull(store.Snapshot.LastWakeAt);
    }

    [Fact]
    public async Task Duplicate_GitHub_delivery_is_ignored()
    {
        var driver = new FakeDriver();
        var store = new FakeStore();
        var loop = new WorkerLoop(
            driver,
            store,
            new WorkerPolicy(
                MinimumDispatchInterval:
                    TimeSpan.Zero));

        await loop.Start(
            Target(),
            CancellationToken.None);
        await loop.Wake(
            WorkerWakeReason.GitHubPush,
            "same-delivery",
            CancellationToken.None);

        var duplicate =
            await loop.Wake(
                WorkerWakeReason.GitHubPush,
                "same-delivery",
                CancellationToken.None);

        Assert.True(duplicate.DuplicateIgnored);
        Assert.Equal(2, driver.Sent.Count);
    }

    [Theory]
    [InlineData(WorkerRuntimeState.DISPATCHING)]
    [InlineData(WorkerRuntimeState.CONTINUING)]
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
                    null));
        var loop = new WorkerLoop(
            driver,
            store,
            new WorkerPolicy(
                MinimumDispatchInterval:
                    TimeSpan.Zero));

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
                    "DISPATCH_OUTCOME_UNKNOWN_AFTER_RESTART"));
        var loop = new WorkerLoop(
            driver,
            store,
            new WorkerPolicy(
                MinimumDispatchInterval:
                    TimeSpan.Zero));

        var heartbeat =
            await loop.Wake(
                WorkerWakeReason.Heartbeat,
                null,
                CancellationToken.None);

        Assert.False(heartbeat.PromptSent);
        Assert.Equal(
            WorkerRuntimeState.BLOCKED,
            store.Snapshot.State);
        Assert.Empty(driver.Sent);

        var manual =
            await loop.Wake(
                WorkerWakeReason.Manual,
                null,
                CancellationToken.None);

        Assert.True(manual.PromptSent);
        Assert.Single(driver.Sent);
        Assert.Equal(
            WorkerRuntimeState
                .WAITING_FOR_ENGINEERING_EVENT,
            store.Snapshot.State);
    }

    [Fact]
    public async Task Work_surface_fails_closed_before_browser_activity()
    {
        var driver = new FakeDriver();
        var store = new FakeStore();
        var loop = new WorkerLoop(
            driver,
            store,
            new WorkerPolicy(
                MinimumDispatchInterval:
                    TimeSpan.Zero));

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
        var store = new FakeStore();
        var loop = new WorkerLoop(
            driver,
            store,
            new WorkerPolicy(
                MinimumDispatchInterval:
                    TimeSpan.Zero));

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
    public void Worker_snapshot_has_no_Notion_state()
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
                    StringComparison.OrdinalIgnoreCase) ||
                name.Contains(
                    "Checklist",
                    StringComparison.OrdinalIgnoreCase));
    }

    private static EngineeringTarget Target() =>
        new(
            "BKE Worker",
            "Worker Engineering");

    private sealed class FakeStore(
        WorkerSnapshot? initial = null)
        : IWorkerStateStore
    {
        public WorkerSnapshot Snapshot { get; private set; } =
            initial ?? WorkerSnapshot.Empty;

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

        public Task<IReadOnlyList<ReasoningProfile>>
            GetAvailableReasoningProfiles(
                CancellationToken cancellationToken) =>
            Task.FromResult<
                IReadOnlyList<ReasoningProfile>>(
                [ReasoningProfile.HIGH]);

        public Task SetReasoning(
            ReasoningProfile profile,
            CancellationToken cancellationToken) =>
            Task.CompletedTask;

        public Task<ReasoningProfile> GetCurrentReasoning(
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

        public Task<ExecutionState> GetExecutionState(
            CancellationToken cancellationToken) =>
            Task.FromResult(
                new ExecutionState(
                    !CanSend,
                    CanSend,
                    false));

        public Task<string?> GetLatestResponse(
            CancellationToken cancellationToken) =>
            Task.FromResult<string?>(null);

        public Task<bool> CanSendNextTurn(
            CancellationToken cancellationToken) =>
            Task.FromResult(CanSend);
    }
}
