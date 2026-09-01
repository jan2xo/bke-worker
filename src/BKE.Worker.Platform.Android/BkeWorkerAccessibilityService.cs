using BKE.Worker.Platform.Android.Accessibility;

namespace BKE.Worker.Platform.Android;

[global::Android.App.Service(
    Name = "bke.worker.android.BkeWorkerAccessibilityService",
    Permission = "android.permission.BIND_ACCESSIBILITY_SERVICE",
    Exported = true,
    Label = "BKE Worker Accessibility")]
[global::Android.App.IntentFilter(new[] { "android.accessibilityservice.AccessibilityService" })]
[global::Android.App.MetaData(
    "android.accessibilityservice",
    Resource = "@xml/bke_worker_accessibility_service")]
public sealed class BkeWorkerAccessibilityService : AndroidAccessibilityService
{
}
