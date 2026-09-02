using Android.App;
using Android.Content;
using Android.OS;
using Android.Provider;
using Android.Text;
using Android.Widget;
using BKE.Worker.Core;
using BKE.Worker.Notion;
using BKE.Worker.Platform.Android.Configuration;

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
    private Spinner? _notionTasks;
    private Spinner? _context;
    private Spinner? _reasoning;
    private EditText? _conversation;
    private EditText? _project;
    private EditText? _probe;
    private EditText? _notionToken;
    private EditText? _notionPage;

    protected override void OnCreate(Bundle? savedInstanceState)
    {
        base.OnCreate(savedInstanceState);
        ActionBar?.Hide();
        BuildUi();
    }

    protected override void OnResume()
    {
        base.OnResume();
        RefreshStatus();
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

        _notionToken = new EditText(this) { Hint = "Notion access token (memory only)" };
        _notionToken.InputType = InputTypes.ClassText | InputTypes.TextVariationPassword;
        layout.AddView(_notionToken);

        _notionPage = new EditText(this) { Hint = "Notion checklist page ID or URL" };
        layout.AddView(_notionPage);

        var loadNotion = new Button(this) { Text = "LOAD NOTION TASKS" };
        loadNotion.Click += async (_, _) => await LoadNotionTasks(loadNotion);
        layout.AddView(loadNotion);

        _notionStatus = new TextView(this) { Text = "Notion: NOT CONNECTED" };
        layout.AddView(_notionStatus);

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
    }

    private async Task LoadNotionTasks(Button button)
    {
        if (_notionToken is null || _notionPage is null || _notionTasks is null || _notionStatus is null)
            return;

        var token = _notionToken.Text?.Trim();
        var page = _notionPage.Text?.Trim();
        if (string.IsNullOrWhiteSpace(token) || string.IsNullOrWhiteSpace(page))
        {
            _notionStatus.Text = "Notion: TOKEN_AND_PAGE_REQUIRED";
            return;
        }

        button.Enabled = false;
        _notionStatus.Text = "Notion: LOADING";

        try
        {
            using var http = new HttpClient();
            var client = new NotionChecklistClient(http, token);
            var tasks = await client.GetTasks(page, includeChecked: false, CancellationToken.None);
            var labels = tasks.Count == 0
                ? new[] { "(no unchecked tasks found)" }
                : tasks.Select(task => task.Text).ToArray();

            _notionTasks.Adapter = new ArrayAdapter<string>(this,
                global::Android.Resource.Layout.SimpleSpinnerItem,
                labels);
            _notionStatus.Text = $"Notion: CONNECTED — {tasks.Count} unchecked task(s)";
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
