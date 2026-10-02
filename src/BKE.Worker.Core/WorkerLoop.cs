namespace BKE.Worker.Core;

public sealed class WorkerLoop(
    IChatGPTDriver driver,
    IWorkerStateStore stateStore,
    WorkerPolicy policy) : IWorkerLoop
{
    private const string DispatchOutcomeUnknown =
        "DISPATCH_OUTCOME_UNKNOWN_AFTER_RESTART";
    private const string ExecutionSurfaceMismatch =
        "CHATGPT_EXECUTION_SURFACE_MISMATCH";
    private const string LiveChatGptRequiresCdp =
        "LIVE_CHATGPT_REQUIRES_CDP_ATTACH";
    private const string CdpMustBeLoopback =
        "BROWSER_CDP_ENDPOINT_MUST_BE_LOOPBACK";
    private const string OverrideUrlInvalid =
        "CHATGPT_OVERRIDE_URL_INVALID";
    private const string TargetAmbiguous =
        "CHATGPT_TARGET_AMBIGUOUS";
    private const string TargetIncomplete =
        "CHATGPT_TARGET_INCOMPLETE";
    private const string WakeDeferredNotSafe =
        "WAKE_DEFERRED_CHATGPT_NOT_SAFE_TO_INTERRUPT";
    private readonly SemaphoreSlim _mutex = new(1, 1);

    public async Task<WorkerLoopResult> Start(
        EngineeringTarget target,
        CancellationToken cancellationToken)
    {
        await _mutex.WaitAsync(cancellationToken);
        try
        {
            var existing = await stateStore.Load(cancellationToken);

            if (existing.State is
                WorkerRuntimeState.DISPATCHING or
                WorkerRuntimeState.CONTINUING)
            {
                var blocked = existing with
                {
                    State = WorkerRuntimeState.BLOCKED,
                    Failure = DispatchOutcomeUnknown,
                };
                await stateStore.Save(blocked, cancellationToken);
                return new(
                    blocked.State,
                    false,
                    false,
                    DispatchOutcomeUnknown);
            }

            if (existing.State == WorkerRuntimeState.BLOCKED &&
                existing.Target == target)
            {
                return new(
                    existing.State,
                    false,
                    false,
                    "BLOCKED_REQUIRES_OPERATOR");
            }

            if (IsActive(existing.State))
            {
                if (existing.Target == target)
                {
                    return new(
                        existing.State,
                        false,
                        false,
                        "ALREADY_ACTIVE");
                }

                return new(
                    existing.State,
                    false,
                    false,
                    "ACTIVE_DISPATCH_EXISTS");
            }

            var validationFailure = ValidateTarget(target);
            if (validationFailure is not null)
            {
                var blocked = new WorkerSnapshot(
                    WorkerRuntimeState.BLOCKED,
                    target,
                    existing.LastDispatchAt,
                    existing.LastGitHubDeliveryId,
                    existing.LastWakeAt,
                    validationFailure);
                await stateStore.Save(blocked, cancellationToken);
                return new(
                    blocked.State,
                    false,
                    false,
                    validationFailure);
            }

            var waiting = new WorkerSnapshot(
                WorkerRuntimeState.WAITING_FOR_ENGINEERING_EVENT,
                target,
                existing.LastDispatchAt,
                existing.LastGitHubDeliveryId,
                DateTimeOffset.UtcNow,
                null);
            await stateStore.Save(waiting, cancellationToken);

            return await TryDispatch(
                waiting,
                WorkerRuntimeState.DISPATCHING,
                target.Instruction,
                requireSafeToInterrupt: true,
                cancellationToken);
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
                string.Equals(
                    snapshot.LastGitHubDeliveryId,
                    deliveryId,
                    StringComparison.Ordinal))
            {
                return new(
                    snapshot.State,
                    false,
                    true,
                    "DUPLICATE_GITHUB_DELIVERY");
            }

            var wakeSnapshot = snapshot with
            {
                LastGitHubDeliveryId =
                    string.IsNullOrWhiteSpace(deliveryId)
                        ? snapshot.LastGitHubDeliveryId
                        : deliveryId,
                LastWakeAt = DateTimeOffset.UtcNow,
            };

            if (!IsActive(wakeSnapshot.State) ||
                wakeSnapshot.Target is null)
            {
                await stateStore.Save(
                    wakeSnapshot,
                    cancellationToken);
                return new(
                    wakeSnapshot.State,
                    false,
                    false,
                    "NO_ACTIVE_ENGINEERING_LOOP");
            }

            var validationFailure =
                ValidateTarget(wakeSnapshot.Target);
            if (validationFailure is not null)
            {
                var blocked = wakeSnapshot with
                {
                    State = WorkerRuntimeState.BLOCKED,
                    Failure = validationFailure,
                };
                await stateStore.Save(blocked, cancellationToken);
                return new(
                    blocked.State,
                    false,
                    false,
                    validationFailure);
            }

            await stateStore.Save(
                wakeSnapshot with { Failure = null },
                cancellationToken);

            if (wakeSnapshot.LastDispatchAt is { } lastDispatch &&
                DateTimeOffset.UtcNow - lastDispatch <
                    policy.DispatchInterval)
            {
                return new(
                    WorkerRuntimeState.WAITING_FOR_ENGINEERING_EVENT,
                    false,
                    false,
                    "DISPATCH_COOLDOWN_ACTIVE");
            }

            return await TryDispatch(
                wakeSnapshot,
                WorkerRuntimeState.CONTINUING,
                wakeSnapshot.Target.Instruction,
                requireSafeToInterrupt: true,
                cancellationToken);
        }
        finally
        {
            _mutex.Release();
        }
    }

    public Task<WorkerSnapshot> GetState(
        CancellationToken cancellationToken) =>
        stateStore.Load(cancellationToken);

    private async Task<WorkerLoopResult> TryDispatch(
        WorkerSnapshot snapshot,
        WorkerRuntimeState dispatchState,
        string instruction,
        bool requireSafeToInterrupt,
        CancellationToken cancellationToken)
    {
        try
        {
            var target =
                snapshot.Target ??
                throw new InvalidOperationException(
                    "ENGINEERING_TARGET_REQUIRED");

            await driver.Launch(cancellationToken);
            await driver.OpenContext(
                target.ResolveContextTarget(),
                cancellationToken);

            if (requireSafeToInterrupt &&
                !await driver.CanSendNextTurn(cancellationToken))
            {
                var waiting = snapshot with
                {
                    State =
                        WorkerRuntimeState
                            .WAITING_FOR_ENGINEERING_EVENT,
                    Failure = null,
                };
                await stateStore.Save(waiting, cancellationToken);
                return new(
                    waiting.State,
                    false,
                    false,
                    WakeDeferredNotSafe);
            }

            var dispatching = snapshot with
            {
                State = dispatchState,
                Failure = null,
            };
            await stateStore.Save(
                dispatching,
                cancellationToken);

            await driver.Send(
                instruction,
                cancellationToken);

            var waitingAfterSend = dispatching with
            {
                State =
                    WorkerRuntimeState
                        .WAITING_FOR_ENGINEERING_EVENT,
                LastDispatchAt = DateTimeOffset.UtcNow,
                Failure = null,
            };
            await stateStore.Save(
                waitingAfterSend,
                cancellationToken);

            return new(
                waitingAfterSend.State,
                true,
                false,
                "PROMPT_DISPATCHED");
        }
        catch (OperationCanceledException)
            when (cancellationToken.IsCancellationRequested)
        {
            throw;
        }
        catch (Exception ex)
        {
            return await Fail(
                snapshot,
                ex,
                cancellationToken);
        }
    }

    private static string? ValidateTarget(
        EngineeringTarget target)
    {
        if (target.Surface != ChatGptExecutionSurface.Chat)
            return ExecutionSurfaceMismatch;

        try
        {
            _ = target.ResolveContextTarget();
            return null;
        }
        catch (Exception ex) when (
            ex.Message.Contains(
                TargetAmbiguous,
                StringComparison.Ordinal) ||
            ex.Message.Contains(
                TargetIncomplete,
                StringComparison.Ordinal))
        {
            return ex.Message;
        }
    }

    private async Task<WorkerLoopResult> Fail(
        WorkerSnapshot snapshot,
        Exception exception,
        CancellationToken cancellationToken)
    {
        var failure = exception.Message;
        var blocked =
            failure.Contains(
                "PROJECT_NOT_FOUND",
                StringComparison.Ordinal) ||
            failure.Contains(
                "CONTEXT_NOT_FOUND",
                StringComparison.Ordinal) ||
            failure.Contains(
                "CHATGPT_AUTH_REQUIRED",
                StringComparison.Ordinal) ||
            failure.Contains(
                OverrideUrlInvalid,
                StringComparison.Ordinal) ||
            failure.Contains(
                TargetAmbiguous,
                StringComparison.Ordinal) ||
            failure.Contains(
                TargetIncomplete,
                StringComparison.Ordinal) ||
            failure.Contains(
                ExecutionSurfaceMismatch,
                StringComparison.Ordinal) ||
            failure.Contains(
                LiveChatGptRequiresCdp,
                StringComparison.Ordinal) ||
            failure.Contains(
                CdpMustBeLoopback,
                StringComparison.Ordinal);

        var failed = snapshot with
        {
            State = blocked
                ? WorkerRuntimeState.BLOCKED
                : WorkerRuntimeState.FAILED,
            Failure = failure,
        };
        await stateStore.Save(failed, cancellationToken);
        return new(
            failed.State,
            false,
            false,
            failure);
    }

    private static bool IsActive(
        WorkerRuntimeState state) =>
        state is
            WorkerRuntimeState.WAITING_FOR_ENGINEERING_EVENT;
}
