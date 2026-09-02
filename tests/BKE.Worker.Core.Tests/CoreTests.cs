global using Xunit;
using BKE.Worker.Core;

namespace BKE.Worker.Core.Tests;

public class CoreTests
{
    [Fact]
    public void Default_reasoning_is_high() =>
        Assert.Equal(ReasoningProfile.HIGH, new WorkerPolicy().DefaultReasoning);

    [Theory]
    [InlineData(ContextTargetType.RecentChat)]
    [InlineData(ContextTargetType.ProjectChat)]
    [InlineData(ContextTargetType.NewChat)]
    public void Context_targets_are_supported(ContextTargetType type) =>
        Assert.Equal(type, new ContextTarget(type).Type);

    [Fact]
    public void Default_resolves_to_policy() =>
        Assert.Equal(
            ReasoningProfile.HIGH,
            new ReasoningResolver().Resolve(ReasoningProfile.DEFAULT, new WorkerPolicy()));

    [Fact]
    public async Task Start_dispatches_first_unchecked_gate_without_polling_execution_state()
    {
        var driver = new FakeDriver();
        var checklist = new FakeChecklist(new ChecklistReconciliation(
            null,
            new ChecklistGate("gate-1", "Gate 1", false),
            false));
        var store = new FakeStore();
        var loop = new WorkerLoop(driver, checklist, store, new WorkerPolicy(MinimumDispatchInterval: TimeSpan.Zero));

        var result = await loop.Start(Target(), CancellationToken.None);

        Assert.True(result.PromptSent);
        Assert.Equal(WorkerRuntimeState.WAITING_FOR_ENGINEERING_EVENT, result.State);
        Assert.Equal("gate-1", store.Snapshot.CurrentChecklistIdentifier);
        Assert.Single(driver.Sent);
        Assert.Equal(WorkerPrompts.ContinueFromNotionChecklist, driver.Sent[0]);
        Assert.Equal(0, driver.ExecutionStateCalls);
    }

    [Fact]
    public async Task Unchecked_gate_after_github_wake_continues_same_conversation_when_idle()
    {
        var driver = new FakeDriver();
        var checklist = new FakeChecklist(new ChecklistReconciliation(
            null,
            new ChecklistGate("gate-1", "Gate 1", false),
            false));
        var store = new FakeStore();
        var loop = new WorkerLoop(driver, checklist, store, new WorkerPolicy(MinimumDispatchInterval: TimeSpan.Zero));
        await loop.Start(Target(), CancellationToken.None);

        checklist.Reconciliation = new ChecklistReconciliation(
            new ChecklistGate("gate-1", "Gate 1", false),
            new ChecklistGate("gate-1", "Gate 1", false),
            false);

        var result = await loop.Wake(WorkerWakeReason.GitHubPush, "delivery-1", CancellationToken.None);

        Assert.True(result.PromptSent);
        Assert.Equal(2, driver.Sent.Count);
        Assert.Equal("delivery-1", store.Snapshot.LastGitHubDeliveryId);
    }

    [Fact]
    public async Task Checked_gate_advances_to_next_unchecked_gate()
    {
        var driver = new FakeDriver();
        var checklist = new FakeChecklist(new ChecklistReconciliation(
            null,
            new ChecklistGate("gate-1", "Gate 1", false),
            false));
        var store = new FakeStore();
        var loop = new WorkerLoop(driver, checklist, store, new WorkerPolicy(MinimumDispatchInterval: TimeSpan.Zero));
        await loop.Start(Target(), CancellationToken.None);

        checklist.Reconciliation = new ChecklistReconciliation(
            new ChecklistGate("gate-1", "Gate 1", true),
            new ChecklistGate("gate-2", "Gate 2", false),
            false);

        var result = await loop.Wake(WorkerWakeReason.GitHubPush, "delivery-2", CancellationToken.None);

        Assert.True(result.PromptSent);
        Assert.Equal("gate-2", store.Snapshot.CurrentChecklistIdentifier);
    }

