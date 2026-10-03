#!/usr/bin/env python3
from pathlib import Path

root = Path(__file__).resolve().parents[1]
base = root / "android-gecko/app/src/main"
service = (base / "kotlin/com/bke/worker/gecko/AndroidGeckoWorkerService.kt").read_text(encoding="utf-8")
activity = (base / "kotlin/com/bke/worker/gecko/MainActivity.kt").read_text(encoding="utf-8")
runtime = (base / "kotlin/com/bke/worker/gecko/GeckoRuntimeProvider.kt").read_text(encoding="utf-8")
manifest = (base / "AndroidManifest.xml").read_text(encoding="utf-8")
ext_manifest = (base / "assets/worker-extension/manifest.json").read_text(encoding="utf-8")
probe = (base / "assets/worker-extension/worker-probe.js").read_text(encoding="utf-8")

for token in (
    "class AndroidGeckoWorkerService : Service()",
    "private val workerSession = GeckoSession()",
    "workerSession.open(runtime)",
    "ensureBuiltIn(EXTENSION_URI, EXTENSION_ID)",
    "setMessageDelegate(",
    "workerSession.loadUri(CHATGPT_URL)",
    "return START_STICKY",
    'WORKER_ID = "android-worker-a"',
):
    assert token in service, token

assert "PowerManager" not in service
assert "WakeLock" not in service
assert "GeckoRuntime.create(context.applicationContext)" in runtime

for token in (
    "geckoView.setSession(session)",
    "geckoView.releaseSession()",
    "override fun onStop()",
    "AndroidGeckoWorkerService.ensureRunning(this@MainActivity)",
):
    assert token in activity, token

for token in (
    'android:name=".AndroidGeckoWorkerService"',
    'android:exported="false"',
    'android:foregroundServiceType="specialUse"',
    'android:stopWithTask="false"',
    "android.permission.POST_NOTIFICATIONS",
):
    assert token in manifest, token

for token in (
    '"manifest_version": 2',
    '"nativeMessaging"',
    '"nativeMessagingFromContent"',
    '"geckoViewAddons"',
    '"https://chatgpt.com/*"',
    '"worker-probe.js"',
):
    assert token in ext_manifest, token

for token in (
    '[data-testid="prompt-textarea"]',
    '[data-testid="stop-button"]',
    "browser.runtime.sendNativeMessage(NATIVE_APP, payload)",
    "composerAvailable",
    "turnBusy",
):
    assert token in probe, token

for forbidden in (
    "document.body.innerText",
    ".textContent",
    "document.cookie",
    "Authorization",
    "localStorage",
    "sessionStorage",
):
    assert forbidden not in probe, forbidden

print("BKE Worker Android Gecko probe contract: PASS")
