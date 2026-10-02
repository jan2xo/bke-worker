using BKE.Worker.Core;
using Xunit;

namespace BKE.Worker.Core.Tests;

public sealed class WakeDeferralTests
{
    [Fact]
    public async Task Busy_push_records_delivery_and_heartbeat_retries_when_idle()
    {
        var driver = new FakeDriver();
        var store = new FakeStore();
        var loop = new WorkerLoop(
            driver,
            store,
            new WorkerPolicy(
                MinimumDispatchInterval:
                    TimeSpan.Zero));
        var target =
            new EngineeringTarget(
                "BKE Worker",
                "Worker Engineering");

        var initial =
            await loop.Start(
                target,
                CancellationToken.None);
        Assert.True(initial.PromptSent);

        driver.CanSend = false;
        var push =
            await loop.Wake(
                WorkerWakeReason.GitHubPush,
                "delivery-busy",
                CancellationToken.None);

        Assert.False(push.PromptSent);
        Assert.Equal(
            "WAKE_DEFERRED_CHATGPT_NOT_SAFE_TO_INTERRUPT",
            push.Message);
        Assert.Equal(
            "delivery-busy",
            store.Snapshot.LastGitHubDeliveryId);
        Assert.Single(driver.Sent);

        driver.CanSend = true;
        var heartbeat =
            await loop.Wake(
                WorkerWakeReason.Heartbeat,
                null,
                CancellationToken.None);

        Assert.True(heartbeat.PromptSent);
        Assert.Equal(2, driver.Sent.Count);
        Assert.Equal(
            WorkerPrompts
                .ContinueAutonomousEngineering,
            driver.Sent[1]);
    }

    private sealed class FakeStore :
        IWorkerStateStore
    {
        public WorkerSnapshot Snapshot { get; private set; } =
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
        public bool CanSend { get; set; } = true;

        public Task Launch(
            CancellationToken cancellationToken) =>
            Task.CompletedTask;

        public Task<IReadOnlyList<ContextTarget>>
            GetAvailableContexts(
                CancellationToken cancellationToken) =>
            Task.FromResult<
                IReadOnlyList<ContextTarget>>([]);

        public Task OpenContext(
            ContextTarget target,
            CancellationToken cancellationToken) =>
            Task.CompletedTask;

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
