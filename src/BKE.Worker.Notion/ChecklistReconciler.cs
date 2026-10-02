using BKE.Worker.Core;

namespace BKE.Worker.Notion;

public sealed class ChecklistReconciler(INotionChecklistClient client) : IChecklistReconciler
{
    public async Task<ChecklistReconciliation> Reconcile(
        string notionPageId,
        string? currentChecklistIdentifier,
        CancellationToken cancellationToken)
    {
        var tasks = await client.GetTasks(notionPageId, includeChecked: true, cancellationToken);
        var current = string.IsNullOrWhiteSpace(currentChecklistIdentifier)
            ? null
            : tasks.FirstOrDefault(task =>
                string.Equals(task.BlockId, currentChecklistIdentifier, StringComparison.Ordinal));
        var firstUnchecked = tasks.FirstOrDefault(task => !task.Checked);

        return new ChecklistReconciliation(
            current is null ? null : new ChecklistGate(current.BlockId, current.Text, current.Checked),
            firstUnchecked is null
                ? null
                : new ChecklistGate(firstUnchecked.BlockId, firstUnchecked.Text, firstUnchecked.Checked),
            firstUnchecked is null);
    }
}
