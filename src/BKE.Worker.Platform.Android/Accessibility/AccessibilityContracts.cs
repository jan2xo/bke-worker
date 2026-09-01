namespace BKE.Worker.Platform.Android.Accessibility;

public interface IAccessibilityNode
{
    string? Text { get; }
    string? ContentDescription { get; }
    string? ResourceId { get; }
    bool IsClickable { get; }
    bool IsEditable { get; }
    IReadOnlyList<IAccessibilityNode> Children { get; }
    bool Click();
    bool SetText(string text);
}

public interface IAccessibilitySurface
{
    IReadOnlyList<IAccessibilityNode> Snapshot();
    bool LaunchChatGPT();
    bool Back();
    bool ScrollForward();
    bool Paste(string text);
}
