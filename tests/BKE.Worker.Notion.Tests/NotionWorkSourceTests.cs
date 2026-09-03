using BKE.Worker.Core;

namespace BKE.Worker.Notion.Tests;

public sealed class NotionWorkSourceTests
{
    private const string PageId = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
    private const string WorkerUrl = "https://chatgpt.com/g/g-p-project/c/worker-engineering";

    [Fact]
    public async Task Worker_configured_override_is_used_for_notion_work()
    {
        var source = Source(new EngineeringTarget(
            string.Empty,
            string.Empty,
            PageId,
            OverrideUrl: WorkerUrl));

        var target = await source.GetNextEngineeringTarget(CancellationToken.None);

        Assert.NotNull(target);
        var context = target!.ResolveContextTarget();
        Assert.Equal(ContextTargetType.OverrideLink, context.Type);
        Assert.Equal(WorkerUrl, context.OverrideUrl);
        Assert.Equal(PageId, target.NotionPageId);
    }

    [Fact]
    public async Task Notion_target_metadata_is_not_read_or_allowed_to_redirect_worker()
    {
        var client = new FakeClient(
            [new NotionChecklistTask("gate-1", "Gate 1", false, false)]);
        var source = new NotionWorkSource(
            client,
            PageId,
            new EngineeringTarget(
                string.Empty,
                string.Empty,
                PageId,
                OverrideUrl: WorkerUrl));

        var target = await source.GetNextEngineeringTarget(CancellationToken.None);

        Assert.NotNull(target);
        Assert.Equal(0, client.ExecutionTargetCalls);
        Assert.Equal(WorkerUrl, target!.OverrideUrl);
    }

    [Fact]
    public async Task Configured_project_chat_remains_worker_owned_when_used()
    {
        var source = Source(new EngineeringTarget(
            "BKE Worker",
            "Worker Engineering",
            PageId));

        var target = await source.GetNextEngineeringTarget(CancellationToken.None);

        Assert.NotNull(target);
        Assert.Equal(ContextTargetType.ProjectChat, target!.ResolveContextTarget().Type);
        Assert.Equal("BKE Worker", target.Project);
        Assert.Equal("Worker Engineering", target.Conversation);
    }

    [Fact]
    public async Task Ambiguous_worker_configuration_fails_closed()
    {
        var source = Source(new EngineeringTarget(
            "BKE Worker",
            "Worker Engineering",
            PageId,
            OverrideUrl: WorkerUrl));

        var exception = await Assert.ThrowsAsync<InvalidOperationException>(() =>
            source.GetNextEngineeringTarget(CancellationToken.None));

        Assert.Equal("CHATGPT_TARGET_AMBIGUOUS", exception.Message);
    }

    [Fact]
    public async Task No_unchecked_notion_task_means_no_runnable_engineering_target()
    {
        var client = new FakeClient([]);
        var source = new NotionWorkSource(
            client,
            PageId,
            new EngineeringTarget(
                string.Empty,
                string.Empty,
                PageId,
                OverrideUrl: WorkerUrl));

        var target = await source.GetNextEngineeringTarget(CancellationToken.None);

        Assert.Null(target);
    }

    private static NotionWorkSource Source(EngineeringTarget target) =>
        new(
            new FakeClient([new NotionChecklistTask("gate-1", "Gate 1", false, false)]),
            PageId,
            target);

    private sealed class FakeClient(
        IReadOnlyList<NotionChecklistTask> tasks) : INotionChecklistClient
    {
        public int ExecutionTargetCalls { get; private set; }

        public Task<IReadOnlyList<NotionPageSummary>> GetSharedPages(CancellationToken cancellationToken) =>
            Task.FromResult<IReadOnlyList<NotionPageSummary>>([]);

        public Task<IReadOnlyList<NotionChecklistTask>> GetTasks(
            string pageIdOrUrl,
            bool includeChecked,
            CancellationToken cancellationToken) =>
            Task.FromResult(tasks);

        public Task<NotionExecutionTarget> GetExecutionTarget(
            string pageIdOrUrl,
            CancellationToken cancellationToken)
        {
            ExecutionTargetCalls++;
            throw new InvalidOperationException("NOTION_TARGET_METADATA_MUST_NOT_BE_USED_BY_AUTONOMOUS_WORKER");
        }
    }
}
