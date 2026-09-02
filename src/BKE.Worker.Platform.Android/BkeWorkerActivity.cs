using Android.App;
using Android.Content;
using Android.OS;
using Android.Provider;
using Android.Text;
using Android.Widget;
using BKE.Worker.Core;
using BKE.Worker.Notion;
using BKE.Worker.Platform.Android.Accessibility;
using BKE.Worker.Platform.Android.Configuration;
using BKE.Worker.Platform.Android.Security;

namespace BKE.Worker.Platform.Android;

[Activity(
    Name = "bke.worker.android.BkeWorkerActivity",
    Exported = true,
    Label = "BKE Worker",
    MainLauncher = true)]
public sealed class BkeWorkerActivity : Activity
{
    private TextView? _status;
    private TextView? _notionStatus;
    private TextView? _notionSecretStatus;
    private TextView? _chatGptStatus;
    private TextView? _overrideStatus;
    private Spinner? _notionPages;
    private Spinner? _notionTasks;
    private Spinner? _context;
    private Spinner? _recentChats;
    private Spinner? _reasoning;
    private EditText? _conversation;
    private EditText? _project;
    private EditText? _probe;
    private EditText? _notionToken;
    private AndroidNotionSecretVault? _notionVault;
    private WorkItem? _armedWorkItem;
    private IReadOnlyList<NotionPageSummary> _loadedNotionPages = [];
    private IReadOnlyList<NotionChecklistTask> _loadedNotionTasks = [];
    private IReadOnlyList<string> _loadedRecentTitles = [];

    protected override void OnCreate(Bundle? savedInstanceState)
    {
        base.OnCreate(savedInstanceState);
        ActionBar?.Hide();
        _notionVault = new AndroidNotionSecretVault(this);
        BuildUi();
    }

    protected override void OnResume()
    {
        base.OnResume();
        RefreshStatus();
        RefreshNotionSecretStatus();
        RefreshChatGptBindingStatus();
    }

    protected override void OnDestroy()
    {
        _notionVault?.Lock();
        _armedWorkItem = null;
        base.OnDestroy();
    }

