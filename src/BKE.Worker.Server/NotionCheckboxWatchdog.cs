using System.Text.Json;
using System.Text.Json.Serialization;
using BKE.Worker.Core;
using BKE.Worker.Notion;

public sealed record WatchdogTaskOption(
    string BlockId,
    string Text,
    bool Checked);

public sealed record WatchdogInstructionOption(
    string Key,
    string Name,
    string Instruction);

public sealed record WatchdogOptions(
    IReadOnlyList<WatchdogTaskOption> Tasks,
    IReadOnlyList<WatchdogInstructionOption> Instructions);

public sealed record WatchdogStartRequest(
    string TaskBlockId,
    string InstructionKey);

public sealed record WatchdogActionResult(
    WorkerRuntimeState State,
    bool PromptSent,
    string Message,
    string? CurrentTaskBlockId = null);

public sealed class NotionCheckboxWatchdog(
    INotionChecklistClient notion,
    IChatGPTDriver driver,
    IWorkerStateStore stateStore,
    WorkerServerSettings settings)
{
    private const string DispatchOutcomeUnknown = "DISPATCH_OUTCOME_UNKNOWN_AFTER_RESTART";
    private readonly SemaphoreSlim _mutex = new(1, 1);

    public async Task<WatchdogOptions> GetOptions(CancellationToken cancellationToken)
    {
        var tasks = await notion.GetTasks(
            settings.NotionPageId,
            includeChecked: false,
            cancellationToken);
        var instructions = await notion.GetInstructionTemplates(
            settings.NotionPageId,
            cancellationToken);

        return new WatchdogOptions(
            tasks.Select(task => new WatchdogTaskOption(task.BlockId, task.Text, task.Checked)).ToArray(),
            instructions.Select(template => new WatchdogInstructionOption(
                template.Key,
                template.Name,
                template.Instruction)).ToArray());
    }

    public Task<WorkerSnapshot> GetState(CancellationToken cancellationToken) =>
        stateStore.Load(cancellationToken);

    public async Task<NotionChecklistTask?> GetCurrentTask(CancellationToken cancellationToken)
    {
        var snapshot = await stateStore.Load(cancellationToken);
        if (string.IsNullOrWhiteSpace(snapshot.CurrentChecklistIdentifier))
            return null;

        return await notion.GetTask(snapshot.CurrentChecklistIdentifier, cancellationToken);
    }

    public async Task<WatchdogActionResult> Start(
        WatchdogStartRequest request,
        CancellationToken cancellationToken)
    {
        ArgumentException.ThrowIfNullOrWhiteSpace(request.TaskBlockId);
        ArgumentException.ThrowIfNullOrWhiteSpace(request.InstructionKey);

        await _mutex.WaitAsync(cancellationToken);
        try
        {
            var existing = await stateStore.Load(cancellationToken);
            if (IsActive(existing.State))
                return new(existing.State, false, "WATCHDOG_ALREADY_ACTIVE", existing.CurrentChecklistIdentifier);

            var task = await notion.GetTask(request.TaskBlockId, cancellationToken)
                ?? throw new InvalidOperationException("NOTION_TASK_NOT_FOUND");
            if (task.Checked)
                throw new InvalidOperationException("NOTION_TASK_ALREADY_CHECKED");

            var templates = await notion.GetInstructionTemplates(settings.NotionPageId, cancellationToken);
            var instruction = templates.SingleOrDefault(template =>
                string.Equals(template.Key, request.InstructionKey, StringComparison.OrdinalIgnoreCase))
                ?? throw new InvalidOperationException("NOTION_INSTRUCTION_NOT_FOUND");

            var target = settings.Target with
            {
                NotionPageId = NotionChecklistClient.NormalizeNotionId(settings.NotionPageId),
                Instruction = instruction.Instruction,
                Surface = ChatGptExecutionSurface.Chat
            };
            _ = target.ResolveContextTarget();

            var waiting = new WorkerSnapshot(
                WorkerRuntimeState.WAITING_FOR_ENGINEERING_EVENT,
                target,
                task.BlockId,
                null,
                null,
                DateTimeOffset.UtcNow,
                null);
            await stateStore.Save(waiting, cancellationToken);

            if (!await IsChatSafe(cancellationToken))
                return new(waiting.State, false, "WATCHDOG_ARMED_CHATGPT_BUSY", task.BlockId);

            return await Dispatch(waiting, task, isContinuation: false, cancellationToken);
        }
        finally
        {
            _mutex.Release();
        }
    }

    public async Task<WatchdogActionResult> Stop(CancellationToken cancellationToken)
    {
        await _mutex.WaitAsync(cancellationToken);
        try
        {
            var existing = await stateStore.Load(cancellationToken);
            var stopped = existing with
            {
                State = WorkerRuntimeState.IDLE,
                Target = null,
                CurrentChecklistIdentifier = null,
                Failure = null
            };
            await stateStore.Save(stopped, cancellationToken);
            return new(stopped.State, false, "WATCHDOG_STOPPED");
        }
        finally
        {
            _mutex.Release();
        }
    }

    public async Task<WatchdogActionResult> Tick(CancellationToken cancellationToken)
    {
        await _mutex.WaitAsync(cancellationToken);
        try
        {
            var snapshot = await stateStore.Load(cancellationToken);

            if (snapshot.State is WorkerRuntimeState.DISPATCHING or WorkerRuntimeState.CONTINUING)
            {
                var blocked = snapshot with
                {
                    State = WorkerRuntimeState.BLOCKED,
                    Failure = DispatchOutcomeUnknown
                };
                await stateStore.Save(blocked, cancellationToken);
                return new(blocked.State, false, DispatchOutcomeUnknown, blocked.CurrentChecklistIdentifier);
            }

            if (!IsActive(snapshot.State) ||
                snapshot.Target is null ||
                string.IsNullOrWhiteSpace(snapshot.CurrentChecklistIdentifier))
            {
                return new(snapshot.State, false, "WATCHDOG_INACTIVE", snapshot.CurrentChecklistIdentifier);
            }

            NotionChecklistTask current;
            try
            {
                current = await notion.GetTask(snapshot.CurrentChecklistIdentifier, cancellationToken)
                    ?? throw new InvalidOperationException("NOTION_CURRENT_TASK_NOT_FOUND");
            }
            catch (Exception ex) when (ex is not OperationCanceledException)
            {
                return await Block(snapshot, ex.Message, cancellationToken);
            }

            var observed = snapshot with { LastReconciliationAt = DateTimeOffset.UtcNow };

            if (current.Checked)
            {
                IReadOnlyList<NotionChecklistTask> remaining;
                try
                {
                    remaining = await notion.GetTasks(
                        snapshot.Target.NotionPageId,
                        includeChecked: false,
                        cancellationToken);
                }
                catch (Exception ex) when (ex is not OperationCanceledException)
                {
                    return await Block(observed, ex.Message, cancellationToken);
                }

                var next = remaining.FirstOrDefault();
                if (next is null)
                {
                    var complete = observed with
                    {
                        State = WorkerRuntimeState.COMPLETE,
                        CurrentChecklistIdentifier = null,
                        Failure = null
                    };
                    await stateStore.Save(complete, cancellationToken);
                    return new(complete.State, false, "NOTION_CHECKLIST_COMPLETE");
                }

                if (!await IsChatSafe(cancellationToken))
                {
                    await stateStore.Save(observed, cancellationToken);
                    return new(observed.State, false, "NEXT_TASK_READY_CHATGPT_BUSY", next.BlockId);
                }

                var nextSnapshot = observed with
                {
                    CurrentChecklistIdentifier = next.BlockId,
                    Failure = null
                };
                await stateStore.Save(nextSnapshot, cancellationToken);
                return await Dispatch(nextSnapshot, next, isContinuation: false, cancellationToken);
            }

            if (!await IsChatSafe(cancellationToken))
            {
                await stateStore.Save(observed, cancellationToken);
                return new(observed.State, false, "CURRENT_TASK_UNCHECKED_CHATGPT_BUSY", current.BlockId);
            }

            if (observed.LastDispatchAt is { } lastDispatch &&
                DateTimeOffset.UtcNow - lastDispatch < settings.IdleRetryInterval)
            {
                await stateStore.Save(observed, cancellationToken);
                return new(observed.State, false, "CURRENT_TASK_UNCHECKED_RETRY_COOLDOWN", current.BlockId);
            }

            await stateStore.Save(observed, cancellationToken);
            return await Dispatch(observed, current, isContinuation: true, cancellationToken);
        }
        finally
        {
            _mutex.Release();
        }
    }

    private async Task<bool> IsChatSafe(CancellationToken cancellationToken)
    {
        await driver.Launch(cancellationToken);
        await driver.OpenContext(settings.Target.ResolveContextTarget(), cancellationToken);
        return await driver.CanSendNextTurn(cancellationToken);
    }

    private async Task<WatchdogActionResult> Dispatch(
        WorkerSnapshot snapshot,
        NotionChecklistTask task,
        bool isContinuation,
        CancellationToken cancellationToken)
    {
        var target = snapshot.Target ?? throw new InvalidOperationException("ENGINEERING_TARGET_REQUIRED");
        var dispatching = snapshot with
        {
            State = isContinuation ? WorkerRuntimeState.CONTINUING : WorkerRuntimeState.DISPATCHING,
            CurrentChecklistIdentifier = task.BlockId,
            Failure = null
        };
        await stateStore.Save(dispatching, cancellationToken);

        try
        {
            await driver.Launch(cancellationToken);
            await driver.OpenContext(target.ResolveContextTarget(), cancellationToken);
            await driver.Send(BuildPrompt(target.Instruction, task.Text, isContinuation), cancellationToken);

            var waiting = dispatching with
            {
                State = WorkerRuntimeState.WAITING_FOR_ENGINEERING_EVENT,
                LastDispatchAt = DateTimeOffset.UtcNow,
                Failure = null
            };
            await stateStore.Save(waiting, cancellationToken);
            return new(
                waiting.State,
                true,
                isContinuation ? "CURRENT_TASK_CONTINUED" : "TASK_DISPATCHED",
                task.BlockId);
        }
        catch (OperationCanceledException) when (cancellationToken.IsCancellationRequested)
        {
            throw;
        }
        catch (Exception ex)
        {
            return await Block(dispatching, ex.Message, cancellationToken);
        }
    }

    private static string BuildPrompt(string durableInstruction, string taskText, bool isContinuation)
    {
        var action = isContinuation
            ? "The current Notion TODO is still unchecked. Continue the SAME TODO. Do not move to another TODO."
            : "Execute the CURRENT TODO below. Do not move to another TODO.";

        return $"""
[DURABLE INSTRUCTION]
{durableInstruction.Trim()}

[CURRENT TODO]
{taskText.Trim()}

[WORKER CONTRACT]
{action}
The selected Notion TODO block is canonical completion truth.
Mark that exact TODO checked only when the task is actually complete and verified.
If blocked or incomplete, leave it unchecked and report the blocker.
Do not mark it complete merely because work was attempted.
""";
    }

    private async Task<WatchdogActionResult> Block(
        WorkerSnapshot snapshot,
        string failure,
        CancellationToken cancellationToken)
    {
        var blocked = snapshot with
        {
            State = WorkerRuntimeState.BLOCKED,
            Failure = failure
        };
        await stateStore.Save(blocked, cancellationToken);
        return new(blocked.State, false, failure, blocked.CurrentChecklistIdentifier);
    }

    private static bool IsActive(WorkerRuntimeState state) => state is
        WorkerRuntimeState.WAITING_FOR_ENGINEERING_EVENT or
        WorkerRuntimeState.DISPATCHING or
        WorkerRuntimeState.CONTINUING;
}

