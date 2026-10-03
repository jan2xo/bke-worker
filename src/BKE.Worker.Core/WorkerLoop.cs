namespace BKE.Worker.Core;

public sealed class WorkerLoop(
    IChatGPTDriver driver,
    IWorkerStateStore stateStore,
    WorkerPolicy policy,
    WorkerIdentity identity) : IWorkerLoop
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
    private const string WorkerIdInvalid =
        "WORKER_ID_INVALID";
    private const string AssignmentInvalid =
        "PR_ASSIGNMENT_INVALID";
    private const string AssignmentRequired =
        "ACTIVE_PR_ASSIGNMENT_REQUIRED";
    private const string DuplicateAssignment =
        "WORKER_ALREADY_ASSIGNED_TO_DIFFERENT_PR";
    private const string AmbiguousAssignment =
        "AMBIGUOUS_PR_ASSIGNMENT";
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

            if (!identity.IsValid)
            {
                return await Block(
                    existing with { Target = target },
                    WorkerIdInvalid,
                    cancellationToken);
            }

            if (existing.State is
                WorkerRuntimeState.DISPATCHING or
                WorkerRuntimeState.CONTINUING)
            {
                return await Block(
                    existing,
                    DispatchOutcomeUnknown,
                    cancellationToken);
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

            if (existing.State ==
                    WorkerRuntimeState.WAITING_FOR_ASSIGNMENT &&
                existing.Target == target)
            {
                return new(
                    existing.State,
                    false,
                    false,
                    "WAITING_FOR_ASSIGNMENT");
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
                return await Block(
                    existing with { Target = target },
                    validationFailure,
                    cancellationToken);
            }

            if (existing.Assignment is null)
            {
                var waitingForAssignment = existing with
                {
                    State =
                        WorkerRuntimeState
                            .WAITING_FOR_ASSIGNMENT,
                    Target = target,
                    Failure = null,
                };
                await stateStore.Save(
                    waitingForAssignment,
                    cancellationToken);
                return new(
                    waitingForAssignment.State,
                    false,
                    false,
                    "WAITING_FOR_ASSIGNMENT");
            }

            if (!existing.Assignment.IsValid)
            {
                return await Block(
                    existing with { Target = target },
                    AssignmentInvalid,
                    cancellationToken);
            }

            if (existing.Target is not null &&
                existing.Target != target)
            {
                return await Block(
                    existing,
                    "ACTIVE_ASSIGNMENT_TARGET_MISMATCH",
                    cancellationToken);
            }

            var waiting = existing with
            {
                State =
                    WorkerRuntimeState
                        .WAITING_FOR_ENGINEERING_EVENT,
                Target = target,
                LastWakeAt = DateTimeOffset.UtcNow,
                Failure = null,
            };
            await stateStore.Save(waiting, cancellationToken);

            return await TryDispatch(
                waiting,
                WorkerRuntimeState.DISPATCHING,
                cancellationToken);
        }
        finally
        {
            _mutex.Release();
        }
    }

    public async Task<WorkerLoopResult> Wake(
        WorkerWakeEvent wakeEvent,
        CancellationToken cancellationToken)
    {
        await _mutex.WaitAsync(cancellationToken);
        try
        {
            var snapshot = await stateStore.Load(cancellationToken);

            var recentDeliveries =
                snapshot.RecentGitHubDeliveryIds ??
                [];
            if (!string.IsNullOrWhiteSpace(
                    wakeEvent.DeliveryId) &&
                recentDeliveries.Contains(
                    wakeEvent.DeliveryId,
                    StringComparer.Ordinal))
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
                    string.IsNullOrWhiteSpace(
                        wakeEvent.DeliveryId)
                        ? snapshot.LastGitHubDeliveryId
                        : wakeEvent.DeliveryId,
                LastWakeAt = wakeEvent.ReceivedAt,
                RecentGitHubDeliveryIds =
                    RememberDelivery(
                        recentDeliveries,
                        wakeEvent.DeliveryId),
            };

            if (wakeEvent.Reason ==
                WorkerWakeReason.AssignmentConflict)
            {
                return await Block(
                    wakeSnapshot,
                    AmbiguousAssignment,
                    cancellationToken);
            }

            if (wakeEvent.Reason ==
                WorkerWakeReason.AssignmentRevoked)
            {
                if (wakeSnapshot.Assignment is null ||
                    wakeEvent.PullRequestNumber is null ||
                    wakeSnapshot.Assignment.Number !=
                        wakeEvent.PullRequestNumber.Value)
                {
                    await stateStore.Save(
                        wakeSnapshot,
                        cancellationToken);
                    return new(
                        wakeSnapshot.State,
                        false,
                        false,
                        "ASSIGNMENT_REVOKE_NOT_ACTIVE");
                }

                var revoked = wakeSnapshot with
                {
                    State =
                        WorkerRuntimeState
                            .WAITING_FOR_ASSIGNMENT,
                    Assignment = null,
                    Failure = null,
                };
                await stateStore.Save(
                    revoked,
                    cancellationToken);
                return new(
                    revoked.State,
                    false,
                    false,
                    "ASSIGNMENT_REVOKED");
            }

            if (wakeEvent.Assignment is { } incoming)
            {
                if (!incoming.IsValid)
                {
                    return await Block(
                        wakeSnapshot,
                        AssignmentInvalid,
                        cancellationToken);
                }

                if (wakeSnapshot.Assignment is { } active &&
                    active.Number != incoming.Number)
                {
                    return await Block(
                        wakeSnapshot,
                        DuplicateAssignment,
                        cancellationToken);
                }

                wakeSnapshot = wakeSnapshot with
                {
                    State =
                        WorkerRuntimeState
                            .WAITING_FOR_ENGINEERING_EVENT,
                    Assignment = incoming,
                    Failure = null,
                };
                await stateStore.Save(
                    wakeSnapshot,
                    cancellationToken);
            }

            if (wakeEvent.Reason ==
                WorkerWakeReason.GitHubPush)
            {
                if (wakeSnapshot.Assignment is null)
                {
                    var waiting =
                        EnsureWaitingForAssignment(
                            wakeSnapshot);
                    await stateStore.Save(
                        waiting,
                        cancellationToken);
                    return new(
                        waiting.State,
                        false,
                        false,
                        "NO_ACTIVE_PR_ASSIGNMENT");
                }

                var expectedRef =
                    "refs/heads/" +
                    wakeSnapshot.Assignment.HeadRef;
                if (!string.Equals(
                        expectedRef,
                        wakeEvent.GitHubRef,
                        StringComparison.Ordinal))
                {
                    await stateStore.Save(
                        wakeSnapshot,
                        cancellationToken);
                    return new(
                        wakeSnapshot.State,
                        false,
                        false,
                        "PUSH_NOT_ASSIGNED_TO_WORKER");
                }
            }

            if (wakeEvent.Reason ==
                    WorkerWakeReason.Manual &&
                wakeSnapshot.State is
                    WorkerRuntimeState.BLOCKED or
                    WorkerRuntimeState.FAILED)
            {
                if (wakeSnapshot.Assignment is null)
                {
                    var waiting =
                        EnsureWaitingForAssignment(
                            wakeSnapshot) with
                        {
                            Failure = null,
                        };
                    await stateStore.Save(
                        waiting,
                        cancellationToken);
                    return new(
                        waiting.State,
                        false,
                        false,
                        "NO_ACTIVE_PR_ASSIGNMENT");
                }

                var reset = wakeSnapshot with
                {
                    State =
                        WorkerRuntimeState
                            .WAITING_FOR_ENGINEERING_EVENT,
                    Failure = null,
                };
                await stateStore.Save(
                    reset,
                    cancellationToken);

                return await TryDispatch(
                    reset,
                    WorkerRuntimeState.CONTINUING,
                    cancellationToken);
            }

            if (wakeSnapshot.Assignment is null)
            {
                var waiting =
                    EnsureWaitingForAssignment(
                        wakeSnapshot);
                await stateStore.Save(
                    waiting,
                    cancellationToken);
                return new(
                    waiting.State,
                    false,
                    false,
                    "NO_ACTIVE_PR_ASSIGNMENT");
            }

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
                return await Block(
                    wakeSnapshot,
                    validationFailure,
                    cancellationToken);
            }

            await stateStore.Save(
                wakeSnapshot with { Failure = null },
                cancellationToken);

            if (wakeSnapshot.LastDispatchAt is { } lastDispatch &&
                DateTimeOffset.UtcNow - lastDispatch <
                    policy.DispatchInterval)
            {
                return new(
                    WorkerRuntimeState
                        .WAITING_FOR_ENGINEERING_EVENT,
                    false,
                    false,
                    "DISPATCH_COOLDOWN_ACTIVE");
            }

            return await TryDispatch(
                wakeSnapshot,
                WorkerRuntimeState.CONTINUING,
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
        CancellationToken cancellationToken)
    {
        try
        {
            var target =
                snapshot.Target ??
                throw new InvalidOperationException(
                    "ENGINEERING_TARGET_REQUIRED");
            var assignment =
                snapshot.Assignment ??
                throw new InvalidOperationException(
                    AssignmentRequired);

            await driver.Launch(cancellationToken);
            await driver.OpenContext(
                target.ResolveContextTarget(),
                cancellationToken);

            if (!await driver.CanSendNextTurn(
                    cancellationToken))
            {
                var waiting = snapshot with
                {
                    State =
                        WorkerRuntimeState
                            .WAITING_FOR_ENGINEERING_EVENT,
                    Failure = null,
                };
                await stateStore.Save(
                    waiting,
                    cancellationToken);
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
                WorkerPrompts.ForAssignment(
                    identity,
                    assignment,
                    target.Instruction),
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

    private static string[] RememberDelivery(
        IReadOnlyList<string> recent,
        string? deliveryId)
    {
        if (string.IsNullOrWhiteSpace(deliveryId))
            return [.. recent];

        const int maxRememberedDeliveries = 64;
        return recent
            .Where(item =>
                !string.Equals(
                    item,
                    deliveryId,
                    StringComparison.Ordinal))
            .Append(deliveryId)
            .TakeLast(maxRememberedDeliveries)
            .ToArray();
    }

    private static WorkerSnapshot EnsureWaitingForAssignment(
        WorkerSnapshot snapshot) =>
        snapshot.Target is null
            ? snapshot
            : snapshot with
            {
                State =
                    WorkerRuntimeState
                        .WAITING_FOR_ASSIGNMENT,
            };

    private static string? ValidateTarget(
        EngineeringTarget target)
    {
        if (target.Surface !=
            ChatGptExecutionSurface.Chat)
        {
            return ExecutionSurfaceMismatch;
        }

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

    private async Task<WorkerLoopResult> Block(
        WorkerSnapshot snapshot,
        string failure,
        CancellationToken cancellationToken)
    {
        var blocked = snapshot with
        {
            State = WorkerRuntimeState.BLOCKED,
            Failure = failure,
        };
        await stateStore.Save(
            blocked,
            cancellationToken);
        return new(
            blocked.State,
            false,
            false,
            failure);
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
                StringComparison.Ordinal) ||
            failure.Contains(
                AssignmentRequired,
                StringComparison.Ordinal);

        var failed = snapshot with
        {
            State = blocked
                ? WorkerRuntimeState.BLOCKED
                : WorkerRuntimeState.FAILED,
            Failure = failure,
        };
        await stateStore.Save(
            failed,
            cancellationToken);
        return new(
            failed.State,
            false,
            false,
            failure);
    }

    private static bool IsActive(
        WorkerRuntimeState state) =>
        state is
            WorkerRuntimeState
                .WAITING_FOR_ENGINEERING_EVENT;
}
