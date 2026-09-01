using Android.App;
using Android.Content;
using Android.OS;
using Android.Provider;
using Android.Widget;
using BKE.Worker.Core;
using BKE.Worker.Platform.Android.Configuration;

namespace BKE.Worker.Platform.Android;

[Activity(
    Name = "bke.worker.android.BkeWorkerActivity",
    Exported = true,
    Label = "BKE Worker",
    MainLauncher = true)]
public sealed class BkeWorkerActivity : Activity
{
    private readonly TextView _status = new() { };
    private Spinner? _context;
    private Spinner? _reasoning;
    private EditText? _conversation;
    private EditText? _project;
    private EditText? _probe;

    protected override void OnCreate(Bundle? savedInstanceState)
    {
        base.OnCreate(savedInstanceState);
        BuildUi();
    }

    protected override void OnResume()
    {
        base.OnResume();
        RefreshStatus();
    }

    private void BuildUi()
    {
        var layout = new LinearLayout(this) { Orientation = Orientation.Vertical };
        layout.SetPadding(32, 32, 32, 32);
        layout.AddView(new TextView(this) { Text = "BKE Worker", TextSize = 24 });
        layout.AddView(_status);

        var settings = new Button(this) { Text = "OPEN ACCESSIBILITY SETTINGS" };
        settings.Click += (_, _) => StartActivity(new Intent(Settings.ActionAccessibilitySettings));
        layout.AddView(settings);

        _context = new Spinner(this);
        _context.Adapter = new ArrayAdapter<string>(this, Android.Resource.Layout.SimpleSpinnerItem,
            ["NewChat", "RecentChat", "ProjectChat"]);
        layout.AddView(_context);

        _project = new EditText(this) { Hint = "ProjectName (ProjectChat only)" };
        layout.AddView(_project);
        _conversation = new EditText(this) { Hint = "ConversationName (optional)" };
        layout.AddView(_conversation);

        _reasoning = new Spinner(this);
        _reasoning.Adapter = new ArrayAdapter<string>(this, Android.Resource.Layout.SimpleSpinnerItem,
            Enum.GetNames<ReasoningProfile>());
        _reasoning.SetSelection(Array.IndexOf(Enum.GetNames<ReasoningProfile>(), nameof(ReasoningProfile.HIGH)));
        layout.AddView(_reasoning);

        _probe = new EditText(this) { Text = "BKE WORKER TEST 001.\n\nReply with exactly:\n\nBKE_WORKER_OK", MinLines = 4 };
        layout.AddView(_probe);

        var run = new Button(this) { Text = "RUN PROBE" };
        run.Click += (_, _) => ShowProbeIntent();
        layout.AddView(run);

        layout.AddView(new TextView(this) { Text = "State / local event log" });
        layout.AddView(_status);
        SetContentView(layout);
        RefreshStatus();
    }

    private void RefreshStatus()
    {
        if (_status is null) return;
        var accessibility = IsAccessibilityEnabled() ? "ENABLED" : "DISABLED";
        var chatGpt = PackageManager?.GetApplicationInfo(ChatGPTPackageIdentity.CandidatePackageName, 0) is not null ? "INSTALLED" : "UNKNOWN";
        _status.Text = $"Accessibility: {accessibility}\nChatGPT: {chatGpt}\nState: Idle\nReal ChatGPT execution: NOT TESTED";
    }

    private bool IsAccessibilityEnabled() =>
        Settings.Secure.GetString(ContentResolver, Settings.Secure.EnabledAccessibilityServices)?
            .Contains(PackageName!, StringComparison.OrdinalIgnoreCase) == true;

    private void ShowProbeIntent()
    {
        Toast.MakeText(this, "Probe captured locally. Accessibility binding is ready for emulator testing.", ToastLength.Long)?.Show();
    }
}