public sealed class JsonWorkerStateStore(string path) : IWorkerStateStore
{
    private static readonly JsonSerializerOptions SerializerOptions = new()
    {
        WriteIndented = true,
        Converters = { new JsonStringEnumConverter() }
    };

    private readonly SemaphoreSlim _mutex = new(1, 1);

    public async Task<WorkerSnapshot> Load(CancellationToken cancellationToken)
    {
        await _mutex.WaitAsync(cancellationToken);
        try
        {
            if (!File.Exists(path))
                return WorkerSnapshot.Empty;

            var json = await File.ReadAllTextAsync(path, cancellationToken);
            return JsonSerializer.Deserialize<WorkerSnapshot>(json, SerializerOptions) ?? WorkerSnapshot.Empty;
        }
        finally
        {
            _mutex.Release();
        }
    }

    public async Task Save(WorkerSnapshot snapshot, CancellationToken cancellationToken)
    {
        await _mutex.WaitAsync(cancellationToken);
        try
        {
            var directory = Path.GetDirectoryName(path);
            if (!string.IsNullOrWhiteSpace(directory))
                Directory.CreateDirectory(directory);

            var temp = path + ".tmp";
            var json = JsonSerializer.Serialize(snapshot, SerializerOptions);
            await File.WriteAllTextAsync(temp, json, cancellationToken);
            File.Move(temp, path, overwrite: true);
        }
        finally
        {
            _mutex.Release();
        }
    }
}

