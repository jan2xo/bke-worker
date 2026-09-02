using Android.App;
using Android.Content;
using Android.OS;
using Android.Provider;
using Android.Text;
using Android.Widget;
using BKE.Worker.Core;
using BKE.Worker.Notion;
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
    private Spinner? _notionPages;
    private Spinner? _notionTasks;
    private Spinner? _context;
    private Spinner? _reasoning;
    private EditText? _conversation;
    private EditText? _project;
    private EditText? _probe;
    private EditText? _notionToken;
    private AndroidNotionSecretVault? _notionVault;
    private IReadOnlyList<NotionPageSummary> _loadedNotionPages = [];
    private IReadOnlyList<NotionChecklistTask> _loadedNotionTasks = [];

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
    }

    protected override void OnDestroy()
    {
        _notionVault?.Lock();
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

        layout.AddView(new TextView(this) { Text = "CHATS" });
        _context = new Spinner(this);
        _context.Adapter = new ArrayAdapter<string>(this, global::Android.Resource.Layout.SimpleSpinnerItem,
            new[] { "NEW CHAT", "RECENTS", "PROJECTS" });
        _context.SetSelection(1);
        layout.AddView(_context);

        _project = new EditText(this) { Hint = "Project (PROJECTS only)" };
        layout.AddView(_project);
        _conversation = new EditText(this) { Hint = "Conversation override" };
        layout.AddView(_conversation);

        _reasoning = new Spinner(this);
        _reasoning.Adapter = new ArrayAdapter<string>(this, global::Android.Resource.Layout.SimpleSpinnerItem,
            Enum.GetNames<ReasoningProfile>());
        _reasoning.SetSelection(Array.IndexOf(Enum.GetNames<ReasoningProfile>(), nameof(ReasoningProfile.HIGH)));
        layout.AddView(_reasoning);

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
            _notionStatus.Text = $"Notion: {ex.Message}";
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
            _notionStatus.Text = $"Notion: {ex.Message}";
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

            var labels = _loadedNotionPages.Count == 0
                ? new[] { "(no shared pages found)" }
                : _loadedNotionPages.Select(page => page.Title).ToArray();

            _notionPages.Adapter = new ArrayAdapter<string>(this,
                global::Android.Resource.Layout.SimpleSpinnerItem,
                labels);
            _notionStatus.Text = $"Notion: CONNECTED — {_loadedNotionPages.Count} shared page(s)";
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
            var labels = _loadedNotionTasks.Count == 0
                ? new[] { "(no unchecked tasks found)" }
                : _loadedNotionTasks.Select(task => task.Text).ToArray();

            _notionTasks.Adapter = new ArrayAdapter<string>(this,
                global::Android.Resource.Layout.SimpleSpinnerItem,
                labels);
            _notionStatus.Text = $"Notion: CONNECTED — {_loadedNotionTasks.Count} unchecked task(s)";
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

    private void ResetNotionDiscovery()
    {
        _loadedNotionPages = [];
        _loadedNotionTasks = [];

        if (_notionPages is not null)
            _notionPages.Adapter = new ArrayAdapter<string>(this,
                global::Android.Resource.Layout.SimpleSpinnerItem,
                new[] { "(discover shared pages)" });

        if (_notionTasks is not null)
            _notionTasks.Adapter = new ArrayAdapter<string>(this,
                global::Android.Resource.Layout.SimpleSpinnerItem,
                new[] { "(load unchecked checklist tasks)" });
    }

    private void RefreshNotionSecretStatus()
    {
        if (_notionSecretStatus is null || _notionVault is null)
            return;

        _notionSecretStatus.Text = _notionVault.State switch
        {
            NotionSecretState.NotConfigured => "Notion credential: NOT CONFIGURED",
            NotionSecretState.Locked => "Notion credential: LOCKED — fingerprint/PIN required",
            NotionSecretState.Unlocked => "Notion credential: UNLOCKED — token in memory only",
            _ => "Notion credential: UNKNOWN"
        };
    }

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