    private void BuildUi()
    {
        var scroll = new ScrollView(this);
        var layout = new LinearLayout(this) { Orientation = Orientation.Vertical };
        layout.SetPadding(32, 48, 32, 64);

        layout.AddView(new TextView(this) { Text = "BKE Worker", TextSize = 24 });
        _status = new TextView(this);
        layout.AddView(_status);

        var settings = new Button(this) { Text = "OPEN ACCESSIBILITY SETTINGS" };
        settings.Click += (_, _) => StartActivity(new Intent(Settings.ActionAccessibilitySettings));
        layout.AddView(settings);

        layout.AddView(new TextView(this) { Text = "WORK SOURCE", TextSize = 18 });
        var workSource = new Spinner(this);
        workSource.Adapter = new ArrayAdapter<string>(this, global::Android.Resource.Layout.SimpleSpinnerItem,
            new[] { "NOTION" });
        layout.AddView(workSource);

        _notionSecretStatus = new TextView(this);
        layout.AddView(_notionSecretStatus);

        var securitySettings = new Button(this) { Text = "OPEN DEVICE SECURITY SETTINGS" };
        securitySettings.Click += (_, _) => StartActivity(new Intent(Settings.ActionSecuritySettings));
        layout.AddView(securitySettings);

        _notionToken = new EditText(this) { Hint = "Notion token — first setup/change only" };
        _notionToken.InputType = InputTypes.ClassText | InputTypes.TextVariationPassword;
        layout.AddView(_notionToken);

        var saveNotionToken = new Button(this) { Text = "SAVE / CHANGE NOTION TOKEN SECURELY" };
        saveNotionToken.Click += async (_, _) => await SaveNotionToken(saveNotionToken);
        layout.AddView(saveNotionToken);

        var unlockNotion = new Button(this) { Text = "UNLOCK NOTION" };
        unlockNotion.Click += async (_, _) => await UnlockNotion(unlockNotion);
        layout.AddView(unlockNotion);

        var lockNotion = new Button(this) { Text = "LOCK NOTION" };
        lockNotion.Click += (_, _) => LockNotion();
        layout.AddView(lockNotion);

        var forgetNotion = new Button(this) { Text = "FORGET NOTION TOKEN" };
        forgetNotion.Click += (_, _) => ForgetNotion();
        layout.AddView(forgetNotion);

        var discoverNotion = new Button(this) { Text = "DISCOVER NOTION PAGES" };
        discoverNotion.Click += async (_, _) => await DiscoverNotionPages(discoverNotion);
        layout.AddView(discoverNotion);

        _notionStatus = new TextView(this) { Text = "Notion: NOT CONNECTED" };
        layout.AddView(_notionStatus);

        _notionPages = new Spinner(this);
        _notionPages.Adapter = new ArrayAdapter<string>(this, global::Android.Resource.Layout.SimpleSpinnerItem,
            new[] { "(discover shared pages)" });
        layout.AddView(_notionPages);

        var loadNotion = new Button(this) { Text = "LOAD PAGE TASKS" };
        loadNotion.Click += async (_, _) => await LoadNotionTasks(loadNotion);
        layout.AddView(loadNotion);

        _notionTasks = new Spinner(this);
        _notionTasks.Adapter = new ArrayAdapter<string>(this, global::Android.Resource.Layout.SimpleSpinnerItem,
            new[] { "(load unchecked checklist tasks)" });
        layout.AddView(_notionTasks);

        layout.AddView(new TextView(this) { Text = "EXECUTION TARGET", TextSize = 18 });
        var executionTarget = new Spinner(this);
        executionTarget.Adapter = new ArrayAdapter<string>(this, global::Android.Resource.Layout.SimpleSpinnerItem,
            new[] { "CHATGPT" });
        layout.AddView(executionTarget);

        _chatGptStatus = new TextView(this) { Text = "ChatGPT binding: WAITING" };
        layout.AddView(_chatGptStatus);

        var openChatGpt = new Button(this) { Text = "OPEN CHATGPT" };
        openChatGpt.Click += (_, _) => OpenChatGpt();
        layout.AddView(openChatGpt);

        var checkChatGpt = new Button(this) { Text = "CHECK CHATGPT BINDING" };
        checkChatGpt.Click += (_, _) => RefreshChatGptBindingStatus();
        layout.AddView(checkChatGpt);

        layout.AddView(new TextView(this) { Text = "CHATS" });
        _context = new Spinner(this);
        _context.Adapter = new ArrayAdapter<string>(this, global::Android.Resource.Layout.SimpleSpinnerItem,
            new[] { "NEW CHAT", "RECENTS", "PROJECTS" });
        _context.SetSelection(1);
        layout.AddView(_context);

        var discoverRecents = new Button(this) { Text = "DISCOVER RECENTS" };
        discoverRecents.Click += async (_, _) => await DiscoverRecents(discoverRecents);
        layout.AddView(discoverRecents);

        _recentChats = new Spinner(this);
        _recentChats.Adapter = new ArrayAdapter<string>(this, global::Android.Resource.Layout.SimpleSpinnerItem,
            new[] { "(discover real ChatGPT recents)" });
        layout.AddView(_recentChats);

        var openSelectedRecent = new Button(this) { Text = "OPEN SELECTED RECENT" };
        openSelectedRecent.Click += async (_, _) => await OpenSelectedRecent(openSelectedRecent);
        layout.AddView(openSelectedRecent);

        _project = new EditText(this) { Hint = "Project (PROJECTS only)" };
        layout.AddView(_project);
        _conversation = new EditText(this) { Hint = "Conversation (PROJECTS only)" };
        layout.AddView(_conversation);

        _reasoning = new Spinner(this);
        _reasoning.Adapter = new ArrayAdapter<string>(this, global::Android.Resource.Layout.SimpleSpinnerItem,
            Enum.GetNames<ReasoningProfile>());
        _reasoning.SetSelection(Array.IndexOf(Enum.GetNames<ReasoningProfile>(), nameof(ReasoningProfile.HIGH)));
        layout.AddView(_reasoning);

        var armOverride = new Button(this) { Text = "ARM OVERRIDE" };
        armOverride.Click += (_, _) => ArmOverride();
        layout.AddView(armOverride);

        _overrideStatus = new TextView(this) { Text = "Override: NOT ARMED" };
        layout.AddView(_overrideStatus);

        _probe = new EditText(this) { Text = "BKE WORKER TEST 001.\n\nReply with exactly:\n\nBKE_WORKER_OK" };
        _probe.SetMinLines(4);
        layout.AddView(_probe);

        var run = new Button(this) { Text = "RUN PROBE" };
        run.Click += (_, _) => ShowProbeIntent();
        layout.AddView(run);

        layout.AddView(new TextView(this) { Text = "State / local event log" });
        scroll.AddView(layout);
        SetContentView(scroll);
        RefreshStatus();
        RefreshNotionSecretStatus();
        RefreshChatGptBindingStatus();
    }

