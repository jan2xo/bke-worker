#!/usr/bin/env python3
from pathlib import Path
import subprocess

root = Path(__file__).resolve().parents[1]
base = root / "android-gecko/app/src/main"
service = (base / "kotlin/com/bke/worker/gecko/AndroidGeckoWorkerService.kt").read_text(encoding="utf-8")
activity = (base / "kotlin/com/bke/worker/gecko/MainActivity.kt").read_text(encoding="utf-8")
runtime = (base / "kotlin/com/bke/worker/gecko/GeckoRuntimeProvider.kt").read_text(encoding="utf-8")
operator_script_path = root / "scripts/certify-android-chat-target-recovery.sh"
operator_script = operator_script_path.read_text(encoding="utf-8")
subprocess.run(["bash", "-n", str(operator_script_path)], check=True)
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
    "recoverySequence = recoverySequence",
    "lastRecoveryReason = lastRecoveryReason",
    "RelayConfigStore(applicationContext)",
    "restoreRelayState()",
    "relayConfigStore.saveConfig(config)",
    "relayConfigStore.saveRelayRequested(true)",
    "relayConfigStore.saveRelayRequested(false)",
    "relayRequested = relayConfigStore.loadRelayRequested()",
    'STATE_RECOVERING = "RECOVERING"',
    'CERTIFICATION_PACKAGE_SUFFIX = ".recoverycert"',
    'ACTION_CERT_CRASH_CONTENT = "bke.worker.cert.crash_content"',
    'ACTION_CERT_SIMULATE_CONTENT_KILL = "bke.worker.cert.simulate_content_kill"',
    'ACTION_CERT_NO_COMPOSER = "bke.worker.cert.no_composer"',
    'ACTION_CERT_NATIVE_PORT_LOSS = "bke.worker.cert.native_port_loss"',
    'ACTION_CERT_EXHAUST_RECOVERY = "bke.worker.cert.exhaust_recovery"',
    '"bke.worker.cert.resolve_uncertain_reject"',
    "ApplicationInfo.FLAG_DEBUGGABLE",
    "packageName.endsWith(CERTIFICATION_PACKAGE_SUFFIX)",
    'workerSession.loadUri("about:crashcontent")',
    "contentDelegate.onKill(workerSession)",
    '"recovery-cert-" + System.currentTimeMillis()',
    "scheduleNativePortRecovery()",
    'scheduleChatRecovery("CERTIFICATION_EXHAUSTED")',
    'sendAck(active.deliveryId, "rejected")',
    'scheduleChatRecovery("CERTIFICATION_UNCERTAIN_RESOLVED")',
    'STATE_BLOCKED_UNCERTAIN = "BLOCKED_UNCERTAIN_TURN"',
    "CHAT_RECOVERY_MAX_ATTEMPTS = 3",
    "CHAT_READY_TIMEOUT_MS = 15_000L",
    "NATIVE_PORT_RECOVERY_TIMEOUT_MS = 10_000L",
    "nativePortRecoveryGeneration = 0",
    "val generation = ++nativePortRecoveryGeneration",
    "generation != nativePortRecoveryGeneration",
    "nativePortRecoveryGeneration += 1",
    "certificationNativePortLossArmed = false",
    "certificationNativePortLossArmed = true",
    "certificationNativePortLossArmed && certificationHooksAllowed()",
    "suppressing native-port reconnect until bounded recovery starts",
    'scheduleChatRecovery("SESSION_CRASHED")',
    'scheduleChatRecovery("SESSION_KILLED")',
    'scheduleChatRecovery("NATIVE_PORT_DISCONNECTED")',
    'scheduleChatReadyTimeout("NO_COMPOSER")',
    "if (!workerSession.isOpen)",
    "workerSession.open(runtime)",
    "workerSession.loadUri(CHATGPT_URL)",
    "activeWakeUncertain = true",
    "workerState = if (activeWakeUncertain)",
    "STATE_BLOCKED_UNCERTAIN",
    'if (workerState == STATE_FAILED) {',
    "Ignoring worker status after terminal ChatGPT recovery failure",
    "workerState != STATE_RECOVERING && workerState != STATE_BLOCKED_UNCERTAIN",
    "recoverySequence += 1",
    "lastRecoveryReason = reason",
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
    "LAST RECOVERY: ",
    "RECOVERY SEQ: ",
    "renderedRecoverySequence",
    "reattachGeckoSurfaceAfterRecovery(snapshot.recoverySequence)",
    "private fun reattachGeckoSurfaceAfterRecovery(recoverySequence: Int)",
    "geckoView.releaseSession()",
    "geckoView.setSession(session)",
    "renderedRecoverySequence = recoverySequence",
    "root.requestLayout()",
    "geckoView.requestLayout()",
    "geckoView.postInvalidateOnAnimation()",
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
    'android:label="${appLabel}"',
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

for token in (
    'manifestPlaceholders["appLabel"] = "BKE Worker"',
    'create("recovery")',
    'applicationIdSuffix = ".recoverycert"',
    'versionNameSuffix = "-recoverycert"',
    'manifestPlaceholders["appLabel"] = "BKE Worker Recovery Cert"',
    "isDebuggable = true",
    'signingConfig = signingConfigs.getByName("preproduction")',
):
    assert token in build, token

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


