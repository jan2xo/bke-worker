using BKE.Worker.Core;

namespace BKE.Worker.Notion;

public sealed class NotionWorkSource(
    INotionChecklistClient client,
    string pageIdOrUrl) : IWorkSource
{
    private readonly string _pageIdOrUrl = pageIdOrUrl;

    public async Task<EngineeringTarget?> GetNextEngineeringTarget(CancellationToken cancellationToken)
    {
        var pageId = NotionChecklistClient.NormalizeNotionId(_pageIdOrUrl);
        var tasks = await client.GetTasks(pageId, includeChecked: false, cancellationToken);
        if (tasks.Count == 0)
            return null;

        var notionTarget = await client.GetExecutionTarget(pageId, cancellationToken);
        var target = new EngineeringTarget(
            notionTarget.Project,
            notionTarget.Chat,
            pageId,
            Instruction: WorkerPrompts.ContinueFromNotionChecklist,
            Surface: ChatGptExecutionSurface.Chat,
            OverrideUrl: notionTarget.OverrideUrl);

        // Fail closed here so malformed Notion target metadata never reaches browser movement.
        _ = target.ResolveContextTarget();
        ValidateOverride(target);
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

    public Task<bool> ClaimTask(WorkItem task, CancellationToken cancellationToken)
    {
        var pageId = NotionChecklistClient.NormalizeNotionId(_pageIdOrUrl);
        return Task.FromResult(string.Equals(task.Id, pageId, StringComparison.OrdinalIgnoreCase));
    }

    public Task CompleteTask(WorkItem task, string result, CancellationToken cancellationToken) =>
        throw new NotSupportedException("NOTION_CHECKLIST_IS_COMPLETION_TRUTH");

    public Task FailTask(WorkItem task, string reason, bool ownerDecision, CancellationToken cancellationToken) =>
        throw new NotSupportedException("NOTION_CHECKLIST_IS_COMPLETION_TRUTH");

    private static void ValidateOverride(EngineeringTarget target)
    {
        if (!target.UsesOverrideLink)
            return;

        if (!Uri.TryCreate(target.OverrideUrl, UriKind.Absolute, out var uri) ||
            !string.Equals(uri.Scheme, Uri.UriSchemeHttps, StringComparison.OrdinalIgnoreCase) ||
            !(string.Equals(uri.Host, "chatgpt.com", StringComparison.OrdinalIgnoreCase) ||
              string.Equals(uri.Host, "www.chatgpt.com", StringComparison.OrdinalIgnoreCase)))
        {
            throw new InvalidOperationException("CHATGPT_OVERRIDE_URL_INVALID");
        }

        var segments = uri.AbsolutePath
            .Split('/', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries);
        for (var index = 0; index < segments.Length - 1; index++)
        {
            if (string.Equals(segments[index], "c", StringComparison.OrdinalIgnoreCase) &&
                !string.IsNullOrWhiteSpace(segments[index + 1]))
            {
                return;
            }
        }

        throw new InvalidOperationException("CHATGPT_OVERRIDE_URL_INVALID");
    }
}