    private async Task SaveNotionToken(Button button)
    {
        if (_notionVault is null || _notionToken is null || _notionStatus is null)
            return;

        var token = _notionToken.Text?.Trim();
        if (string.IsNullOrWhiteSpace(token))
        {
            _notionStatus.Text = "Notion: TOKEN_REQUIRED";
            return;
        }

        button.Enabled = false;
        _notionStatus.Text = "Notion: WAITING FOR DEVICE AUTH";
        try
        {
            await _notionVault.SaveAsync(token, CancellationToken.None);
            _notionToken.Text = string.Empty;
            _notionStatus.Text = "Notion: TOKEN SAVED SECURELY";
        }
        catch (ArgumentException ex)
        {
            _notionStatus.Text = $"Notion: {ex.Message}";
        }
        catch (InvalidOperationException ex)
        {
            _notionStatus.Text = $"Notion: {FormatNotionSecurityError(ex)}";
        }
        finally
        {
            button.Enabled = true;
            RefreshNotionSecretStatus();
        }
    }

    private async Task UnlockNotion(Button button)
    {
        if (_notionVault is null || _notionStatus is null)
            return;

        button.Enabled = false;
        _notionStatus.Text = "Notion: WAITING FOR DEVICE AUTH";
        try
        {
            await _notionVault.UnlockAsync(CancellationToken.None);
            _notionStatus.Text = "Notion: UNLOCKED";
        }
        catch (InvalidOperationException ex)
        {
            _notionStatus.Text = $"Notion: {FormatNotionSecurityError(ex)}";
        }
        finally
        {
            button.Enabled = true;
            RefreshNotionSecretStatus();
        }
    }

    private void LockNotion()
    {
        _notionVault?.Lock();
        if (_notionStatus is not null)
            _notionStatus.Text = "Notion: LOCKED";
        RefreshNotionSecretStatus();
    }

    private void ForgetNotion()
    {
        try
        {
            _notionVault?.Forget();
            if (_notionToken is not null)
                _notionToken.Text = string.Empty;
            _armedWorkItem = null;
            if (_overrideStatus is not null)
                _overrideStatus.Text = "Override: NOT ARMED";
            ResetNotionDiscovery();
            if (_notionStatus is not null)
                _notionStatus.Text = "Notion: TOKEN FORGOTTEN";
        }
        catch (InvalidOperationException ex)
        {
            if (_notionStatus is not null)
                _notionStatus.Text = $"Notion: {ex.Message}";
        }
        finally
        {
            RefreshNotionSecretStatus();
        }
    }

