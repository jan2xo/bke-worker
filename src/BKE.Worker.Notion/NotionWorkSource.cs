using BKE.Worker.Core;

namespace BKE.Worker.Notion;

public sealed class NotionWorkSource(
    INotionChecklistClient client,
    string pageIdOrUrl) : IWorkSource
{
    private readonly string _pageId = NotionChecklistClient.NormalizeNotionId(pageIdOrUrl);

    public async Task<EngineeringTarget?> GetNextEngineeringTarget(CancellationToken cancellationToken)
    {
        var tasks = await client.GetTasks(_pageId, includeChecked: false, cancellationToken);
        if (tasks.Count == 0)
            return null;

        var notionTarget = await client.GetExecutionTarget(_pageId, cancellationToken);
        var target = new EngineeringTarget(
            notionTarget.Project,
            notionTarget.Chat,
            _pageId,
            Instruction: WorkerPrompts.ContinueFromNotionChecklist,
            Surface: ChatGptExecutionSurface.Chat,
            OverrideUrl: notionTarget.OverrideUrl);

        // Fail closed here so malformed Notion target metadata never reaches browser movement.
        _ = target.ResolveContextTarget();
        return target;
    }

    public async Task<WorkItem?> GetNextRunnableTask(CancellationToken cancellationToken)
    {
        var target = await GetNextEngineeringTarget(cancellationToken);
        if (target is null)
            return null;

        return new WorkItem(
            target.NotionPageId,
            target.Instruction,
            target.ResolveContextTarget(),
            target.ReasoningProfile);
    }

    public Task<bool> ClaimTask(WorkItem task, CancellationToken cancellationToken) =>
        Task.FromResult(string.Equals(task.Id, _pageId, StringComparison.OrdinalIgnoreCase));

    public Task CompleteTask(WorkItem task, string result, CancellationToken cancellationToken) =>
        throw new NotSupportedException("NOTION_CHECKLIST_IS_COMPLETION_TRUTH");

    public Task FailTask(WorkItem task, string reason, bool ownerDecision, CancellationToken cancellationToken) =>
        throw new NotSupportedException("NOTION_CHECKLIST_IS_COMPLETION_TRUTH");
}
