namespace BKE.Worker.Core;

public sealed class WorkerLoop(
    IChatGPTDriver driver,
    IChecklistReconciler checklist,
    IWorkerStateStore stateStore,
    WorkerPolicy policy) : IWorkerLoop
{
    private const string DispatchOutcomeUnknown = "DISPATCH_OUTCOME_UNKNOWN_AFTER_RESTART";
    private const string ExecutionSurfaceMismatch = "CHATGPT_EXECUTION_SURFACE_MISMATCH";
    private const string LiveChatGptRequiresCdp = "LIVE_CHATGPT_REQUIRES_CDP_ATTACH";
    private const string CdpMustBeLoopback = "BROWSER_CDP_ENDPOINT_MUST_BE_LOOPBACK";
    private const string OverrideUrlInvalid = "CHATGPT_OVERRIDE_URL_INVALID";
    private readonly SemaphoreSlim _mutex = new(1, 1);

    public async Task<WorkerLoopResult> Start(EngineeringTarget target, CancellationToken cancellationToken)
    {
        ArgumentException.ThrowIfNullOrWhiteSpace(target.NotionPageId);
        if (!target.UsesOverrideLink)
        {
            ArgumentException.ThrowIfNullOrWhiteSpace(target.Project);
            ArgumentException.ThrowIfNullOrWhiteSpace(target.Conversation);
        }

        await _mutex.WaitAsync(cancellationToken);
        try
        {
            var existing = await stateStore.Load(cancellationToken);

            // DISPATCHING/CONTINUING persisted across process startup means the prior process
            // may have sent the browser instruction but died before it could persist WAITING.
            // Exactly-once delivery cannot be proven from local state alone, so fail closed
            // instead of risking a duplicate engineering turn.
            if (existing.State is WorkerRuntimeState.DISPATCHING or WorkerRuntimeState.CONTINUING)
            {
                var blocked = existing with
                {
                    State = WorkerRuntimeState.BLOCKED,
                    Failure = DispatchOutcomeUnknown
                };
                await stateStore.Save(blocked, cancellationToken);
                return new(blocked.State, false, false, DispatchOutcomeUnknown);
            }

            if (IsActive(existing.State))
            {
                if (existing.Target == target)
                    return new(existing.State, false, false, "ALREADY_ACTIVE");

                return new(existing.State, false, false, "ACTIVE_DISPATCH_EXISTS");
            }

            // The current autonomous engineering loop is intentionally Chat-only.
            // Work is a separate agentic execution surface and must never be selected as a fallback.
            if (target.Surface != ChatGptExecutionSurface.Chat)
            {
                var blocked = new WorkerSnapshot(
                    WorkerRuntimeState.BLOCKED,
                    target,
                    null,
                    existing.LastDispatchAt,
                    existing.LastGitHubDeliveryId,
                    existing.LastReconciliationAt,
                    ExecutionSurfaceMismatch);
                await stateStore.Save(blocked, cancellationToken);
                return new(blocked.State, false, false, ExecutionSurfaceMismatch);
            }

            // GUARD: authentication is checked before Notion reconciliation or any engineering movement.
            // OAuth/MFA/CAPTCHA are human-only. If ChatGPT is unauthenticated, stop immediately.
            var authenticationGuard = existing with
            {
                Target = target,
                Failure = null
            };
            try
            {
                await driver.Launch(cancellationToken);
            }
            catch (OperationCanceledException) when (cancellationToken.IsCancellationRequested)
            {
                throw;
            }
            catch (Exception ex)
            {
                return await Fail(authenticationGuard, ex, cancellationToken);
            }

            var reconciliation = await checklist.Reconcile(target.NotionPageId, null, cancellationToken);
            var reconciledAt = DateTimeOffset.UtcNow;
            if (reconciliation.AllComplete || reconciliation.FirstUncheckedGate is null)
            {
                var complete = new WorkerSnapshot(
                    WorkerRuntimeState.COMPLETE,
                    target,
                    null,
                    null,
                    existing.LastGitHubDeliveryId,
                    reconciledAt,
                    null);
                await stateStore.Save(complete, cancellationToken);
                return new(complete.State, false, false, "NOTION_CHECKLIST_COMPLETE");
            }

            var dispatching = new WorkerSnapshot(
                WorkerRuntimeState.DISPATCHING,
                target,
                reconciliation.FirstUncheckedGate.Id,
                existing.LastDispatchAt,
                existing.LastGitHubDeliveryId,
                reconciledAt,
                null);
            await stateStore.Save(dispatching, cancellationToken);

            return await Dispatch(dispatching, target.Instruction, cancellationToken);
        }
        finally
        {
            _mutex.Release();
        }
    }

    public async Task<WorkerLoopResult> Wake(
        WorkerWakeReason reason,
        string? deliveryId,
        CancellationToken cancellationToken)
    {
        await _mutex.WaitAsync(cancellationToken);
        try
        {
            var snapshot = await stateStore.Load(cancellationToken);

            if (!string.IsNullOrWhiteSpace(deliveryId) &&
                string.Equals(snapshot.LastGitHubDeliveryId, deliveryId, StringComparison.Ordinal))
            {
                return new(snapshot.State, false, true, "DUPLICATE_GITHUB_DELIVERY");
            }

            if (!IsActive(snapshot.State) || snapshot.Target is null)
            {
                if (!string.IsNullOrWhiteSpace(deliveryId))
                {
                    snapshot = snapshot with { LastGitHubDeliveryId = deliveryId };
                    await stateStore.Save(snapshot, cancellationToken);
                }

                return new(snapshot.State, false, false, "NO_ACTIVE_ENGINEERING_LOOP");
            }

            if (snapshot.Target.Surface != ChatGptExecutionSurface.Chat)
            {
                var blocked = snapshot with
                {
                    State = WorkerRuntimeState.BLOCKED,
                    LastGitHubDeliveryId = string.IsNullOrWhiteSpace(deliveryId)
                        ? snapshot.LastGitHubDeliveryId
                        : deliveryId,
                    Failure = ExecutionSurfaceMismatch
                };
                await stateStore.Save(blocked, cancellationToken);
                return new(blocked.State, false, false, ExecutionSurfaceMismatch);
            }

            var authenticationGuard = snapshot with
            {
                LastGitHubDeliveryId = string.IsNullOrWhiteSpace(deliveryId)
                    ? snapshot.LastGitHubDeliveryId
                    : deliveryId,
                Failure = null
            };

            // GUARD: no webhook/recovery wake may reconcile Notion while ChatGPT is unauthenticated.
            try
            {
                await driver.Launch(cancellationToken);
            }
            catch (OperationCanceledException) when (cancellationToken.IsCancellationRequested)
            {
                throw;
            }
            catch (Exception ex)
            {
                return await Fail(authenticationGuard, ex, cancellationToken);
            }

            var reconciling = authenticationGuard with
            {
                State = WorkerRuntimeState.RECONCILING,
                Failure = null
            };
            await stateStore.Save(reconciling, cancellationToken);

            ChecklistReconciliation reconciliation;
            try
            {
                reconciliation = await checklist.Reconcile(
                    reconciling.Target.NotionPageId,
                    reconciling.CurrentChecklistIdentifier,
                    cancellationToken);
            }
            catch (OperationCanceledException) when (cancellationToken.IsCancellationRequested)
            {
                throw;
            }
            catch (Exception ex)
            {
                return await Fail(reconciling, ex, cancellationToken);
            }

            var reconciledAt = DateTimeOffset.UtcNow;
            if (reconciliation.AllComplete || reconciliation.FirstUncheckedGate is null)
            {
                var complete = reconciling with
                {
                    State = WorkerRuntimeState.COMPLETE,
                    CurrentChecklistIdentifier = null,
                    LastReconciliationAt = reconciledAt,
                    Failure = null
                };
                await stateStore.Save(complete, cancellationToken);
                return new(complete.State, false, false, "NOTION_CHECKLIST_COMPLETE");
            }

            var waiting = reconciling with
            {
                State = WorkerRuntimeState.WAITING_FOR_ENGINEERING_EVENT,
                CurrentChecklistIdentifier = reconciliation.FirstUncheckedGate.Id,
                LastReconciliationAt = reconciledAt,
                Failure = null
            };
            await stateStore.Save(waiting, cancellationToken);

            if (waiting.LastDispatchAt is { } lastDispatch &&
                DateTimeOffset.UtcNow - lastDispatch < policy.DispatchInterval)
            {
                return new(waiting.State, false, false, "DISPATCH_COOLDOWN_ACTIVE");
            }

            try
            {
                await driver.OpenContext(
                    waiting.Target.ResolveContextTarget(),
                    cancellationToken);

                if (!await driver.CanSendNextTurn(cancellationToken))
                    return new(waiting.State, false, false, "CHATGPT_TURN_NOT_IDLE");
            }
            catch (OperationCanceledException) when (cancellationToken.IsCancellationRequested)
            {
                throw;
            }
            catch (Exception ex)
            {
                return await Fail(waiting, ex, cancellationToken);
            }

            var continuing = waiting with { State = WorkerRuntimeState.CONTINUING };
            await stateStore.Save(continuing, cancellationToken);
            return await Dispatch(continuing, WorkerPrompts.ContinueFromNotionChecklist, cancellationToken);
        }
        finally
        {
            _mutex.Release();
        }
    }

    public Task<WorkerSnapshot> GetState(CancellationToken cancellationToken) =>
        stateStore.Load(cancellationToken);

    private async Task<WorkerLoopResult> Dispatch(
        WorkerSnapshot snapshot,
        string instruction,
        CancellationToken cancellationToken)
    {
        try
        {
            var target = snapshot.Target ?? throw new InvalidOperationException("ENGINEERING_TARGET_REQUIRED");
            await driver.Launch(cancellationToken);
            await driver.OpenContext(
                target.ResolveContextTarget(),
                cancellationToken);
            await driver.Send(instruction, cancellationToken);

            var waiting = snapshot with
            {
                State = WorkerRuntimeState.WAITING_FOR_ENGINEERING_EVENT,
                LastDispatchAt = DateTimeOffset.UtcNow,
                Failure = null
            };
            await stateStore.Save(waiting, cancellationToken);
            return new(waiting.State, true, false, "PROMPT_DISPATCHED");
        }
        catch (OperationCanceledException) when (cancellationToken.IsCancellationRequested)
        {
            throw;
        }
        catch (Exception ex)
        {
            return await Fail(snapshot, ex, cancellationToken);
        }
    }

    private async Task<WorkerLoopResult> Fail(
        WorkerSnapshot snapshot,
        Exception exception,
        CancellationToken cancellationToken)
    {
        var failure = exception.Message;
        var blocked = failure.Contains("PROJECT_NOT_FOUND", StringComparison.Ordinal) ||
                      failure.Contains("CONTEXT_NOT_FOUND", StringComparison.Ordinal) ||
                      failure.Contains("CHATGPT_AUTH_REQUIRED", StringComparison.Ordinal) ||
                      failure.Contains(OverrideUrlInvalid, StringComparison.Ordinal) ||
                      failure.Contains(ExecutionSurfaceMismatch, StringComparison.Ordinal) ||
                      failure.Contains(LiveChatGptRequiresCdp, StringComparison.Ordinal) ||
                      failure.Contains(CdpMustBeLoopback, StringComparison.Ordinal);
        var failed = snapshot with
        {
            State = blocked ? WorkerRuntimeState.BLOCKED : WorkerRuntimeState.FAILED,
            Failure = failure
        };
        await stateStore.Save(failed, cancellationToken);
        return new(failed.State, false, false, failure);
    }

    private static bool IsActive(WorkerRuntimeState state) => state is
        WorkerRuntimeState.DISPATCHING or
        WorkerRuntimeState.WAITING_FOR_ENGINEERING_EVENT or
        WorkerRuntimeState.RECONCILING or
        WorkerRuntimeState.CONTINUING;
}
