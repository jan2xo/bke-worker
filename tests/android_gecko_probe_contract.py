#!/usr/bin/env python3
from pathlib import Path

root = Path(__file__).resolve().parents[1]
base = root / "android-gecko/app/src/main"
service = (base / "kotlin/com/bke/worker/gecko/AndroidGeckoWorkerService.kt").read_text(encoding="utf-8")
activity = (base / "kotlin/com/bke/worker/gecko/MainActivity.kt").read_text(encoding="utf-8")
runtime = (base / "kotlin/com/bke/worker/gecko/GeckoRuntimeProvider.kt").read_text(encoding="utf-8")
relay_protocol = (base / "kotlin/com/bke/worker/gecko/RelayProtocol.kt").read_text(encoding="utf-8")
relay_client = (base / "kotlin/com/bke/worker/gecko/RelayWebSocketClient.kt").read_text(encoding="utf-8")
manifest = (base / "AndroidManifest.xml").read_text(encoding="utf-8")
ext_manifest = (base / "assets/worker-extension/manifest.json").read_text(encoding="utf-8")
probe = (base / "assets/worker-extension/worker-probe.js").read_text(encoding="utf-8")
build = (root / "android-gecko/app/build.gradle.kts").read_text(encoding="utf-8")

for token in (
    "class AndroidGeckoWorkerService : Service()",
    "private val workerSession = GeckoSession()",
    "workerSession.open(runtime)",
    "ensureBuiltIn(EXTENSION_URI, EXTENSION_ID)",
    "setMessageDelegate(",
    "workerSession.loadUri(CHATGPT_URL)",
    "return START_STICKY",
    'DEFAULT_WORKER_ID = "android-worker-a"',
    "RelayWebSocketClient(",
    "handleRelayWake",
    "dispatchWake",
    "RECENT_DELIVERY_LIMIT = 64",
    "data class AndroidWorkerStatusSnapshot(",
    "fun statusSnapshot(): AndroidWorkerStatusSnapshot",
    "chatGptState = workerState",
    "relayState = relayState",
):
    assert token in service, token

assert "PowerManager" not in service
assert "WakeLock" not in service
assert "GeckoRuntime.create(context.applicationContext)" in runtime

for token in (
    "geckoView.setSession(session)",
    "geckoView.releaseSession()",
    "override fun onStop()",
    "AndroidGeckoWorkerService.ensureRunning(",
    "relayUrlInput",
    "relayTokenInput",
    "Runtime relay token (not persisted)",
    "Browser: ",
    "ChatGPT: ",
    "Relay: ",
    "Worker ID: ",
    "statusSnapshot()",
    "startStatusUpdates()",
    "renderWorkerStatus()",
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
    'browser.runtime.connectNative(NATIVE_APP)',
    '"dispatch_prompt"',
    '"dispatch_result"',
    "sendButton.click()",
    "composer.replaceChildren(document.createTextNode(prompt))",
    "composerAvailable",
    "turnBusy",
):
    assert token in probe, token

for token in (
    'CONTROL_REPOSITORY = "jan2xo/bke-worker"',
    'repo != CONTROL_REPOSITORY',
    'keys != expectedKeys',
    'expectedWorkerId',
    'shaPattern',
    'deliveryPattern',
    'continuationPrompt',
    'appendLine("CONTINUE FROM PR")',
    "Recover the canonical execution contract from current main",
):
    assert token in relay_protocol, token

for token in (
    "OkHttpClient.Builder()",
    ".pingInterval(25, TimeUnit.SECONDS)",
    'requestBuilder.header("Authorization", "Bearer ',
    "RelayProtocol.parseWake",
    "RelayProtocol.register",
    "RelayProtocol.ack",
    "scheduleReconnect",
):
    assert token in relay_client, token

assert 'implementation("com.squareup.okhttp3:okhttp:4.12.0")' in build

# Remote relay wake is metadata-only; it cannot carry arbitrary prompt/JS/shell commands.
for forbidden in (
    'json.optString("prompt")',
    'json.optString("javascript")',
    'json.optString("command")',
    "eval(",
    "document.body.innerText",
    ".textContent",
    "document.cookie",
    "localStorage",
    "sessionStorage",
):
    assert forbidden not in relay_protocol + probe, forbidden

# Runtime relay credential must not be written to logs or persistent preferences.
assert "SharedPreferences" not in activity + service
assert "bearerToken)" not in service
assert "Log." not in relay_client

print("BKE Worker Android Gecko relay-ready dispatch contract: PASS")
