#!/usr/bin/env python3
from pathlib import Path

root = Path(__file__).resolve().parents[1]
base = root / "android-gecko/app/src/main"
service = (base / "kotlin/com/bke/worker/gecko/AndroidGeckoWorkerService.kt").read_text(encoding="utf-8")
activity = (base / "kotlin/com/bke/worker/gecko/MainActivity.kt").read_text(encoding="utf-8")
runtime = (base / "kotlin/com/bke/worker/gecko/GeckoRuntimeProvider.kt").read_text(encoding="utf-8")
relay_protocol = (base / "kotlin/com/bke/worker/gecko/RelayProtocol.kt").read_text(encoding="utf-8")
relay_client = (base / "kotlin/com/bke/worker/gecko/RelayWebSocketClient.kt").read_text(encoding="utf-8")
relay_store = (base / "kotlin/com/bke/worker/gecko/RelayConfigStore.kt").read_text(encoding="utf-8")
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
    "ACTION_ENSURE_BROWSER",
    "ACTION_APPLY_RELAY_CONFIG",
    "ACTION_START_RELAY",
    "ACTION_STOP_RELAY",
    "fun ensureBrowserRunning(",
    "fun applyRelayConfig(",
    "fun startRelay(",
    "fun stopRelay(",
    "relayRequested = false",
    "private var appliedRelayConfig = RelayConfig(",
    "data class AndroidWorkerStatusSnapshot(",
    "fun statusSnapshot(): AndroidWorkerStatusSnapshot",
    "chatGptState = workerState",
    "relayState = relayState",
    "RelayConfigStore(applicationContext)",
    "restoreRelayState()",
    "relayConfigStore.saveConfig(config)",
    "relayConfigStore.saveRelayRequested(true)",
    "relayConfigStore.saveRelayRequested(false)",
    "relayRequested = relayConfigStore.loadRelayRequested()",
):
    assert token in service, token

assert "PowerManager" not in service
assert "WakeLock" not in service
assert "GeckoRuntime.create(context.applicationContext)" in runtime

for token in (
    "geckoView.setSession(session)",
    "geckoView.releaseSession()",
    "override fun onStop()",
    "AndroidGeckoWorkerService.ensureBrowserRunning(this)",
    "AndroidGeckoWorkerService.startRelay(",
    "AndroidGeckoWorkerService.stopRelay(",
    "AndroidGeckoWorkerService.applyRelayConfig(",
    "hydrateAppliedConfig()",
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
    'text = "Start"',
    'text = "Stop"',
    'text = "Apply"',
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
    '"jan2xo/bke-demo-app"',
    'repo !in CONTROL_REPOSITORIES',
    'keys != expectedKeys',
    'expectedWorkerId',
    'shaPattern',
    'deliveryPattern',
    'continuationPrompt',
    'appendLine("CONTINUE FROM PR")',
    "Recover the canonical execution contract from current main",
    "identifiableRejectedDeliveryId",
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
    "reconnectScheduled",
    "reconnectRunnable",
    "webSocket !== socket",
    'sendAck(rejectedDeliveryId, "rejected")',
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

# Relay protocol recovery must use server-valid ACK states only.
assert '"duplicate"' not in service
assert '"bridge_failed"' not in service

# Browser lifetime is independent from relay START / STOP.
assert "AndroidGeckoWorkerService.stop(this@MainActivity)" not in activity
assert 'text = "Start / Apply"' not in activity

# Relay pairing is device-persistent but the bearer token is encrypted with a
# device-bound Android Keystore AES-GCM key. Activity/service code must not write
# raw credentials directly to preferences or logs.
assert "SharedPreferences" not in activity + service
assert "bearerToken)" not in service
assert "Log." not in relay_client

for token in (
    "class RelayConfigStore(context: Context)",
    'PREFS = "bke.worker.relay.config.v1"',
    'KEY_ALIAS = "bke.worker.relay.token.v1"',
    'KEYSTORE = "AndroidKeyStore"',
    'TRANSFORMATION = "AES/GCM/NoPadding"',
    "Context.MODE_PRIVATE",
    "KeyGenParameterSpec.Builder(",
    "KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT",
    "KeyProperties.BLOCK_MODE_GCM",
    "KeyProperties.ENCRYPTION_PADDING_NONE",
    "Cipher.ENCRYPT_MODE",
    "Cipher.DECRYPT_MODE",
    "GCMParameterSpec(GCM_TAG_BITS, iv)",
    "KEY_TOKEN_CIPHERTEXT",
    "KEY_TOKEN_IV",
    "KEY_RELAY_REQUESTED",
    "fun saveRelayRequested(requested: Boolean)",
    "fun loadRelayRequested(): Boolean",
    ".commit()",
    'IllegalStateException("RELAY_CONFIG_STORE_FAILED")',
    'IllegalStateException("RELAY_REQUESTED_STORE_FAILED")',
): 
    assert token in relay_store, token

assert ".setUserAuthenticationRequired(" not in relay_store
assert "Log." not in relay_store
assert ".putString(KEY_TOKEN_CIPHERTEXT, config.bearerToken)" not in relay_store
assert ".putString(KEY_TOKEN_IV, config.bearerToken)" not in relay_store
assert "bearerToken = plaintext.toString(Charsets.UTF_8)" in relay_store

print("BKE Worker Android Gecko relay-ready dispatch contract: PASS")
