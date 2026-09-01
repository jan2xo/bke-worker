using BKE.Worker.Platform.Android.Accessibility;

namespace BKE.Worker.Platform.Android;

[global::Android.App.Service(
    Name = "bke.worker.android.BkeWorkerAccessibilityService",
    Permission = "android.permission.BIND_ACCESSIBILITY_SERVICE",
    Exported = true,
    Label = "BKE Worker Accessibility")]
public sealed class BkeWorkerAccessibilityService : AndroidAccessibilityService
{
}
