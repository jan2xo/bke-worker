using BKE.Worker.Core;

namespace BKE.Worker.Notion.Tests;

public sealed class ChecklistReconcilerTests
{
    [Fact]
    public async Task Reconcile_uses_notion_order_and_checkbox_state_as_canonical_truth()
    {
        var client = new FakeClient([
            new NotionChecklistTask("gate-1", "Gate 1", true, false),
            new NotionChecklistTask("gate-2", "Gate 2", false, false),
            new NotionChecklistTask("gate-3", "Gate 3", false, false)
        ]);
        var reconciler = new ChecklistReconciler(client);

        var result = await reconciler.Reconcile("page", "gate-1", CancellationToken.None);

        Assert.False(result.AllComplete);
        Assert.True(result.CurrentGate?.Checked);
        Assert.Equal("gate-2", result.FirstUncheckedGate?.Id);
    }

    [Fact]
    public async Task Reconcile_reports_complete_only_when_no_unchecked_gate_exists()
    {
        var client = new FakeClient([
            new NotionChecklistTask("gate-1", "Gate 1", true, false)
        ]);
        var reconciler = new ChecklistReconciler(client);

        var result = await reconciler.Reconcile("page", "gate-1", CancellationToken.None);

        Assert.True(result.AllComplete);
        Assert.Null(result.FirstUncheckedGate);
    }

    private sealed class FakeClient(IReadOnlyList<NotionChecklistTask> tasks) : INotionChecklistClient
    {
        public Task<IReadOnlyList<NotionPageSummary>> GetSharedPages(CancellationToken cancellationToken) =>
            Task.FromResult<IReadOnlyList<NotionPageSummary>>([]);

        public Task<IReadOnlyList<NotionChecklistTask>> GetTasks(
            string pageIdOrUrl,
            bool includeChecked,
            CancellationToken cancellationToken) => Task.FromResult(tasks);

        public Task<NotionExecutionTarget> GetExecutionTarget(
            string pageIdOrUrl,
            CancellationToken cancellationToken) =>
            Task.FromResult(new NotionExecutionTarget(string.Empty, string.Empty, null));
    }
}
