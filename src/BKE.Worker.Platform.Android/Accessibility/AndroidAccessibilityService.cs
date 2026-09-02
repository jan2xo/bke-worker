using Android.AccessibilityServices;
using Android.Views.Accessibility;
using BKE.Worker.Platform.Android.Configuration;

namespace BKE.Worker.Platform.Android.Accessibility;

public sealed record AccessibilitySemanticNode(
    string? Text,
    string? ContentDescription,
    string? ResourceId,
    bool ClickableContext,
    int Depth);

public class AndroidAccessibilityService : AccessibilityService
{
    private readonly object _sync = new();
    private static readonly object SnapshotSync = new();
    private static IReadOnlyList<AccessibilitySemanticNode> _latestChatGptSnapshot = [];
    private AccessibilityNodeInfo? _root;
    private bool _connected;

    public bool IsConnected => _connected;
    public AccessibilityNodeInfo? CurrentRoot { get { lock (_sync) return _root; } }
    public static IReadOnlyList<AccessibilitySemanticNode> LatestChatGptSnapshot
    {
        get { lock (SnapshotSync) return _latestChatGptSnapshot.ToArray(); }
    }

    public event Action<string>? SafeEvent;

    public override void OnAccessibilityEvent(AccessibilityEvent? e)
    {
        if (e?.PackageName?.ToString() != ChatGPTPackageIdentity.CandidatePackageName) return;

        var root = RootInActiveWindow;
        lock (_sync) _root = root;

        if (root is not null)
        {
            var snapshot = new List<AccessibilitySemanticNode>();
            Capture(root, false, 0, snapshot);
            lock (SnapshotSync) _latestChatGptSnapshot = snapshot;
        }

        SafeEvent?.Invoke($"ChatGPT event={e.EventType}; root={(root is null ? "missing" : "available")}");
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

    private static void Capture(
        AccessibilityNodeInfo node,
        bool clickableAncestor,
        int depth,
        ICollection<AccessibilitySemanticNode> snapshot)
    {
        var clickableContext = clickableAncestor || node.Clickable;
        var text = node.Text?.ToString();
        var description = node.ContentDescription?.ToString();
        var resourceId = node.ViewIdResourceName;

        if (!string.IsNullOrWhiteSpace(text) ||
            !string.IsNullOrWhiteSpace(description) ||
            !string.IsNullOrWhiteSpace(resourceId))
        {
            snapshot.Add(new AccessibilitySemanticNode(
                text,
                description,
                resourceId,
                clickableContext,
                depth));
        }

        for (var index = 0; index < node.ChildCount; index++)
        {
            var child = node.GetChild(index);
            if (child is not null)
                Capture(child, clickableContext, depth + 1, snapshot);
        }
    }
}

public sealed class AndroidAccessibilitySurface(AndroidAccessibilityService service) : IAccessibilitySurface
{
    public IReadOnlyList<IAccessibilityNode> Snapshot() =>
        service.CurrentRoot is { } root ? [new AndroidAccessibilityNodeAdapter(root)] : [];
    public bool LaunchChatGPT() => false;
    public bool Back() => service.PerformGlobalAction(global::Android.AccessibilityServices.GlobalAction.Back);
    public bool ScrollForward() => false;
    public bool Paste(string text) => false;
}