public sealed class NotionCheckboxWatchdogHostedService(
    NotionCheckboxWatchdog watchdog,
    WorkerServerSettings settings,
    ILogger<NotionCheckboxWatchdogHostedService> logger) : BackgroundService
{
    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        if (!settings.IsConfigured)
        {
            logger.LogWarning(
                "BKE Worker watchdog is unconfigured; Notion, deterministic ChatGPT override URL, and loopback CDP are required.");
            await Task.Delay(Timeout.InfiniteTimeSpan, stoppingToken);
            return;
        }

        using var timer = new PeriodicTimer(settings.WatchdogInterval);
        while (await timer.WaitForNextTickAsync(stoppingToken))
        {
            WatchdogActionResult result;
            try
            {
                result = await watchdog.Tick(stoppingToken);
            }
            catch (OperationCanceledException) when (stoppingToken.IsCancellationRequested)
            {
                throw;
            }
            catch (Exception ex)
            {
                logger.LogError(ex, "Notion checkbox watchdog tick failed.");
                continue;
            }

            if (result.Message is not "WATCHDOG_INACTIVE" and not "CURRENT_TASK_UNCHECKED_RETRY_COOLDOWN")
            {
                logger.LogInformation(
                    "Watchdog: {State} {Message} task={Task} promptSent={PromptSent}",
                    result.State,
                    result.Message,
                    result.CurrentTaskBlockId,
                    result.PromptSent);
            }
        }
    }
}