# Chat/browser recovery is bounded and must fail closed on an uncertain in-flight turn.
assert "while (true)" not in service
native_recovery_start = service.index("    private fun scheduleNativePortRecovery()")
native_recovery_end = service.index("    private fun connectRelay()", native_recovery_start)
native_recovery_block = service[native_recovery_start:native_recovery_end]
assert "readinessWatchGeneration" not in native_recovery_block
assert "nativePortRecoveryGeneration" in native_recovery_block
failed_guard_index = service.index("if (workerState == STATE_FAILED) {", service.index("private fun handleWorkerStatus"))
observed_state_index = service.index("val observedState = when", failed_guard_index)
assert failed_guard_index < observed_state_index
surface_recovery_start = activity.index("    private fun reattachGeckoSurfaceAfterRecovery")
surface_recovery_end = activity.index("    private fun compactCardContainer", surface_recovery_start)
surface_recovery_block = activity[surface_recovery_start:surface_recovery_end]
assert "geckoView.releaseSession()" in surface_recovery_block
assert "geckoView.setSession(session)" in surface_recovery_block
assert surface_recovery_block.index("geckoView.releaseSession()") < surface_recovery_block.index("geckoView.setSession(session)")
assert "CHAT_RECOVERY_MAX_ATTEMPTS = 3" in service
assert "chatRecoveryAttempt >= CHAT_RECOVERY_MAX_ATTEMPTS" in service
assert "previousState != STATE_NO_COMPOSER" in service
assert "activeWake != null" in service
assert "activeWakeUncertain = true" in service
assert "active != null && !activeWakeUncertain" in service
assert "workerState = if (activeWakeUncertain)" in service
assert "STATE_BLOCKED_UNCERTAIN" in service
assert "if (!isRunning || workerState == STATE_FAILED) return" in service
assert "workerState == STATE_FAILED" in native_recovery_block
assert "workerState == STATE_FAILED" in service[service.index("private fun scheduleChatReadyTimeout"):service.index("private fun markChatSurfaceResponsive")]
assert "if (!activeWakeUncertain &&" in service
assert "mainHandler.removeCallbacksAndMessages(null)" in service

print("BKE Worker Android Gecko relay-ready dispatch contract: PASS")


# Local recovery certification hooks are fixed-function, debug-sidecar-only,
# and do not create a generic remote command surface.
for forbidden in (
    'ACTION_CERT_EVAL',
    'ACTION_CERT_JAVASCRIPT',
    'ACTION_CERT_SHELL',
    'ACTION_CERT_PROMPT',
):
    assert forbidden not in service, forbidden

for token in (
    'REPOSITORY="jan2xo/bke-worker"',
    'PARENT_PR=52',
    'SIDECAR_PACKAGE="com.bke.worker.gecko.recoverycert"',
    'PRIMARY_PACKAGE="com.bke.worker.gecko"',
    'ANDROID_USER_ID="$("${ADB[@]}" shell am get-current-user',
    '--user "$ANDROID_USER_ID"',
    'WORKER_ID=""',
    'WORKER_LABEL=""',
    'CERT_WORKER_PREFIX="rc-"',
    'initialize_cert_worker_identity "$parent_head"',
    'explicitly resolve and release the existing owner before rerunning',
    'verify_recovery_run "$run_id" "$parent_head"',
    'verify_recovery_artifact_manifest',
    'workflow_run_id',
    'package_name',
    'wait_for_recovery_witness',
    'SESSION_CRASHED',
    'SESSION_KILLED',
    'CHAT_READY_TIMEOUT:NO_COMPOSER',
    'terminal FAILED continued scheduling recovery after exhaustion',
    'OPERATOR_TEMP_DIRS=()',
    'CERT_FINAL_RESULT=""',
    'cleanup_operator_temp_dirs',
    'for path in "${OPERATOR_TEMP_DIRS[@]-}"; do',
    'if [[ "${BASH_SOURCE[0]}" == "$0" ]]; then',
    'cert_exit_guard',
    'local sidecar_head="$3"',
    'Sidecar certification run:',
    'script exited without final certification result',
    'cert_stage "artifact-download" "[5/10] Downloading and verifying stable-signed recovery APK..."',
    'bke-worker-android-recovery-sidecar',
    'RECOVERY SIDECAR SIGNED',
    'BKE_ANDROID_RECOVERY_TRUSTED_WORKTREE=1',
    'worktree add --quiet --detach',
    'gh run download "$run_id"',
    'install -r',
    '[[ "$SIDECAR_PACKAGE" == "com.bke.worker.gecko.recoverycert" ]]',
    'INSTALL_FAILED_UPDATE_INCOMPATIBLE',
    'one-time migration from ephemeral recovery signature to stable PREPRODUCTION signing authority',
    'uninstall "$SIDECAR_PACKAGE"',
    'pm path "$PRIMARY_PACKAGE"',
    'pm path "$SIDECAR_PACKAGE"',
    'Human boundary: authenticate ChatGPT manually',
    'bke.worker.cert.crash_content',
    'bke.worker.cert.simulate_content_kill',
    'bke.worker.cert.no_composer',
    'bke.worker.cert.native_port_loss',
    'wait_for_recovery_witness "$before_sequence" "NATIVE_PORT_DISCONNECTED"',
    'bke.worker.cert.exhaust_recovery',
    'bke.worker.cert.resolve_uncertain_reject',
    'CHAT: BLOCKED_UNCERTAIN_TURN',
    'gh pr edit "$PARENT_PR"',
    'fail "unable to create certification worker label"',
    'fail "unable to assign certification worker label"',
    'clear_stale_certification_assignments',
    '--add-label "$WORKER_LABEL"',
    '--remove-label "$WORKER_LABEL"',
    'BKE_WORKER_RELAY_TOKEN_KEY',
    'derive-worker-token.mjs',
    'Production: LOCKED',
):
    assert token in operator_script, token

