using Android.OS;
using Android.Views.Accessibility;

namespace BKE.Worker.Platform.Android.Accessibility;

public sealed class AndroidAccessibilityNodeAdapter(AccessibilityNodeInfo node) : IAccessibilityNode
{
    public string? Text => node.Text?.ToString();
    public string? ContentDescription => node.ContentDescription?.ToString();
    public string? ResourceId => node.ViewIdResourceName;
    public bool IsClickable => node.IsClickable;
    public bool IsEditable => node.IsEditable;
    public IReadOnlyList<IAccessibilityNode> Children =>
        Enumerable.Range(0, node.ChildCount)
            .Select(node.GetChild)
            .Where(child => child is not null)
            .Select(child => (IAccessibilityNode)new AndroidAccessibilityNodeAdapter(child!))
            .ToArray();

    public bool Click() => node.PerformAction(AccessibilityNodeInfo.ActionClick);
    public bool SetText(string text)
    {
        var args = new Bundle();
        args.PutCharSequence(AccessibilityNodeInfo.ActionArgumentSetTextCharSequence, text);
        return node.PerformAction(AccessibilityNodeInfo.ActionSetText, args);
    }
}
