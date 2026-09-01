using BKE.Worker.Core;
namespace BKE.Worker.Notion;
public sealed class NotionWorkSource : IWorkSource
{
    public Task<WorkItem?> GetNextRunnableTask(CancellationToken cancellationToken) => throw new NotImplementedException("Notion adapter is scaffold-only.");
    public Task<bool> ClaimTask(WorkItem task, CancellationToken cancellationToken) => throw new NotImplementedException();
    public Task CompleteTask(WorkItem task, string result, CancellationToken cancellationToken) => throw new NotImplementedException();
    public Task FailTask(WorkItem task, string reason, bool ownerDecision, CancellationToken cancellationToken) => throw new NotImplementedException();
}
