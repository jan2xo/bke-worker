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

public sealed record RecentChatDiscoveryResult(
    bool Success,
    IReadOnlyList<string> Titles,
    string? FailureCode = null);

public class AndroidAccessibilityService : AccessibilityService
{
    private readonly object _sync = new();
    private static readonly object SnapshotSync = new();
    private static readonly object ServiceSync = new();
    private static IReadOnlyList<AccessibilitySemanticNode> _latestChatGptSnapshot = [];
    private static AndroidAccessibilityService? _activeService;
    private AccessibilityNodeInfo? _root;
    private bool _connected;

    public bool IsConnected => _connected;
    public AccessibilityNodeInfo? CurrentRoot { get { lock (_sync) return _root; } }
    public static bool IsServiceConnected { get { lock (ServiceSync) return _activeService is not null; } }

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
            RefreshSnapshot(root);

        SafeEvent?.Invoke($"ChatGPT event={e.EventType}; root={(root is null ? "missing" : "available")}");
    }

    public override void OnInterrupt() => SafeEvent?.Invoke("Accessibility service interrupted.");

    protected override void OnServiceConnected()
    {
        base.OnServiceConnected();
        _connected = true;
        lock (ServiceSync) _activeService = this;
        SafeEvent?.Invoke("Accessibility service connected.");
    }

    public override void OnDestroy()
    {
        _connected = false;
        lock (_sync) _root = null;
        lock (ServiceSync)
        {
            if (ReferenceEquals(_activeService, this))
                _activeService = null;
        }
        base.OnDestroy();
    }

    public static string? TryOpenRecentsSidebar()
    {
        var service = GetActiveService();
        if (service is null)
            return "ACCESSIBILITY_SERVICE_UNAVAILABLE";

        var root = service.RootInActiveWindow;
        if (root is null || root.PackageName?.ToString() != ChatGPTPackageIdentity.CandidatePackageName)
            return "ACCESSIBILITY_ROOT_UNAVAILABLE";

        if (ContainsExactText(root, "Recents"))
        {
            service.RefreshSnapshot(root);
            return null;
        }

        var trigger = FindFirst(root, IsSemanticSidebarTrigger);
        if (trigger is null)
        {
            var structural = FindUniqueShallowestUnlabeledClickableView(root);
            if (structural.FailureCode is not null)
                return structural.FailureCode;
            trigger = structural.Node;
        }

        if (trigger is null)
            return "CHATGPT_SIDEBAR_TRIGGER_NOT_FOUND";

        if (!trigger.PerformAction(global::Android.Views.Accessibility.Action.Click))
            return "CHATGPT_SIDEBAR_OPEN_FAILED";

        return null;
    }

    public static RecentChatDiscoveryResult DiscoverVisibleRecentChats()
    {
        var snapshot = LatestChatGptSnapshot;
        if (snapshot.Count == 0)
            return new(false, [], "ACCESSIBILITY_ROOT_UNAVAILABLE");

        var recentsIndex = FindSemanticIndex(snapshot, "Recents");
        if (recentsIndex < 0)
            return new(false, [], "RECENTS_SECTION_NOT_FOUND");

        var endIndex = FindRecentsEndIndex(snapshot, recentsIndex + 1);
        if (endIndex < 0)
            return new(false, [], "RECENTS_END_ANCHOR_NOT_FOUND");

        var titles = snapshot
            .Skip(recentsIndex + 1)
            .Take(endIndex - recentsIndex - 1)
            .Where(node => node.ClickableContext && !string.IsNullOrWhiteSpace(node.Text))
            .Select(node => node.Text!.Trim())
            .Where(text => !IsFixedNavigationLabel(text))
            .Distinct(StringComparer.Ordinal)
            .ToArray();

        return titles.Length == 0
            ? new(false, [], "RECENT_CHATS_NOT_FOUND")
            : new(true, titles);
    }

    public static string? TryOpenRecentChat(string title)
    {
        if (string.IsNullOrWhiteSpace(title))
            return "RECENT_CONVERSATION_REQUIRED";

        var service = GetActiveService();
        if (service is null)
            return "ACCESSIBILITY_SERVICE_UNAVAILABLE";

        var root = service.RootInActiveWindow;
        if (root is null || root.PackageName?.ToString() != ChatGPTPackageIdentity.CandidatePackageName)
            return "ACCESSIBILITY_ROOT_UNAVAILABLE";

        var matches = new List<(AccessibilityNodeInfo Node, int Depth)>();
        FindClickableContainers(root, title.Trim(), 0, matches);
        if (matches.Count == 0)
            return "CONTEXT_NOT_FOUND";

        var deepest = matches.Max(match => match.Depth);
        var candidates = matches.Where(match => match.Depth == deepest).ToArray();
        if (candidates.Length != 1)
            return "CONVERSATION_AMBIGUOUS";

        return candidates[0].Node.PerformAction(global::Android.Views.Accessibility.Action.Click)
            ? null
            : "CONTEXT_OPEN_FAILED";
    }

    public static bool SnapshotContainsExactText(string text) =>
        LatestChatGptSnapshot.Any(node => string.Equals(node.Text?.Trim(), text, StringComparison.Ordinal));

    private static AndroidAccessibilityService? GetActiveService()
    {
        lock (ServiceSync) return _activeService;
    }

    private void RefreshSnapshot(AccessibilityNodeInfo root)
    {
        var snapshot = new List<AccessibilitySemanticNode>();
        Capture(root, false, 0, snapshot);
        lock (SnapshotSync) _latestChatGptSnapshot = snapshot;
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

    private static AccessibilityNodeInfo? FindFirst(
        AccessibilityNodeInfo node,
        Func<AccessibilityNodeInfo, bool> predicate)
    {
        if (predicate(node))
            return node;

        for (var index = 0; index < node.ChildCount; index++)
        {
            var child = node.GetChild(index);
            if (child is null)
                continue;

            var match = FindFirst(child, predicate);
            if (match is not null)
                return match;
        }

        return null;
    }

    private static bool IsSemanticSidebarTrigger(AccessibilityNodeInfo node)
    {
        if (!node.Clickable)
            return false;

        var semanticLabel = string.Join(' ', new[]
        {
            node.ContentDescription?.ToString(),
            node.Text?.ToString(),
            node.ViewIdResourceName
        }.Where(value => !string.IsNullOrWhiteSpace(value))).ToLowerInvariant();

        return semanticLabel.Contains("menu", StringComparison.Ordinal) ||
               semanticLabel.Contains("navigation", StringComparison.Ordinal) ||
               semanticLabel.Contains("sidebar", StringComparison.Ordinal) ||
               semanticLabel.Contains("drawer", StringComparison.Ordinal);
    }

    private static (AccessibilityNodeInfo? Node, string? FailureCode) FindUniqueShallowestUnlabeledClickableView(
        AccessibilityNodeInfo root)
    {
        var candidates = new List<(AccessibilityNodeInfo Node, int Depth)>();
        CollectUnlabeledClickableViews(root, 0, candidates);

        if (candidates.Count == 0)
            return (null, "CHATGPT_SIDEBAR_TRIGGER_NOT_FOUND");

        var shallowestDepth = candidates.Min(candidate => candidate.Depth);
        var shallowest = candidates.Where(candidate => candidate.Depth == shallowestDepth).ToArray();
        if (shallowest.Length != 1)
            return (null, "CHATGPT_SIDEBAR_STRUCTURAL_TRIGGER_AMBIGUOUS");

        return (shallowest[0].Node, null);
    }

    private static void CollectUnlabeledClickableViews(
        AccessibilityNodeInfo node,
        int depth,
        ICollection<(AccessibilityNodeInfo Node, int Depth)> candidates)
    {
        if (node.Clickable &&
            !node.Editable &&
            string.Equals(node.ClassName?.ToString(), "android.view.View", StringComparison.Ordinal) &&
            string.IsNullOrWhiteSpace(node.Text?.ToString()) &&
            string.IsNullOrWhiteSpace(node.ContentDescription?.ToString()) &&
            string.IsNullOrWhiteSpace(node.ViewIdResourceName) &&
            !ContainsEditableDescendant(node))
        {
            candidates.Add((node, depth));
        }

        for (var index = 0; index < node.ChildCount; index++)
        {
            var child = node.GetChild(index);
            if (child is not null)
                CollectUnlabeledClickableViews(child, depth + 1, candidates);
        }
    }

    private static bool ContainsEditableDescendant(AccessibilityNodeInfo node)
    {
        for (var index = 0; index < node.ChildCount; index++)
        {
            var child = node.GetChild(index);
            if (child is null)
                continue;

            if (child.Editable || ContainsEditableDescendant(child))
                return true;
        }

        return false;
    }

    private static bool ContainsExactText(AccessibilityNodeInfo node, string text)
    {
        if (string.Equals(node.Text?.ToString()?.Trim(), text, StringComparison.Ordinal))
            return true;

        for (var index = 0; index < node.ChildCount; index++)
        {
            var child = node.GetChild(index);
            if (child is not null && ContainsExactText(child, text))
                return true;
        }

        return false;
    }

    private static void FindClickableContainers(
        AccessibilityNodeInfo node,
        string exactTitle,
        int depth,
        ICollection<(AccessibilityNodeInfo Node, int Depth)> matches)
    {
        if (node.Clickable && ContainsExactText(node, exactTitle))
            matches.Add((node, depth));

        for (var index = 0; index < node.ChildCount; index++)
        {
            var child = node.GetChild(index);
            if (child is not null)
                FindClickableContainers(child, exactTitle, depth + 1, matches);
        }
    }

    private static int FindSemanticIndex(IReadOnlyList<AccessibilitySemanticNode> snapshot, string exactText)
    {
        for (var index = 0; index < snapshot.Count; index++)
        {
            if (string.Equals(snapshot[index].Text?.Trim(), exactText, StringComparison.Ordinal))
                return index;
        }

        return -1;
    }

    private static int FindRecentsEndIndex(IReadOnlyList<AccessibilitySemanticNode> snapshot, int startIndex)
    {
        for (var index = startIndex; index < snapshot.Count; index++)
        {
            var text = snapshot[index].Text?.Trim();
            if (string.Equals(text, "See all…", StringComparison.Ordinal) ||
                string.Equals(text, "See all...", StringComparison.Ordinal) ||
                string.Equals(text, "See all", StringComparison.Ordinal))
                return index;
        }

        return -1;
    }

    private static bool IsFixedNavigationLabel(string text) =>
        text is "Images" or "Library" or "Projects" or "Scheduled" or "Plugins" or
            "Chat" or "New chat" or "Search" or "Account settings" or "Temporary chat";
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
