using Android.OS;
using Android.Views.Accessibility;

namespace BKE.Worker.Platform.Android.Accessibility;

public sealed class AndroidAccessibilityNodeAdapter(AccessibilityNodeInfo node) : IAccessibilityNode
{
    private const string ActionArgumentSetTextCharSequence = "ACTION_ARGUMENT_SET_TEXT_CHARSEQUENCE";

    public string? Text => node.Text?.ToString();
    public string? ContentDescription => node.ContentDescription?.ToString();
    public string? ResourceId => node.ViewIdResourceName;
    public bool IsClickable => node.Clickable;
    public bool IsEditable => node.Editable;
    public IReadOnlyList<IAccessibilityNode> Children =>
        Enumerable.Range(0, node.ChildCount)
            .Select(index => node.GetChild(index))
            .Where(child => child is not null)
            .Select(child => (IAccessibilityNode)new AndroidAccessibilityNodeAdapter(child!))
            .ToArray();

    public bool Click() => node.PerformAction(global::Android.Views.Accessibility.Action.Click);

    public bool SetText(string text)
    {
        var args = new Bundle();
        args.PutCharSequence(ActionArgumentSetTextCharSequence, text);
        return node.PerformAction(global::Android.Views.Accessibility.Action.SetText, args);
    }
}