    private async Task DiscoverNotionPages(Button button)
    {
        if (_notionVault is null || _notionPages is null || _notionStatus is null)
            return;

        var token = _notionVault.GetUnlockedToken();
        if (string.IsNullOrWhiteSpace(token))
        {
            _notionStatus.Text = _notionVault.State == NotionSecretState.NotConfigured
                ? "Notion: CONFIGURE_TOKEN_FIRST"
                : "Notion: AUTH_REQUIRED — UNLOCK NOTION";
            return;
        }

        button.Enabled = false;
        _notionStatus.Text = "Notion: DISCOVERING PAGES";

        try
        {
            using var http = new HttpClient();
            var client = new NotionChecklistClient(http, token);
            _loadedNotionPages = await client.GetSharedPages(CancellationToken.None);
            _loadedNotionTasks = [];
            _armedWorkItem = null;

            var labels = _loadedNotionPages.Count == 0
                ? new[] { "(no shared pages found)" }
                : _loadedNotionPages.Select(page => page.Title).ToArray();

            _notionPages.Adapter = new ArrayAdapter<string>(this,
                global::Android.Resource.Layout.SimpleSpinnerItem,
                labels);
            _notionStatus.Text = $"Notion: CONNECTED — {_loadedNotionPages.Count} shared page(s)";
            if (_overrideStatus is not null)
                _overrideStatus.Text = "Override: NOT ARMED";
        }
        catch (InvalidOperationException ex)
        {
            _notionStatus.Text = $"Notion: {ex.Message}";
        }
        catch (HttpRequestException)
        {
            _notionStatus.Text = "Notion: NETWORK_FAILED";
        }
        finally
        {
            button.Enabled = true;
        }
    }

    private async Task LoadNotionTasks(Button button)
    {
        if (_notionVault is null || _notionPages is null || _notionTasks is null || _notionStatus is null)
            return;

        var token = _notionVault.GetUnlockedToken();
        if (string.IsNullOrWhiteSpace(token))
        {
            _notionStatus.Text = _notionVault.State == NotionSecretState.NotConfigured
                ? "Notion: CONFIGURE_TOKEN_FIRST"
                : "Notion: AUTH_REQUIRED — UNLOCK NOTION";
            return;
        }

        var selectedIndex = _notionPages.SelectedItemPosition;
        if (_loadedNotionPages.Count == 0 || selectedIndex < 0 || selectedIndex >= _loadedNotionPages.Count)
        {
            _notionStatus.Text = "Notion: DISCOVER_PAGES_FIRST";
            return;
        }

        button.Enabled = false;
        var selectedPage = _loadedNotionPages[selectedIndex];
        _notionStatus.Text = $"Notion: LOADING — {selectedPage.Title}";

        try
        {
            using var http = new HttpClient();
            var client = new NotionChecklistClient(http, token);
            _loadedNotionTasks = await client.GetTasks(selectedPage.PageId, includeChecked: false, CancellationToken.None);
            _armedWorkItem = null;
            var labels = _loadedNotionTasks.Count == 0
                ? new[] { "(no unchecked tasks found)" }
                : _loadedNotionTasks.Select(task => task.Text).ToArray();

            _notionTasks.Adapter = new ArrayAdapter<string>(this,
                global::Android.Resource.Layout.SimpleSpinnerItem,
                labels);
            _notionStatus.Text = $"Notion: CONNECTED — {_loadedNotionTasks.Count} unchecked task(s)";
            if (_overrideStatus is not null)
                _overrideStatus.Text = "Override: NOT ARMED";
        }
        catch (ArgumentException ex)
        {
            _notionStatus.Text = $"Notion: INVALID_PAGE — {ex.Message}";
        }
        catch (InvalidOperationException ex)
        {
            _notionStatus.Text = $"Notion: {ex.Message}";
        }
        catch (HttpRequestException)
        {
            _notionStatus.Text = "Notion: NETWORK_FAILED";
        }
        finally
        {
            button.Enabled = true;
        }
    }

    private void OpenChatGpt()
    {
        if (_chatGptStatus is null)
            return;

        _chatGptStatus.Text = TryLaunchChatGpt()
            ? "ChatGPT binding: LAUNCHED"
            : "ChatGPT binding: CHATGPT_LAUNCH_FAILED";
    }

