using Android.AccessibilityServices;
using Android.Views.Accessibility;
using BKE.Worker.Platform.Android.Configuration;

namespace BKE.Worker.Platform.Android.Accessibility;

public class AndroidAccessibilityService : AccessibilityService
{
    private readonly object _sync = new();
    private AccessibilityNodeInfo? _root;
    private bool _connected;

    public bool IsConnected => _connected;
    public AccessibilityNodeInfo? CurrentRoot { get { lock (_sync) return _root; } }
    public event Action<string>? SafeEvent;

    public override void OnAccessibilityEvent(AccessibilityEvent? e)
    {
        if (e?.PackageName?.ToString() != ChatGPTPackageIdentity.CandidatePackageName) return;
        lock (_sync) _root = RootInActiveWindow;
        SafeEvent?.Invoke($"ChatGPT event={e.EventType}; root={(CurrentRoot is null ? "missing" : "available")}");
    }

    public override void OnInterrupt() => SafeEvent?.Invoke("Accessibility service interrupted.");

    protected override void OnServiceConnected()
    {
        base.OnServiceConnected();
        _connected = true;
        SafeEvent?.Invoke("Accessibility service connected.");
    }

    public override void OnDestroy()
    {
        _connected = false;
        lock (_sync) _root = null;
        base.OnDestroy();
    }
}

public sealed class AndroidAccessibilitySurface(AndroidAccessibilityService service) : IAccessibilitySurface
{
    public IReadOnlyList<IAccessibilityNode> Snapshot() =>
        service.CurrentRoot is { } root ? [new AndroidAccessibilityNodeAdapter(root)] : [];
    public bool LaunchChatGPT() => false;
    public bool Back() => service.PerformGlobalAction(GlobalActionBack);
    public bool ScrollForward() => false;
    public bool Paste(string text) => false;
}