    [Fact]
    public async Task Duplicate_github_delivery_is_ignored()
    {
        var driver = new FakeDriver();
        var checklist = new FakeChecklist(new ChecklistReconciliation(
            null,
            new ChecklistGate("gate-1", "Gate 1", false),
            false));
        var store = new FakeStore();
        var loop = new WorkerLoop(driver, checklist, store, new WorkerPolicy(MinimumDispatchInterval: TimeSpan.Zero));
        await loop.Start(Target(), CancellationToken.None);
        await loop.Wake(WorkerWakeReason.GitHubPush, "same-delivery", CancellationToken.None);

        var duplicate = await loop.Wake(WorkerWakeReason.GitHubPush, "same-delivery", CancellationToken.None);

        Assert.True(duplicate.DuplicateIgnored);
        Assert.Equal(2, driver.Sent.Count);
    }

    [Fact]
    public async Task Complete_notion_checklist_ends_loop_without_another_prompt()
    {
        var driver = new FakeDriver();
        var checklist = new FakeChecklist(new ChecklistReconciliation(
            null,
            new ChecklistGate("gate-1", "Gate 1", false),
            false));
        var store = new FakeStore();
        var loop = new WorkerLoop(driver, checklist, store, new WorkerPolicy(MinimumDispatchInterval: TimeSpan.Zero));
        await loop.Start(Target(), CancellationToken.None);

        checklist.Reconciliation = new ChecklistReconciliation(
            new ChecklistGate("gate-1", "Gate 1", true),
            null,
            true);

        var result = await loop.Wake(WorkerWakeReason.GitHubPush, "delivery-final", CancellationToken.None);

        Assert.False(result.PromptSent);
        Assert.Equal(WorkerRuntimeState.COMPLETE, result.State);
        Assert.Single(driver.Sent);
    }

    private static EngineeringTarget Target() => new("DUMP", "Engineering", "notion-page");

    private sealed class FakeChecklist(ChecklistReconciliation reconciliation) : IChecklistReconciler
    {
        public ChecklistReconciliation Reconciliation { get; set; } = reconciliation;

        public Task<ChecklistReconciliation> Reconcile(
            string notionPageId,
            string? currentChecklistIdentifier,
            CancellationToken cancellationToken) => Task.FromResult(Reconciliation);
    }

    private sealed class FakeStore : IWorkerStateStore
    {
        public WorkerSnapshot Snapshot { get; private set; } = WorkerSnapshot.Empty;
        public Task<WorkerSnapshot> Load(CancellationToken cancellationToken) => Task.FromResult(Snapshot);
        public Task Save(WorkerSnapshot snapshot, CancellationToken cancellationToken)
        {
            Snapshot = snapshot;
            return Task.CompletedTask;
        }
    }

    private sealed class FakeDriver : IChatGPTDriver
    {
        public List<string> Sent { get; } = [];
        public int ExecutionStateCalls { get; private set; }
        public bool CanSend { get; set; } = true;

        public Task Launch(CancellationToken cancellationToken) => Task.CompletedTask;
        public Task<IReadOnlyList<ContextTarget>> GetAvailableContexts(CancellationToken cancellationToken) =>
            Task.FromResult<IReadOnlyList<ContextTarget>>([]);
        public Task OpenContext(ContextTarget target, CancellationToken cancellationToken) => Task.CompletedTask;
        public Task<IReadOnlyList<ReasoningProfile>> GetAvailableReasoningProfiles(CancellationToken cancellationToken) =>
            Task.FromResult<IReadOnlyList<ReasoningProfile>>([ReasoningProfile.HIGH]);
        public Task SetReasoning(ReasoningProfile profile, CancellationToken cancellationToken) => Task.CompletedTask;
        public Task<ReasoningProfile> GetCurrentReasoning(CancellationToken cancellationToken) =>
            Task.FromResult(ReasoningProfile.HIGH);
        public Task Send(string instruction, CancellationToken cancellationToken)
        {
            Sent.Add(instruction);
            return Task.CompletedTask;
        }
        public Task<ExecutionState> GetExecutionState(CancellationToken cancellationToken)
        {
            ExecutionStateCalls++;
            return Task.FromResult(new ExecutionState(false, true, false));
        }
        public Task<string?> GetLatestResponse(CancellationToken cancellationToken) => Task.FromResult<string?>(null);
        public Task<bool> CanSendNextTurn(CancellationToken cancellationToken) => Task.FromResult(CanSend);
    }
}