    private bool TryLaunchChatGpt()
    {
        try
        {
            var launchIntent = PackageManager?.GetLaunchIntentForPackage(ChatGPTPackageIdentity.CandidatePackageName);
            if (launchIntent is null)
                return false;

            launchIntent.AddFlags(ActivityFlags.ReorderToFront);
            StartActivity(launchIntent);
            return true;
        }
        catch (Exception)
        {
            return false;
        }
    }

    private async Task DiscoverRecents(Button button)
    {
        if (_chatGptStatus is null || _recentChats is null)
            return;

        button.Enabled = false;
        _chatGptStatus.Text = "ChatGPT recents: LAUNCHING";

        try
        {
            if (!TryLaunchChatGpt())
            {
                _chatGptStatus.Text = "ChatGPT recents: CHATGPT_LAUNCH_FAILED";
                return;
            }

            var sidebarFailure = await WaitForSidebarOpen(CancellationToken.None);
            if (sidebarFailure is not null)
            {
                BringWorkerToFront();
                _chatGptStatus.Text = $"ChatGPT recents: {sidebarFailure}";
                return;
            }

            var recentsReady = await WaitUntil(
                () => AndroidAccessibilityService.SnapshotContainsExactText("Recents"),
                TimeSpan.FromSeconds(4),
                CancellationToken.None);

            if (!recentsReady)
            {
                BringWorkerToFront();
                _chatGptStatus.Text = "ChatGPT recents: RECENTS_SECTION_NOT_FOUND";
                return;
            }

            var discovery = AndroidAccessibilityService.DiscoverVisibleRecentChats();
            BringWorkerToFront();

            if (!discovery.Success)
            {
                _loadedRecentTitles = [];
                _recentChats.Adapter = new ArrayAdapter<string>(this,
                    global::Android.Resource.Layout.SimpleSpinnerItem,
                    new[] { "(recents discovery failed)" });
                _chatGptStatus.Text = $"ChatGPT recents: {discovery.FailureCode}";
                return;
            }

            _loadedRecentTitles = discovery.Titles;
            _recentChats.Adapter = new ArrayAdapter<string>(this,
                global::Android.Resource.Layout.SimpleSpinnerItem,
                _loadedRecentTitles.ToArray());
            _chatGptStatus.Text = $"ChatGPT recents: DISCOVERED — {_loadedRecentTitles.Count} visible conversation(s)";
            _armedWorkItem = null;
            if (_overrideStatus is not null)
                _overrideStatus.Text = "Override: NOT ARMED";
        }
        finally
        {
            button.Enabled = true;
        }
    }

    private async Task OpenSelectedRecent(Button button)
    {
        if (_chatGptStatus is null || _recentChats is null)
            return;

        var selectedIndex = _recentChats.SelectedItemPosition;
        if (_loadedRecentTitles.Count == 0 || selectedIndex < 0 || selectedIndex >= _loadedRecentTitles.Count)
        {
            _chatGptStatus.Text = "ChatGPT recents: DISCOVER_RECENTS_FIRST";
            return;
        }

        var title = _loadedRecentTitles[selectedIndex];
        button.Enabled = false;
        _chatGptStatus.Text = "ChatGPT recents: OPENING SELECTED CONVERSATION";

        try
        {
            if (!TryLaunchChatGpt())
            {
                _chatGptStatus.Text = "ChatGPT recents: CHATGPT_LAUNCH_FAILED";
                return;
            }

            var sidebarFailure = await WaitForSidebarOpen(CancellationToken.None);
            if (sidebarFailure is not null)
            {
                BringWorkerToFront();
                _chatGptStatus.Text = $"ChatGPT recents: {sidebarFailure}";
                return;
            }

            var recentsReady = await WaitUntil(
                () => AndroidAccessibilityService.SnapshotContainsExactText("Recents"),
                TimeSpan.FromSeconds(4),
                CancellationToken.None);
            if (!recentsReady)
            {
                BringWorkerToFront();
                _chatGptStatus.Text = "ChatGPT recents: RECENTS_SECTION_NOT_FOUND";
                return;
            }

            var failure = AndroidAccessibilityService.TryOpenRecentChat(title);
            if (failure is not null)
            {
                BringWorkerToFront();
                _chatGptStatus.Text = $"ChatGPT recents: {failure}";
                return;
            }

            _chatGptStatus.Text = $"ChatGPT recents: OPENED — {title}";
        }
        finally
        {
            button.Enabled = true;
        }
    }

