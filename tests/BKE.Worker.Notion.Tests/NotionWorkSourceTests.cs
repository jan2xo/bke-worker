using BKE.Worker.Core;

namespace BKE.Worker.Notion.Tests;

public sealed class NotionWorkSourceTests
{
    private const string PageId = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";

    [Fact]
    public async Task Project_and_chat_are_selected_from_notion_target_metadata()
    {
        var source = Source(new NotionExecutionTarget("BKE Worker", "Worker Engineering", null));

        var target = await source.GetNextEngineeringTarget(CancellationToken.None);

        Assert.NotNull(target);
        Assert.Equal(ContextTargetType.ProjectChat, target!.ResolveContextTarget().Type);
        Assert.Equal("BKE Worker", target.Project);
        Assert.Equal("Worker Engineering", target.Conversation);
        Assert.Equal(PageId, target.NotionPageId);
    }

    [Fact]
    public async Task Override_link_is_selected_without_project_chat_fallback()
    {
        const string url = "https://chatgpt.com/g/g-p-project/c/conversation";
        var source = Source(new NotionExecutionTarget(string.Empty, string.Empty, url));

        var target = await source.GetNextEngineeringTarget(CancellationToken.None);

        Assert.NotNull(target);
        var context = target!.ResolveContextTarget();
        Assert.Equal(ContextTargetType.OverrideLink, context.Type);
        Assert.Equal(url, context.OverrideUrl);
    }

    [Fact]
    public async Task Missing_explicit_target_selects_new_chat()
    {
        var source = Source(new NotionExecutionTarget(string.Empty, string.Empty, null));

        var target = await source.GetNextEngineeringTarget(CancellationToken.None);

        Assert.NotNull(target);
        Assert.Equal(ContextTargetType.NewChat, target!.ResolveContextTarget().Type);
    }

    [Fact]
    public async Task Ambiguous_explicit_targets_fail_closed()
    {
        var source = Source(new NotionExecutionTarget(
            "BKE Worker",
            "Worker Engineering",
            "https://chatgpt.com/c/conversation"));

        var exception = await Assert.ThrowsAsync<InvalidOperationException>(() =>
            source.GetNextEngineeringTarget(CancellationToken.None));

        Assert.Equal("CHATGPT_TARGET_AMBIGUOUS", exception.Message);
    }

    [Fact]
    public async Task No_unchecked_notion_task_means_no_runnable_engineering_target()
    {
        var client = new FakeClient(
            new NotionExecutionTarget("BKE Worker", "Worker Engineering", null),
            []);
        var source = new NotionWorkSource(client, PageId);

        var target = await source.GetNextEngineeringTarget(CancellationToken.None);

        Assert.Null(target);
    }

    private static NotionWorkSource Source(NotionExecutionTarget target) =>
        new(
            new FakeClient(
                target,
                [new NotionChecklistTask("gate-1", "Gate 1", false, false)]),
            PageId);

    private sealed class FakeClient(
        NotionExecutionTarget target,
        IReadOnlyList<NotionChecklistTask> tasks) : INotionChecklistClient
    {
        public Task<IReadOnlyList<NotionPageSummary>> GetSharedPages(CancellationToken cancellationToken) =>
            Task.FromResult<IReadOnlyList<NotionPageSummary>>([]);

        public Task<IReadOnlyList<NotionChecklistTask>> GetTasks(
            string pageIdOrUrl,
            bool includeChecked,
            CancellationToken cancellationToken) =>
            Task.FromResult(tasks);

        public Task<NotionExecutionTarget> GetExecutionTarget(
            string pageIdOrUrl,
            CancellationToken cancellationToken) =>
            Task.FromResult(target);
    }
}
