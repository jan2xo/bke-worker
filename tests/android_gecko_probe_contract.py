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
styles = (base / "res/values/styles.xml").read_text(encoding="utf-8")
button_surface = (base / "res/drawable/bke_worker_button.xml").read_text(encoding="utf-8")
input_surface = (base / "res/drawable/bke_worker_input.xml").read_text(encoding="utf-8")

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
    "Runtime relay token",
    "BROWSER: ",
    "CHAT: ",
    "RELAY: ",
    "WORKER ID: ",
    "statusSnapshot()",
    "startStatusUpdates()",
    "renderWorkerStatus()",
    "BKE WORKER",
    "LIVE STATUS",
    "WORKER CONFIGURATION ▾",
    "WORKER CONFIGURATION ▴",
    "configCard.visibility = View.GONE",
    "configCard.visibility == View.VISIBLE",
    'text = "Start / Apply"',
    'text = "Stop"',
    "setBackgroundColor(COLOR_BACKGROUND)",
    "compactCardContainer()",
    "cardEyebrow(",
    "WindowInsets.Type.statusBars()",
    "Color.rgb(17, 20, 23)",
    "Color.rgb(121, 216, 196)",
):
    assert token in activity, token

for forbidden in (
    "ChatGPT authentication is manual.",
    "EXECUTION TARGET",
    'text = "CHATGPT"',
    'text = "Android Worker"',
    'text = "Relay + ChatGPT runtime"',
    'text = "Worker Configuration"',
    'text = "WORKER CONFIGURATION"',
):
    assert forbidden not in activity, forbidden

for token in (
    'android:name=".AndroidGeckoWorkerService"',
    'android:exported="false"',
    'android:foregroundServiceType="specialUse"',
    'android:stopWithTask="false"',
    "android.permission.POST_NOTIFICATIONS",
    'android:label="BKE Worker"',
    'android:theme="@style/BkeWorkerTheme"',
):
    assert token in manifest, token

for token in (
    'name="BkeWorkerTheme"',
    "#111417",
    "#79D8C4",
    "#0B0D0F",
    'name="android:buttonStyle">@style/BkeWorkerButton',
    'name="android:editTextStyle">@style/BkeWorkerInput',
    'name="android:textAllCaps">false',
    'name="android:minHeight">38dp',
    'name="android:minHeight">42dp',
    'name="android:paddingLeft">12dp',
    'name="android:paddingTop">8dp',
):
    assert token in styles, token

for token in (
    '#20262B',
    '#38434C',
    'android:radius="10dp"',
):
    assert token in button_surface, token

for token in (
    '#171C20',
    '#79D8C4',
    'android:radius="12dp"',
):
    assert token in input_surface, token

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
    "async function waitForSendButtonReady(",
    "await waitForSendButtonReady()",
    '"SEND_UNAVAILABLE_AFTER_WRITE"',
    "void dispatchPrompt(message)",
):
    assert token in probe, token

write_index = probe.index("setComposerValue(composer, command.prompt)")
send_wait_index = probe.index("await waitForSendButtonReady()")
assert write_index < send_wait_index
assert "if (!composer || !sendButton || sendButton.disabled)" not in probe

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
