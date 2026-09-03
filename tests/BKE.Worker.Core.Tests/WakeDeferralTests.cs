using BKE.Worker.Core;
using Xunit;

namespace BKE.Worker.Core.Tests;

public sealed class WakeDeferralTests
{
    [Fact]
    public async Task Github_wake_defers_when_chatgpt_is_not_safe_and_recovery_timer_retries_when_idle()
    {
        var driver = new FakeDriver();
        var checklist = new FakeChecklist(new ChecklistReconciliation(
            null,
            new ChecklistGate("gate-1", "Gate 1", false),
            false));
        var store = new FakeStore();
        var loop = new WorkerLoop(
            driver,
            checklist,
            store,
            new WorkerPolicy(MinimumDispatchInterval: TimeSpan.Zero));
        var target = new EngineeringTarget("DUMP", "Engineering", "notion-page");

        var initial = await loop.Start(target, CancellationToken.None);
        Assert.True(initial.PromptSent);
        Assert.Single(driver.Sent);

        driver.CanSend = false;
        var push = await loop.Wake(
            WorkerWakeReason.GitHubPush,
            "delivery-busy",
            CancellationToken.None);

        Assert.False(push.PromptSent);
        Assert.Equal("WAKE_DEFERRED_CHATGPT_NOT_SAFE_TO_INTERRUPT", push.Message);
        Assert.Equal(WorkerRuntimeState.WAITING_FOR_ENGINEERING_EVENT, push.State);
        Assert.Equal("delivery-busy", store.Snapshot.LastGitHubDeliveryId);
        Assert.Single(driver.Sent);

        driver.CanSend = true;
        var recovery = await loop.Wake(
            WorkerWakeReason.RecoveryTimer,
            null,
            CancellationToken.None);

        Assert.True(recovery.PromptSent);
        Assert.Equal(WorkerRuntimeState.WAITING_FOR_ENGINEERING_EVENT, recovery.State);
        Assert.Equal(2, driver.Sent.Count);
        Assert.Equal(WorkerPrompts.ContinueFromNotionChecklist, driver.Sent[1]);
        Assert.Equal("delivery-busy", store.Snapshot.LastGitHubDeliveryId);
    }

    private sealed class FakeChecklist(ChecklistReconciliation reconciliation) : IChecklistReconciler
    {
        public ChecklistReconciliation Reconciliation { get; set; } = reconciliation;

        public Task<ChecklistReconciliation> Reconcile(
            string notionPageId,
            string? currentChecklistIdentifier,
            CancellationToken cancellationToken) =>
            Task.FromResult(Reconciliation);
    }

    private sealed class FakeStore : IWorkerStateStore
    {
        public WorkerSnapshot Snapshot { get; private set; } = WorkerSnapshot.Empty;

        public Task<WorkerSnapshot> Load(CancellationToken cancellationToken) =>
            Task.FromResult(Snapshot);

        public Task Save(WorkerSnapshot snapshot, CancellationToken cancellationToken)
        {
            Snapshot = snapshot;
            return Task.CompletedTask;
        }
    }

    private sealed class FakeDriver : IChatGPTDriver
    {
        public List<string> Sent { get; } = [];
        public bool CanSend { get; set; } = true;

        public Task Launch(CancellationToken cancellationToken) => Task.CompletedTask;

        public Task<IReadOnlyList<ContextTarget>> GetAvailableContexts(CancellationToken cancellationToken) =>
            Task.FromResult<IReadOnlyList<ContextTarget>>([]);

        public Task OpenContext(ContextTarget target, CancellationToken cancellationToken) =>
            Task.CompletedTask;

        public Task<IReadOnlyList<ReasoningProfile>> GetAvailableReasoningProfiles(CancellationToken cancellationToken) =>
            Task.FromResult<IReadOnlyList<ReasoningProfile>>([ReasoningProfile.HIGH]);

        public Task SetReasoning(ReasoningProfile profile, CancellationToken cancellationToken) =>
            Task.CompletedTask;

        public Task<ReasoningProfile> GetCurrentReasoning(CancellationToken cancellationToken) =>
            Task.FromResult(ReasoningProfile.HIGH);

        public Task Send(string instruction, CancellationToken cancellationToken)
        {
            Sent.Add(instruction);
            return Task.CompletedTask;
        }

        public Task<ExecutionState> GetExecutionState(CancellationToken cancellationToken) =>
            Task.FromResult(new ExecutionState(!CanSend, CanSend, false));

        public Task<string?> GetLatestResponse(CancellationToken cancellationToken) =>
            Task.FromResult<string?>(null);

        public Task<bool> CanSendNextTurn(CancellationToken cancellationToken) =>
            Task.FromResult(CanSend);
    }
}
