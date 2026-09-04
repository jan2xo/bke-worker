using System.Text.Json;
using System.Text.Json.Serialization;
using BKE.Worker.Core;
using BKE.Worker.Notion;

public sealed record WatchdogProjectOption(
    string PageId,
    string Title,
    string? Url);

public sealed record WatchdogTaskOption(
    string BlockId,
    string Text,
    bool Checked);

public sealed record WatchdogInstructionOption(
    string Key,
    string Name,
    string Instruction);

public sealed record WatchdogOptions(
    string PageId,
    string PageTitle,
    IReadOnlyList<WatchdogTaskOption> Tasks,
    IReadOnlyList<WatchdogInstructionOption> Instructions);

public sealed record WatchdogStartRequest(
    string NotionPageId,
    string TaskBlockId,
    string InstructionKey);

public sealed record WatchdogActionResult(
    WorkerRuntimeState State,
    bool PromptSent,
    string Message,
    string? CurrentTaskBlockId = null);

public sealed class NotionCheckboxWatchdog(
    INotionChecklistClient notion,
    NotionRuntimeConnection notionConnection,
    IChatGPTDriver driver,
    IWorkerStateStore stateStore,
    WorkerServerSettings settings)
{
    public const string EngineeringPagePrefix = "ENGINEERING:";
    private const string DispatchOutcomeUnknown = "DISPATCH_OUTCOME_UNKNOWN_AFTER_RESTART";
    private readonly SemaphoreSlim _mutex = new(1, 1);

    public async Task<IReadOnlyList<WatchdogProjectOption>> GetProjects(CancellationToken cancellationToken)
    {
        var pages = await notion.GetSharedPages(cancellationToken);
        return pages
            .Where(page => page.Title.TrimStart().StartsWith(
                EngineeringPagePrefix,
                StringComparison.OrdinalIgnoreCase))
            .OrderBy(page => page.Title, StringComparer.OrdinalIgnoreCase)
            .Select(page => new WatchdogProjectOption(
                NotionChecklistClient.NormalizeNotionId(page.PageId),
                page.Title.Trim(),
                page.Url))
            .ToArray();
    }

    public async Task<WatchdogOptions> GetOptions(
        string pageId,
        CancellationToken cancellationToken)
    {
        var page = await GetEngineeringPageIdentity(pageId, cancellationToken);
        var normalizedPageId = NotionChecklistClient.NormalizeNotionId(page.PageId);
        var tasks = await GetVerifiedUncheckedTasks(normalizedPageId, cancellationToken);
        var instructions = await notion.GetInstructionTemplates(normalizedPageId, cancellationToken);

        return new WatchdogOptions(
            normalizedPageId,
            page.Title,
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
        ArgumentException.ThrowIfNullOrWhiteSpace(request.NotionPageId);
        ArgumentException.ThrowIfNullOrWhiteSpace(request.TaskBlockId);
        ArgumentException.ThrowIfNullOrWhiteSpace(request.InstructionKey);

        await _mutex.WaitAsync(cancellationToken);
        try
        {
            var existing = await stateStore.Load(cancellationToken);
            if (IsActive(existing.State))
                return new(existing.State, false, "WATCHDOG_ALREADY_ACTIVE", existing.CurrentChecklistIdentifier);

            var page = await GetEngineeringPageIdentity(request.NotionPageId, cancellationToken);
            var pageId = NotionChecklistClient.NormalizeNotionId(page.PageId);
            var requestedTaskId = NotionChecklistClient.NormalizeNotionId(request.TaskBlockId);

            var openTasks = await GetVerifiedUncheckedTasks(pageId, cancellationToken);
            var task = openTasks.SingleOrDefault(candidate =>
                string.Equals(
                    NotionChecklistClient.NormalizeNotionId(candidate.BlockId),
                    requestedTaskId,
                    StringComparison.OrdinalIgnoreCase))
                ?? throw new InvalidOperationException("NOTION_TASK_NOT_OPEN_ON_SELECTED_ENGINEERING_PAGE");

            var templates = await notion.GetInstructionTemplates(pageId, cancellationToken);
            var instruction = templates.SingleOrDefault(template =>
                string.Equals(template.Key, request.InstructionKey, StringComparison.OrdinalIgnoreCase))
                ?? throw new InvalidOperationException("NOTION_INSTRUCTION_NOT_FOUND_ON_SELECTED_ENGINEERING_PAGE");

            var target = settings.Target with
            {
                NotionPageId = pageId,
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
                NotionChecklistTask? next;
                try
                {
                    next = await GetFirstVerifiedUncheckedTask(
                        snapshot.Target.NotionPageId,
                        cancellationToken);
                }
                catch (Exception ex) when (ex is not OperationCanceledException)
                {
                    return await Block(observed, ex.Message, cancellationToken);
                }

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

    private async Task<IReadOnlyList<NotionChecklistTask>> GetVerifiedUncheckedTasks(
        string pageId,
        CancellationToken cancellationToken)
    {
        var candidates = await notion.GetTasks(
            pageId,
            includeChecked: true,
            cancellationToken);
        var verified = new List<NotionChecklistTask>(candidates.Count);

        foreach (var candidate in candidates)
        {
            var exact = await notion.GetTask(candidate.BlockId, cancellationToken);
            if (exact is not null && !exact.Checked)
                verified.Add(exact);
        }

        return verified;
    }

    private async Task<NotionChecklistTask?> GetFirstVerifiedUncheckedTask(
        string pageId,
        CancellationToken cancellationToken)
    {
        var candidates = await notion.GetTasks(
            pageId,
            includeChecked: true,
            cancellationToken);

        foreach (var candidate in candidates)
        {
            var exact = await notion.GetTask(candidate.BlockId, cancellationToken);
            if (exact is not null && !exact.Checked)
                return exact;
        }

        return null;
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
            var page = await GetEngineeringPageIdentity(target.NotionPageId, cancellationToken);
            await driver.Launch(cancellationToken);
            await driver.OpenContext(target.ResolveContextTarget(), cancellationToken);
            await driver.Send(BuildPrompt(target.Instruction, page, task, isContinuation), cancellationToken);

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

    private async Task<NotionPageSummary> GetEngineeringPageIdentity(
        string pageIdOrUrl,
        CancellationToken cancellationToken)
    {
        var page = await GetNotionPageIdentity(pageIdOrUrl, cancellationToken);
        if (!page.Title.TrimStart().StartsWith(EngineeringPagePrefix, StringComparison.OrdinalIgnoreCase))
            throw new InvalidOperationException("NOTION_PAGE_NOT_ENGINEERING");
        return page;
    }

    private async Task<NotionPageSummary> GetNotionPageIdentity(
        string pageIdOrUrl,
        CancellationToken cancellationToken)
    {
        var pageId = NotionChecklistClient.NormalizeNotionId(pageIdOrUrl);
        using var response = await notionConnection.GetPage(pageId, cancellationToken);
        var payload = await response.Content.ReadAsStringAsync(cancellationToken);
        if (!response.IsSuccessStatusCode)
            throw new InvalidOperationException($"NOTION_PAGE_IDENTITY_FAILED:{(int)response.StatusCode}");

        using var document = JsonDocument.Parse(payload);
        var root = document.RootElement;
        var title = ReadPageTitle(root).Trim();
        if (string.IsNullOrWhiteSpace(title))
            throw new InvalidOperationException("NOTION_PAGE_TITLE_NOT_FOUND");

        var returnedId = root.TryGetProperty("id", out var idProperty)
            ? idProperty.GetString() ?? pageId
            : pageId;
        var url = root.TryGetProperty("url", out var urlProperty)
            ? urlProperty.GetString()
            : null;

        return new NotionPageSummary(returnedId, title, url);
    }

    private static string ReadPageTitle(JsonElement page)
    {
        if (!page.TryGetProperty("properties", out var properties))
            return string.Empty;

        foreach (var property in properties.EnumerateObject())
        {
            var value = property.Value;
            if (!value.TryGetProperty("type", out var type) || type.GetString() != "title")
                continue;
            if (!value.TryGetProperty("title", out var titleItems))
                continue;

            return string.Concat(
                titleItems.EnumerateArray()
                    .Select(item => item.TryGetProperty("plain_text", out var text) ? text.GetString() : null)
                    .Where(text => !string.IsNullOrEmpty(text)));
        }

        return string.Empty;
    }

    private static string BuildPrompt(
        string durableInstruction,
        NotionPageSummary page,
        NotionChecklistTask task,
        bool isContinuation)
    {
        var action = isContinuation
            ? "The current Notion TODO is still unchecked. Continue the SAME TODO. Do not move to another TODO."
            : "Execute the CURRENT TODO below. Do not move to another TODO.";
        var pageId = NotionChecklistClient.NormalizeNotionId(page.PageId);
        var pageUrl = string.IsNullOrWhiteSpace(page.Url) ? "(not available)" : page.Url.Trim();

        return $"""
[NOTION AUTHORITY]
Page name: {page.Title.Trim()}
Page ID: {pageId}
Page URL: {pageUrl}
Current TODO block ID: {task.BlockId}
Use ONLY this exact Notion page for task reconciliation and completion.
Do NOT search for, use, or modify another Notion page merely because it contains the same or similar TODO text.

[DURABLE INSTRUCTION]
{durableInstruction.Trim()}

[CURRENT TODO]
{task.Text.Trim()}

[WORKER CONTRACT]
{action}
The exact Notion page and TODO block identified above are canonical completion truth.
Mark that TODO checked only when the task is actually complete and verified.
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
    NotionRuntimeConnection notionConnection,
    WorkerServerSettings settings,
    ILogger<NotionCheckboxWatchdogHostedService> logger) : BackgroundService
{
    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        using var timer = new PeriodicTimer(settings.WatchdogInterval);
        while (await timer.WaitForNextTickAsync(stoppingToken))
        {
            if (!settings.IsConfigured || !notionConnection.IsConnected)
                continue;

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