    private static async Task<string?> WaitForSidebarOpen(CancellationToken cancellationToken)
    {
        var deadline = DateTimeOffset.UtcNow + TimeSpan.FromSeconds(6);
        string? lastFailure = null;

        while (DateTimeOffset.UtcNow < deadline)
        {
            cancellationToken.ThrowIfCancellationRequested();
            var failure = AndroidAccessibilityService.TryOpenRecentsSidebar();
            if (failure is null)
                return null;

            lastFailure = failure;
            await Task.Delay(150, cancellationToken);
        }

        return lastFailure ?? "ACCESSIBILITY_ROOT_UNAVAILABLE";
    }

    private static async Task<bool> WaitUntil(
        Func<bool> condition,
        TimeSpan timeout,
        CancellationToken cancellationToken)
    {
        var deadline = DateTimeOffset.UtcNow + timeout;
        while (DateTimeOffset.UtcNow < deadline)
        {
            cancellationToken.ThrowIfCancellationRequested();
            if (condition())
                return true;
            await Task.Delay(100, cancellationToken);
        }
        return condition();
    }

    private void BringWorkerToFront()
    {
        var intent = new Intent(this, typeof(BkeWorkerActivity));
        intent.AddFlags(ActivityFlags.ReorderToFront | ActivityFlags.SingleTop);
        StartActivity(intent);
    }

    private void RefreshChatGptBindingStatus()
    {
        if (_chatGptStatus is null)
            return;

        var nodeCount = AndroidAccessibilityService.LatestChatGptSnapshot.Count;
        var service = AndroidAccessibilityService.IsServiceConnected ? "service connected" : "service unavailable";
        _chatGptStatus.Text = nodeCount > 0
            ? $"ChatGPT binding: CONNECTED — {nodeCount} semantic node(s); {service}"
            : $"ChatGPT binding: WAITING — {service}";
    }

    private void ArmOverride()
    {
        if (_notionTasks is null || _context is null || _reasoning is null || _overrideStatus is null)
            return;

        var taskIndex = _notionTasks.SelectedItemPosition;
        if (_loadedNotionTasks.Count == 0 || taskIndex < 0 || taskIndex >= _loadedNotionTasks.Count)
        {
            _overrideStatus.Text = "Override: LOAD_AND_SELECT_NOTION_TASK_FIRST";
            return;
        }

        var task = _loadedNotionTasks[taskIndex];
        var contextIndex = _context.SelectedItemPosition;
        var project = _project?.Text?.Trim();
        var projectConversation = _conversation?.Text?.Trim();

        ContextTarget target;
        switch (contextIndex)
        {
            case 0:
                target = ContextTarget.NewChat();
                break;
            case 1:
                if (_recentChats is null || _loadedRecentTitles.Count == 0)
                {
                    _overrideStatus.Text = "Override: DISCOVER_RECENTS_FIRST";
                    return;
                }
                var recentIndex = _recentChats.SelectedItemPosition;
                if (recentIndex < 0 || recentIndex >= _loadedRecentTitles.Count)
                {
                    _overrideStatus.Text = "Override: SELECT_RECENT_CONVERSATION";
                    return;
                }
                target = new ContextTarget(ContextTargetType.RecentChat, _loadedRecentTitles[recentIndex]);
                break;
            case 2:
                if (string.IsNullOrWhiteSpace(project) || string.IsNullOrWhiteSpace(projectConversation))
                {
                    _overrideStatus.Text = "Override: PROJECT_AND_CONVERSATION_REQUIRED";
                    return;
                }
                target = new ContextTarget(ContextTargetType.ProjectChat, projectConversation, project);
                break;
            default:
                _overrideStatus.Text = "Override: CONTEXT_SELECTION_INVALID";
                return;
        }

        var selectedReasoning = _reasoning.SelectedItem?.ToString();
        if (!Enum.TryParse<ReasoningProfile>(selectedReasoning, out var reasoning))
        {
            _overrideStatus.Text = "Override: REASONING_SELECTION_INVALID";
            return;
        }

        _armedWorkItem = new WorkItem(task.BlockId, task.Text, target, reasoning);

        var targetLabel = target.Type switch
        {
            ContextTargetType.NewChat => "NEW CHAT",
            ContextTargetType.RecentChat => $"RECENTS → {target.Conversation}",
            ContextTargetType.ProjectChat => $"PROJECTS → {target.Project} → {target.Conversation}",
            _ => target.Type.ToString()
        };

        _overrideStatus.Text =
            $"Override: ARMED\nTask: {task.Text}\nTarget: {targetLabel}\nReasoning: {reasoning}\nExecution: NOT STARTED";
    }