relay_apply_start = operator_script.index("apply_relay_config_securely()")
relay_apply_end = operator_script.index("try_real_tab_kill()", relay_apply_start)
relay_apply_block = operator_script[relay_apply_start:relay_apply_end]

for token in (
    'local token_file="files/bke-recovery-relay-token"',
    'shell run-as "$SIDECAR_PACKAGE" mkdir -p files',
    'shell run-as "$SIDECAR_PACKAGE" touch "$token_file"',
    'shell run-as "$SIDECAR_PACKAGE" chmod 600 "$token_file"',
    'printf \'%s\' "$token" | "${ADB[@]}" shell run-as "$SIDECAR_PACKAGE" tee "$token_file"',
    'shell run-as "$SIDECAR_PACKAGE" sh -s',
    "trap 'rm -f \"$token_file\"' 0 1 2 3 15",
    '--es bke.worker.relay_token "$token"',
):
    assert token in relay_apply_block, token

assert 'shell run-as "$SIDECAR_PACKAGE" sh -c' not in relay_apply_block
assert relay_apply_block.index('chmod 600 "$token_file"') < relay_apply_block.index('tee "$token_file"')

assert '[[ "$relay_url" =~' not in relay_apply_block
for token in (
    'relay_rest="${relay_url#wss://}"',
    'relay_host="${relay_rest%%/*}"',
    '[[ "$relay_host" == *.workers.dev ]]',
    '[[ "$relay_rest" == "$relay_host/relay/$WORKER_ID" ]]',
):
    assert token in relay_apply_block, token

for token in (
    'broker_url="${broker_url%/}"',
    'relay_origin="${broker_url%/github/app/install-token}"',
    'relay_origin="${relay_origin%/}"',
    '[[ "$relay_origin" == https://*.workers.dev ]]',
    'relay_url="wss://${relay_origin#https://}/relay/$WORKER_ID"',
):
    assert token in operator_script, token

assert 'relay_url="${relay_origin/https:\\/\\//wss:\\/\\/}/relay/$WORKER_ID"' not in operator_script

identity_start = operator_script.index("initialize_cert_worker_identity()")
identity_end = operator_script.index("require_no_worker_assignment()", identity_start)
identity_block = operator_script[identity_start:identity_end]
for token in (
    'WORKER_ID="${CERT_WORKER_PREFIX}${short_head}-${epoch}-$$"',
    'WORKER_LABEL="bke-worker:${WORKER_ID}"',
    '[[ "${#WORKER_ID}" -le 63 ]]',
    '[[ "${#WORKER_LABEL}" -le 50 ]]',
):
    assert token in identity_block, token

assert "clear_stale_certification_assignments" not in operator_script
assert 'WORKER_ID="android-worker-recovery-cert"' not in operator_script

subprocess.run(
    [
        "bash",
        "-c",
        r"""
set -euo pipefail
source "$1"
cleanup_operator_temp_dirs
initialize_cert_worker_identity "0123456789abcdef0123456789abcdef01234567"
[[ "$WORKER_ID" =~ ^rc-01234567-[0-9]+-[0-9]+$ ]]
[[ "$WORKER_ID" != *'$'* ]]
[[ "$WORKER_LABEL" == "bke-worker:$WORKER_ID" ]]
[[ "${#WORKER_LABEL}" -le 50 ]]
""",
        "bke-android-recovery-contract",
        str(operator_script_path),
    ],
    check=True,
)


ownership_start = operator_script.index("require_no_worker_assignment()")
ownership_end = operator_script.index("ensure_worker_label_exists()", ownership_start)
ownership_block = operator_script[ownership_start:ownership_end]
assert '--search "label:$WORKER_LABEL"' not in ownership_block
for token in (
    'gh pr list --repo "$REPOSITORY" --state open --limit 200 --json number,labels',
    'WORKER_LABEL="$WORKER_LABEL" python3 -c',
    'if worker_label in labels:',
):
    assert token in ownership_block, token


for forbidden in (
    'uninstall "$PRIMARY_PACKAGE"',
    'pm uninstall "$PRIMARY_PACKAGE"',
    'set -x',
    'eval ',
    'production deploy',
):
    assert forbidden not in operator_script, forbidden