    private void ResetNotionDiscovery()
    {
        _loadedNotionPages = [];
        _loadedNotionTasks = [];
        _armedWorkItem = null;

        if (_notionPages is not null)
            _notionPages.Adapter = new ArrayAdapter<string>(this,
                global::Android.Resource.Layout.SimpleSpinnerItem,
                new[] { "(discover shared pages)" });

        if (_notionTasks is not null)
            _notionTasks.Adapter = new ArrayAdapter<string>(this,
                global::Android.Resource.Layout.SimpleSpinnerItem,
                new[] { "(load unchecked checklist tasks)" });

        if (_overrideStatus is not null)
            _overrideStatus.Text = "Override: NOT ARMED";
    }

    private void RefreshNotionSecretStatus()
    {
        if (_notionSecretStatus is null || _notionVault is null)
            return;

        if (!_notionVault.IsDeviceAuthenticationConfigured)
        {
            _notionSecretStatus.Text = "Notion credential: DEVICE LOCK REQUIRED — configure PIN/password/fingerprint";
            return;
        }

        _notionSecretStatus.Text = _notionVault.State switch
        {
            NotionSecretState.NotConfigured => "Notion credential: NOT CONFIGURED",
            NotionSecretState.Locked => "Notion credential: LOCKED — fingerprint/PIN required",
            NotionSecretState.Unlocked => "Notion credential: UNLOCKED — token in memory only",
            _ => "Notion credential: UNKNOWN"
        };
    }

    private static string FormatNotionSecurityError(InvalidOperationException ex) =>
        ex.Message == "NOTION_DEVICE_LOCK_REQUIRED"
            ? "DEVICE_LOCK_REQUIRED — enable a secure screen lock"
            : ex.Message;

    private void RefreshStatus()
    {
        if (_status is null) return;
        var accessibility = IsAccessibilityEnabled() ? "ENABLED" : "DISABLED";
        var chatGpt = GetChatGPTInstallStatus();
        _status.Text = $"Accessibility: {accessibility}\nChatGPT: {chatGpt}\nState: Idle\nReal ChatGPT execution: NOT TESTED";
    }

    private string GetChatGPTInstallStatus()
    {
        try
        {
            return PackageManager?.GetApplicationInfo(ChatGPTPackageIdentity.CandidatePackageName, 0) is not null
                ? "INSTALLED"
                : "UNKNOWN";
        }
        catch (Exception)
        {
            return "UNKNOWN";
        }
    }

    private bool IsAccessibilityEnabled() =>
        Settings.Secure.GetString(ContentResolver, Settings.Secure.EnabledAccessibilityServices)?
            .Contains(PackageName!, StringComparison.OrdinalIgnoreCase) == true;

    private void ShowProbeIntent()
    {
        Toast.MakeText(this, "Probe captured locally. Accessibility binding is ready for emulator testing.", ToastLength.Long)?.Show();
    }
}
