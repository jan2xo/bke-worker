#!/usr/bin/env bash
set -euo pipefail

REPOSITORY="jan2xo/bke-worker"
PARENT_PR=52
SIDECAR_PACKAGE="com.bke.worker.gecko.recoverycert"
PRIMARY_PACKAGE="com.bke.worker.gecko"
SERVICE_CLASS="com.bke.worker.gecko.AndroidGeckoWorkerService"
WORKER_ID=""
WORKER_LABEL=""
CERT_WORKER_PREFIX="rc-"
BROKER_VARIABLE="BKE_WORKER_GITHUB_APP_BROKER_URL"
SECRET_FILE="${BKE_WORKER_RELAY_SECRET_FILE:-$HOME/.bke-secrets/bke-worker-cloudflare-preproduction.env}"
TRUSTED_WORKTREE="${BKE_ANDROID_RECOVERY_TRUSTED_WORKTREE:-0}"
LOCAL_BUILD_ROOT="${BKE_ANDROID_RECOVERY_LOCAL_OUTPUT_ROOT:-}"
LOCAL_SIGNING_DIR="${BKE_ANDROID_RECOVERY_LOCAL_SIGNING_DIR:-$HOME/.bke-secrets/bke-worker-android-recovery-local}"
LOCAL_CERT_FILE="$LOCAL_SIGNING_DIR/cert.sha256"
OPERATOR_TEMP_DIRS=()
ADB_ROOTED_BY_CERT=0
REAL_KILL_RESULT="NOT RUN"
CERT_STAGE="bootstrap"
CERT_FINAL_RESULT=""

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
ROOT_DIR="$(git -C "$SCRIPT_DIR/.." rev-parse --show-toplevel 2>/dev/null || true)"

fail() {
  CERT_FINAL_RESULT="FAIL"
  echo "BKE ANDROID RECOVERY CERTIFICATION: FAIL-CLOSED — $*" >&2
  exit 1
}

require_command() {
  command -v "$1" >/dev/null 2>&1 || fail "required command missing: $1"
}

restore_adb_privilege() {
  if [[ "${ADB_ROOTED_BY_CERT:-0}" == "1" ]] && declare -p ADB >/dev/null 2>&1; then
    "${ADB[@]}" unroot >/dev/null 2>&1 || true
    "${ADB[@]}" wait-for-device >/dev/null 2>&1 || true
    ADB_ROOTED_BY_CERT=0
  fi
}

cleanup_operator_temp_dirs() {
  local path
  for path in "${OPERATOR_TEMP_DIRS[@]-}"; do
    [[ -n "$path" ]] && rm -rf -- "$path"
  done
  OPERATOR_TEMP_DIRS=()
}

cert_stage() {
  CERT_STAGE="$1"
  echo "BKE CERT: $2"
}

cert_exit_guard() {
  local rc="$1"
  trap - EXIT
  restore_adb_privilege
  cleanup_operator_temp_dirs

  case "$CERT_FINAL_RESULT" in
    PASS|BLOCKED|FAIL)
      exit "$rc"
      ;;
  esac

  if [[ "$rc" -eq 0 ]]; then
    echo "BKE ANDROID RECOVERY CERTIFICATION: FAIL-CLOSED — script exited without final certification result at stage: $CERT_STAGE" >&2
    exit 3
  fi

  echo "BKE ANDROID RECOVERY CERTIFICATION: FAIL-CLOSED — stage failed: $CERT_STAGE (exit $rc)" >&2
  exit "$rc"
}

sha256_file() {
  if command -v shasum >/dev/null 2>&1; then
    shasum -a 256 "$1" | awk '{print $1}'
  elif command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$1" | awk '{print $1}'
  else
    fail "shasum or sha256sum is required"
  fi
}

resolve_android_tool() {
  local tool="$1"
  if command -v "$tool" >/dev/null 2>&1; then
    command -v "$tool"
    return
  fi

  local sdk_root candidate
  for sdk_root in "${ANDROID_SDK_ROOT:-}" "${ANDROID_HOME:-}" "$HOME/Library/Android/sdk"; do
    [[ -n "$sdk_root" && -d "$sdk_root" ]] || continue
    if [[ "$tool" == "apksigner" ]]; then
      candidate="$(find "$sdk_root/build-tools" -type f -name apksigner 2>/dev/null | sort | tail -n 1)"
    else
      candidate="$(find "$sdk_root/cmdline-tools" -type f -path '*/bin/apkanalyzer' 2>/dev/null | sort | tail -n 1)"
    fi
    if [[ -n "$candidate" ]]; then
      printf '%s\n' "$candidate"
      return
    fi
  done

  fail "Android SDK tool not found: $tool"
}

ensure_github_auth() {
  if gh auth status --hostname github.com >/dev/null 2>&1; then
    return
  fi
  echo "GitHub authentication is required. Opening the official browser login flow..."
  gh auth login --hostname github.com --web
  gh auth status --hostname github.com >/dev/null 2>&1 || fail "GitHub authentication is still unavailable"
}

require_relay_secret_file() {
  if [[ -f "$SECRET_FILE" ]]; then
    return
  fi

  if [[ -n "${BKE_WORKER_RELAY_SECRET_FILE:-}" ]]; then
    fail "BKE_WORKER_RELAY_SECRET_FILE points to a missing file; set it to the authorized PREPRODUCTION relay env file or unset it to use the default"
  fi

  fail "default PREPRODUCTION relay secret file is missing at $SECRET_FILE"
}

ensure_trusted_worktree() {
  [[ -n "$ROOT_DIR" ]] || fail "run this script from a BKE Worker checkout"
  local top
  top="$(cd "$ROOT_DIR" && pwd -P)"
  local origin
  origin="$(git -C "$top" remote get-url origin 2>/dev/null || true)"
  [[ "$origin" == *"jan2xo/bke-worker"* ]] || fail "origin is not jan2xo/bke-worker"

  local remote_head
  remote_head="$(gh pr view "$PARENT_PR" --repo "$REPOSITORY" --json headRefOid --jq .headRefOid)"
  [[ "$remote_head" =~ ^[0-9a-f]{40}$ ]] || fail "unable to resolve PR #$PARENT_PR head"

  if [[ "$TRUSTED_WORKTREE" == "1" ]]; then
    [[ "$(git -C "$top" rev-parse HEAD)" == "$remote_head" ]] || fail "trusted worktree is not exact PR #$PARENT_PR head"
    [[ -z "$(git -C "$top" status --porcelain --untracked-files=no)" ]] || fail "trusted worktree has tracked changes"
    return
  fi

  git -C "$top" fetch --quiet origin "pull/$PARENT_PR/head"

  if [[ "$(git -C "$top" rev-parse HEAD)" == "$remote_head" && -z "$(git -C "$top" status --porcelain --untracked-files=no)" ]]; then
    return
  fi

  local worktree_dir
  worktree_dir="$(mktemp -d "${TMPDIR:-/tmp}/bke-android-recovery-worktree.XXXXXX")"
  git -C "$top" worktree add --quiet --detach "$worktree_dir" "$remote_head"
  echo "Using isolated exact-head worktree. Your current branch and local changes will not be modified."
  set +e
  BKE_ANDROID_RECOVERY_TRUSTED_WORKTREE=1 bash "$worktree_dir/scripts/certify-android-chat-target-recovery.sh"
  local status=$?
  set -e
  git -C "$top" worktree remove --force "$worktree_dir" >/dev/null 2>&1 || true
  rm -rf "$worktree_dir"
  exit "$status"
}

select_device() {
  local requested="${BKE_ANDROID_SERIAL:-}"
  local devices
  devices="$(adb devices | awk 'NR>1 && $2=="device" {print $1}')"
  if [[ -n "$requested" ]]; then
    grep -Fxq "$requested" <<<"$devices" || fail "BKE_ANDROID_SERIAL is not an authorized connected device: $requested"
    DEVICE_SERIAL="$requested"
  else
    local count
    count="$(grep -c . <<<"$devices" || true)"
    [[ "$count" -gt 0 ]] || fail "no authorized Android device is connected through adb"
    if [[ "$count" -eq 1 ]]; then
      DEVICE_SERIAL="$devices"
    else
      echo "Connected Android devices:"
      printf '%s\n' "$devices"
      read -r -p "Android serial to certify: " DEVICE_SERIAL
      grep -Fxq "$DEVICE_SERIAL" <<<"$devices" || fail "selected Android serial is not connected"
    fi
  fi
  ADB=(adb -s "$DEVICE_SERIAL")

  ANDROID_USER_ID="$("${ADB[@]}" shell am get-current-user 2>/dev/null | tr -d '\r')"
  [[ "$ANDROID_USER_ID" =~ ^[0-9]+$ ]] || fail "unable to resolve current Android user id"
}

ui_text() {
  local xml_file="$1"
  "${ADB[@]}" shell uiautomator dump /sdcard/bke-recovery-window.xml >/dev/null 2>&1 || return 1
  "${ADB[@]}" exec-out cat /sdcard/bke-recovery-window.xml >"$xml_file" 2>/dev/null || return 1
  python3 - "$xml_file" <<'PY'
import html
import re
import sys
from pathlib import Path
text = Path(sys.argv[1]).read_text(encoding="utf-8", errors="replace")
for raw in re.findall(r'text="([^"]*)"', text):
    value = html.unescape(raw)
    if value:
        print(value)
PY
}

wait_for_text() {
  local needle="$1"
  local timeout_seconds="$2"
  local xml_file="$3"
  local started
  started="$(date +%s)"
  while (( $(date +%s) - started < timeout_seconds )); do
    if ui_text "$xml_file" | grep -Fq "$needle"; then
      return 0
    fi
    sleep 1
  done
  return 1
}

launch_sidecar() {
  "${ADB[@]}" shell am start -W --user "$ANDROID_USER_ID" -n "$SIDECAR_PACKAGE/com.bke.worker.gecko.MainActivity" >/dev/null
}

run_sidecar_service_action() {
  local action="$1"
  "${ADB[@]}" shell run-as "$SIDECAR_PACKAGE" \
    am start-foreground-service \
      --user "$ANDROID_USER_ID" \
      -n "$SIDECAR_PACKAGE/$SERVICE_CLASS" \
      -a "$action" >/dev/null
}

restart_and_require_ready() {
  local xml_file="$1"
  "${ADB[@]}" shell am force-stop --user "$ANDROID_USER_ID" "$SIDECAR_PACKAGE"
  launch_sidecar
  wait_for_text "BROWSER: ATTACHED" 30 "$xml_file" || fail "sidecar browser did not reattach after restart"
  if ! wait_for_text "CHAT: READY" 30 "$xml_file"; then
    echo
    echo "Human boundary: complete ChatGPT authentication/security checks inside BKE Worker Recovery Cert."
    echo "The script will not type credentials, approve OAuth, answer MFA, or solve CAPTCHA."
    read -r -p "Press Enter after the ChatGPT composer is visibly usable: " _

    # The service may have reached terminal FAILED while the human authentication
    # boundary was open. FAILED is intentionally sticky, so use the existing
    # explicit operator/process restart boundary after authentication. Gecko
    # profile state survives the force-stop and no authentication data is automated.
    "${ADB[@]}" shell am force-stop --user "$ANDROID_USER_ID" "$SIDECAR_PACKAGE"
    launch_sidecar
    wait_for_text "BROWSER: ATTACHED" 30 "$xml_file" ||
      fail "sidecar browser did not reattach after human authentication restart"
    wait_for_text "CHAT: READY" 60 "$xml_file" ||
      fail "ChatGPT did not reach READY after human authentication restart"
  fi
}

read_recovery_sequence() {
  local xml_file="$1"
  local snapshot seq
  snapshot="$(ui_text "$xml_file")" || return 1
  seq="$(awk -F': ' '/^RECOVERY SEQ: [0-9]+$/ {print $2; exit}' <<<"$snapshot")"
  [[ "$seq" =~ ^[0-9]+$ ]] || return 1
  printf '%s\n' "$seq"
}

wait_for_recovery_witness() {
  local before_sequence="$1"
  local expected_reasons="$2"
  local timeout_seconds="$3"
  local xml_file="$4"
  local started snapshot sequence reason chat browser
  started="$(date +%s)"
  sequence=""
  reason=""
  chat=""
  browser=""
  while (( $(date +%s) - started < timeout_seconds )); do
    snapshot="$(ui_text "$xml_file" 2>/dev/null || true)"
    sequence="$(awk -F': ' '/^RECOVERY SEQ: [0-9]+$/ {print $2; exit}' <<<"$snapshot")"
    reason="$(awk -F': ' '/^LAST RECOVERY: / {print $2; exit}' <<<"$snapshot")"
    chat="$(awk -F': ' '/^CHAT: / {print $2; exit}' <<<"$snapshot")"
    browser="$(awk -F': ' '/^BROWSER: / {print $2; exit}' <<<"$snapshot")"
    if [[ "$sequence" =~ ^[0-9]+$ ]] &&
       (( sequence > before_sequence )) &&
       [[ "|$expected_reasons|" == *"|$reason|"* ]] &&
       [[ "$browser" == "ATTACHED" ]] &&
       [[ "$chat" == "READY" ]]; then
      return 0
    fi
    sleep 1
  done
  echo "BKE CERT: recovery witness timeout — before_seq=$before_sequence observed_seq=${sequence:-?} observed_reason=${reason:-?} chat=${chat:-?} browser=${browser:-?} expected=$expected_reasons" >&2
  return 1
}

classify_failed_kill_witness() {
  local before_sequence="$1"
  local xml_file="$2"
  local snapshot sequence reason chat browser

  snapshot="$(ui_text "$xml_file" 2>/dev/null || true)"
  sequence="$(awk -F': ' '/^RECOVERY SEQ: [0-9]+$/ {print $2; exit}' <<<"$snapshot")"
  reason="$(awk -F': ' '/^LAST RECOVERY: / {print $2; exit}' <<<"$snapshot")"
  chat="$(awk -F': ' '/^CHAT: / {print $2; exit}' <<<"$snapshot")"
  browser="$(awk -F': ' '/^BROWSER: / {print $2; exit}' <<<"$snapshot")"

  if [[ "$sequence" =~ ^[0-9]+$ ]] && (( sequence > before_sequence )); then
    if [[ "$reason" == "SESSION_KILLED" ]]; then
      echo "BKE CERT: fresh SESSION_KILLED occurred but recovery did not return ATTACHED + READY — seq=$sequence chat=${chat:-?} browser=${browser:-?}." >&2
      return 2
    fi

    echo "BKE CERT: recovery sequence advanced for ${reason:-unknown} while testing a real kill; lab proof is contaminated and cannot be attributed." >&2
    return 1
  fi

  return 0
}

verify_recovery_run() {
  local run_id="$1"
  local parent_head="$2"
  local run_json
  run_json="$(gh run view "$run_id" --repo "$REPOSITORY" --json headSha,conclusion,event,jobs)"
  RUN_JSON="$run_json" python3 - "$parent_head" <<'PY'
import json
import os
import sys

expected_head = sys.argv[1]
run = json.loads(os.environ["RUN_JSON"])
if run.get("headSha") != expected_head:
    raise SystemExit("Recovery certification run head does not match exact parent head")
if run.get("conclusion") != "success":
    raise SystemExit("Recovery certification run is not successful")
if run.get("event") != "workflow_dispatch":
    raise SystemExit("Recovery certification run was not an explicit workflow_dispatch")

jobs = {job.get("name"): job.get("conclusion") for job in run.get("jobs", [])}
for name in ("Android recovery local contract", "Required certification"):
    if jobs.get(name) != "success":
        raise SystemExit(f"Required recovery certification job did not pass: {name}")
PY
}

verify_local_recovery_manifest() {
  local manifest_file="$1"
  local actual_apk_sha="$2"
  local parent_head="$3"
  python3 - "$manifest_file" "$actual_apk_sha" "$parent_head" <<'PY'
import json
import re
import sys
from pathlib import Path

manifest_path, actual_apk_sha, expected_head = sys.argv[1:]
manifest = json.loads(Path(manifest_path).read_text(encoding="utf-8"))

required = {
    "source_sha": expected_head,
    "build_origin": "local-exact-head",
    "component": "BKE Worker Android Recovery Cert",
    "package_name": "com.bke.worker.gecko.recoverycert",
    "architecture": "arm64-v8a",
    "sha256": actual_apk_sha,
    "signing_authority": "LOCAL_CERTIFICATION",
    "certification_state": "recovery-cert-local-build",
}
for key, expected in required.items():
    if manifest.get(key) != expected:
        raise SystemExit(f"Local recovery provenance mismatch for {key}")

if manifest.get("version_code") != 1:
    raise SystemExit("Local recovery version_code mismatch")
if not str(manifest.get("version_name", "")).endswith("-recoverycert"):
    raise SystemExit("Local recovery version_name mismatch")
signer = str(manifest.get("signer_certificate_sha256", "")).lower()
if not re.fullmatch(r"[0-9a-f]{64}", signer):
    raise SystemExit("Local recovery signer provenance is invalid")

print(manifest["source_sha"])
PY
}

verify_local_recovery_apk() {
  local apk="$1"
  local expected_signer
  local apksigner apkanalyzer signer_report signer_sha debuggable package_name version_name version_code

  apksigner="$(resolve_android_tool apksigner)"
  apkanalyzer="$(resolve_android_tool apkanalyzer)"
  signer_report="$(mktemp "${TMPDIR:-/tmp}/bke-recovery-signer.XXXXXX.txt")"
  OPERATOR_TEMP_DIRS+=("$signer_report")

  "$apksigner" verify --verbose --print-certs "$apk" >"$signer_report"
  signer_sha="$(
    sed -n 's/^Signer #1 certificate SHA-256 digest: //p' "$signer_report" |
      head -n 1 |
      tr '[:upper:]' '[:lower:]' |
      tr -d ':[:space:]'
  )"
  [[ -f "$LOCAL_CERT_FILE" ]] ||
    fail "local recovery signer trust file is missing; run scripts/build-android-recovery-local.sh first"
  expected_signer="$(
    tr '[:upper:]' '[:lower:]' < "$LOCAL_CERT_FILE" |
      tr -d ':[:space:]'
  )"
  [[ "$expected_signer" =~ ^[0-9a-f]{64}$ ]] || fail "local recovery signer trust fingerprint is invalid"
  [[ "$signer_sha" =~ ^[0-9a-f]{64}$ ]] || fail "unable to verify local recovery APK signer"
  [[ "$signer_sha" == "$expected_signer" ]] || fail "local recovery APK signer does not match the stable local certification signer"

  debuggable="$("$apkanalyzer" manifest debuggable "$apk" | tr '[:upper:]' '[:lower:]' | tr -d '[:space:]')"
  package_name="$("$apkanalyzer" manifest application-id "$apk" | tr -d '[:space:]')"
  version_name="$("$apkanalyzer" manifest version-name "$apk" | tr -d '[:space:]')"
  version_code="$("$apkanalyzer" manifest version-code "$apk" | tr -d '[:space:]')"

  [[ "$debuggable" == "true" ]] || fail "local recovery APK is not debuggable"
  [[ "$package_name" == "$SIDECAR_PACKAGE" ]] || fail "local recovery APK package mismatch: $package_name"
  [[ "$version_name" == *"-recoverycert" ]] || fail "local recovery APK version name mismatch: $version_name"
  [[ "$version_code" == "1" ]] || fail "local recovery APK version code mismatch: $version_code"
}
resolve_recovery_run() {
  local parent_head="$1"
  local head_ref="$2"
  local runs_json candidate_id
  runs_json="$(gh run list \
    --repo "$REPOSITORY" \
    --workflow certify.yml \
    --branch "$head_ref" \
    --event workflow_dispatch \
    --limit 50 \
    --json databaseId,headSha,conclusion,createdAt)"

  while IFS= read -r candidate_id; do
    [[ "$candidate_id" =~ ^[0-9]+$ ]] || continue
    if verify_recovery_run "$candidate_id" "$parent_head" >/dev/null 2>&1; then
      printf '%s\n' "$candidate_id"
      return 0
    fi
  done < <(
    RUNS_JSON="$runs_json" python3 - "$parent_head" <<'PY'
import json
import os
import sys

expected_head = sys.argv[1]
runs = json.loads(os.environ["RUNS_JSON"])
for run in runs:
    if run.get("headSha") == expected_head and run.get("conclusion") == "success":
        print(run["databaseId"])
PY
  )

  return 1
}

apply_relay_config_securely() {
  local relay_url="$1"
  local token="$2"
  local token_file="files/bke-recovery-relay-token"

  local relay_rest relay_host
  relay_rest="${relay_url#wss://}"
  [[ "$relay_rest" != "$relay_url" ]] || fail "refusing unsafe PREPRODUCTION relay URL"
  relay_host="${relay_rest%%/*}"
  [[ -n "$relay_host" ]] || fail "refusing unsafe PREPRODUCTION relay URL"
  case "$relay_host" in
    *[!A-Za-z0-9.-]*)
      fail "refusing unsafe PREPRODUCTION relay URL"
      ;;
  esac
  [[ "$relay_host" == *.workers.dev ]] || fail "refusing unsafe PREPRODUCTION relay URL"
  [[ "$relay_rest" == "$relay_host/relay/$WORKER_ID" ]] || fail "refusing unsafe PREPRODUCTION relay URL"

  # Keep every filesystem operation inside run-as. Avoid a compound adb shell
  # sh -c command: adb shell can consume the quoting boundary and execute
  # metacharacters/redirections as the shell user outside the app data directory.
  "${ADB[@]}" shell run-as "$SIDECAR_PACKAGE" mkdir -p files
  "${ADB[@]}" shell run-as "$SIDECAR_PACKAGE" touch "$token_file"
  "${ADB[@]}" shell run-as "$SIDECAR_PACKAGE" chmod 600 "$token_file"
  printf '%s' "$token" | "${ADB[@]}" shell run-as "$SIDECAR_PACKAGE" tee "$token_file" >/dev/null

  # Feed a fixed script over stdin to the app-UID shell. The bearer token is read
  # only from the app-private file and never appears in the host command line.
  "${ADB[@]}" shell run-as "$SIDECAR_PACKAGE" sh -s \
    "$ANDROID_USER_ID" "$SIDECAR_PACKAGE/$SERVICE_CLASS" "$WORKER_ID" "$relay_url" <<'REMOTE_SH'
set -eu
android_user_id="$1"
component="$2"
worker_id="$3"
relay_url="$4"
token_file="files/bke-recovery-relay-token"
trap 'rm -f "$token_file"' 0 1 2 3 15
token="$(cat "$token_file")"

am start-foreground-service \
  --user "$android_user_id" \
  -n "$component" \
  -a bke.worker.apply_relay_config \
  --es bke.worker.worker_id "$worker_id" \
  --es bke.worker.relay_url "$relay_url" \
  --es bke.worker.relay_token "$token" >/dev/null
REMOTE_SH
}

list_gecko_tab_pids() {
  "${ADB[@]}" shell ps -A -o PID,NAME 2>/dev/null |
    tr -d '\r' |
    awk -v pkg="$SIDECAR_PACKAGE" '$2 ~ ("^" pkg ":") && tolower($2) ~ /tab/ {print $1}' |
    sort -rn
}

read_sidecar_main_pid() {
  "${ADB[@]}" shell ps -A -o PID,NAME 2>/dev/null |
    tr -d '\r' |
    awk -v pkg="$SIDECAR_PACKAGE" '$2 == pkg {print $1; exit}'
}

try_activity_manager_tab_kill() {
  local xml_file="$1"
  local before_sequence="$2"
  local candidates="$3"
  local main_pid_before main_pid_after after_candidates pid lost_candidate kill_state

  main_pid_before="$(read_sidecar_main_pid)"
  [[ "$main_pid_before" =~ ^[0-9]+$ ]] || return 1

  echo "BKE CERT: app-UID SIGKILL did not prove the active tab; asking Android ActivityManager to kill safe package processes." >&2
  if ! "${ADB[@]}" shell am kill --user "$ANDROID_USER_ID" "$SIDECAR_PACKAGE" >/dev/null 2>&1; then
    return 1
  fi

  if ! wait_for_recovery_witness "$before_sequence" "SESSION_KILLED" 45 "$xml_file"; then
    kill_state=0
    classify_failed_kill_witness "$before_sequence" "$xml_file" || kill_state=$?
    [[ "$kill_state" -ne 2 ]] || return 2
    [[ "$kill_state" -eq 0 ]] || return 1

    main_pid_after="$(read_sidecar_main_pid)"
    after_candidates="$(list_gecko_tab_pids 2>/dev/null || true)"
    if [[ "$main_pid_after" != "$main_pid_before" ]]; then
      REAL_KILL_RESULT="INCONCLUSIVE — ActivityManager changed the sidecar process without an attributable active-session kill witness"
      echo "BKE CERT: ActivityManager changed the main sidecar process without a fresh SESSION_KILLED witness; lab proof is contaminated." >&2
      return 1
    fi

    while IFS= read -r pid; do
      [[ "$pid" =~ ^[0-9]+$ ]] || continue
      if ! grep -Fxq "$pid" <<<"$after_candidates"; then
        REAL_KILL_RESULT="INCONCLUSIVE — one or more Gecko tab candidates disappeared without a fresh active-session SESSION_KILLED witness"
        echo "BKE CERT: ActivityManager removed Gecko tab pid=$pid, but no fresh SESSION_KILLED witness identified it as the active session." >&2
        return 1
      fi
    done <<<"$candidates"
    return 1
  fi

  main_pid_after="$(read_sidecar_main_pid)"
  if [[ "$main_pid_after" != "$main_pid_before" ]]; then
    REAL_KILL_RESULT="INCONCLUSIVE — fresh SESSION_KILLED coincided with a whole-app process change"
    echo "BKE CERT: ActivityManager witness advanced but the main sidecar process changed; refusing causal attribution." >&2
    return 1
  fi

  after_candidates="$(list_gecko_tab_pids 2>/dev/null || true)"
  lost_candidate=0
  while IFS= read -r pid; do
    [[ "$pid" =~ ^[0-9]+$ ]] || continue
    if ! grep -Fxq "$pid" <<<"$after_candidates"; then
      lost_candidate=1
      break
    fi
  done <<<"$candidates"

  if [[ "$lost_candidate" -ne 1 ]]; then
    REAL_KILL_RESULT="INCONCLUSIVE — fresh SESSION_KILLED had no matching pre-existing Gecko tab disappearance"
    echo "BKE CERT: ActivityManager witness advanced but no pre-existing Gecko tab PID disappeared; refusing causal attribution." >&2
    return 1
  fi

  echo "BKE CERT: Android ActivityManager real package-process kill proved active-session recovery with main process preserved."
  return 0
}
try_root_emulator_tab_kill() {
  local xml_file="$1"
  local before_sequence="$2"
  local qemu build_type main_pid_before main_pid_after candidates pid after_candidates kill_state

  qemu="$("${ADB[@]}" shell getprop ro.kernel.qemu 2>/dev/null | tr -d '\r[:space:]')"
  [[ "$qemu" == "1" ]] || return 1
  build_type="$("${ADB[@]}" shell getprop ro.build.type 2>/dev/null | tr -d '\r[:space:]')"

  main_pid_before="$(read_sidecar_main_pid)"
  [[ "$main_pid_before" =~ ^[0-9]+$ ]] || return 1
  candidates="$(list_gecko_tab_pids)"
  [[ -n "$candidates" ]] || return 1

  echo "BKE CERT: non-root kill paths did not prove the active tab; attempting emulator-only adb-root kill (build_type=${build_type:-unknown})." >&2
  if ! "${ADB[@]}" root >/dev/null 2>&1; then
    return 1
  fi
  "${ADB[@]}" wait-for-device >/dev/null 2>&1 || return 1
  if [[ "$("${ADB[@]}" shell id -u 2>/dev/null | tr -d '\r[:space:]')" != "0" ]]; then
    return 1
  fi
  ADB_ROOTED_BY_CERT=1

  main_pid_after="$(read_sidecar_main_pid)"
  if [[ "$main_pid_after" != "$main_pid_before" ]]; then
    REAL_KILL_RESULT="INCONCLUSIVE — adb-root transition changed the sidecar process"
    echo "BKE CERT: adb-root transition changed the main sidecar process; refusing contaminated tab-kill proof." >&2
    restore_adb_privilege
    return 1
  fi

  candidates="$(list_gecko_tab_pids)"
  [[ -n "$candidates" ]] || {
    restore_adb_privilege
    return 1
  }

  while IFS= read -r pid; do
    [[ "$pid" =~ ^[0-9]+$ ]] || continue
    if ! "${ADB[@]}" shell kill -9 "$pid" >/dev/null 2>&1; then
      continue
    fi

    if wait_for_recovery_witness "$before_sequence" "SESSION_KILLED" 45 "$xml_file"; then
      main_pid_after="$(read_sidecar_main_pid)"
      after_candidates="$(list_gecko_tab_pids 2>/dev/null || true)"
      if [[ "$main_pid_after" == "$main_pid_before" ]] && ! grep -Fxq "$pid" <<<"$after_candidates"; then
        restore_adb_privilege
        echo "BKE CERT: emulator-root real Gecko tab-process kill proved active-session recovery (pid=$pid)."
        return 0
      fi

      REAL_KILL_RESULT="INCONCLUSIVE — fresh SESSION_KILLED could not be causally tied to the targeted Gecko tab"
      echo "BKE CERT: emulator-root witness advanced without preserved main PID + killed candidate; refusing causal attribution." >&2
      restore_adb_privilege
      return 1
    fi

    kill_state=0
    classify_failed_kill_witness "$before_sequence" "$xml_file" || kill_state=$?
    if [[ "$kill_state" -eq 2 ]]; then
      restore_adb_privilege
      return 2
    fi
    if [[ "$kill_state" -eq 1 ]]; then
      REAL_KILL_RESULT="INCONCLUSIVE — recovery state changed during real-kill injection without causal attribution"
      restore_adb_privilege
      return 1
    fi

    after_candidates="$(list_gecko_tab_pids 2>/dev/null || true)"
    if ! grep -Fxq "$pid" <<<"$after_candidates"; then
      REAL_KILL_RESULT="INCONCLUSIVE — one or more Gecko tab candidates disappeared without a fresh active-session SESSION_KILLED witness"
      echo "BKE CERT: emulator-root removed Gecko tab pid=$pid, but no fresh SESSION_KILLED witness identified it as the active session; continuing bounded candidate search." >&2
    fi
  done <<<"$candidates"

  restore_adb_privilege
  return 1
}
try_real_tab_kill() {
  local xml_file="$1"
  local before_sequence="$2"
  local candidates pid am_result main_pid_before main_pid_after after_candidates kill_state

  main_pid_before="$(read_sidecar_main_pid)"
  [[ "$main_pid_before" =~ ^[0-9]+$ ]] || return 1

  candidates="$(list_gecko_tab_pids)"
  [[ -n "$candidates" ]] || return 1

  while IFS= read -r pid; do
    [[ "$pid" =~ ^[0-9]+$ ]] || continue
    if ! "${ADB[@]}" shell run-as "$SIDECAR_PACKAGE" kill -9 "$pid" >/dev/null 2>&1; then
      continue
    fi

    if wait_for_recovery_witness "$before_sequence" "SESSION_KILLED" 45 "$xml_file"; then
      main_pid_after="$(read_sidecar_main_pid)"
      after_candidates="$(list_gecko_tab_pids 2>/dev/null || true)"
      if [[ "$main_pid_after" == "$main_pid_before" ]] && ! grep -Fxq "$pid" <<<"$after_candidates"; then
        echo "BKE CERT: real Gecko tab-process kill proved active-session recovery (pid=$pid)."
        return 0
      fi

      REAL_KILL_RESULT="INCONCLUSIVE — fresh SESSION_KILLED could not be causally tied to the targeted Gecko tab"
      echo "BKE CERT: fresh SESSION_KILLED followed the kill, but main-PID/target-PID checks could not establish causal attribution." >&2
      return 1
    fi

    kill_state=0
    classify_failed_kill_witness "$before_sequence" "$xml_file" || kill_state=$?
    [[ "$kill_state" -ne 2 ]] || return 2
    if [[ "$kill_state" -eq 1 ]]; then
      REAL_KILL_RESULT="INCONCLUSIVE — recovery state changed during real-kill injection without causal attribution"
      return 1
    fi

    after_candidates="$(list_gecko_tab_pids 2>/dev/null || true)"
    if ! grep -Fxq "$pid" <<<"$after_candidates"; then
      REAL_KILL_RESULT="INCONCLUSIVE — one or more Gecko tab candidates disappeared without a fresh active-session SESSION_KILLED witness"
      echo "BKE CERT: Gecko tab pid=$pid disappeared, but no fresh SESSION_KILLED witness identified it as the active session; continuing bounded candidate search." >&2
      continue
    fi

    echo "BKE CERT: tab-process candidate pid=$pid did not affect the active session; trying the next bounded candidate." >&2
  done <<<"$candidates"

  candidates="$(list_gecko_tab_pids)"
  [[ -n "$candidates" ]] || return 1

  if try_activity_manager_tab_kill "$xml_file" "$before_sequence" "$candidates"; then
    return 0
  else
    am_result=$?
  fi
  [[ "$am_result" -eq 1 ]] || return "$am_result"

  try_root_emulator_tab_kill "$xml_file" "$before_sequence"
}
certify_content_kill_recovery() {
  local xml_file="$1"
  local before_sequence kill_rc

  REAL_KILL_RESULT="NOT AVAILABLE — device could not inject a real Gecko tab-process kill; optional lab proof not observed"

  before_sequence="$(read_recovery_sequence "$xml_file")" || return 1
  if try_real_tab_kill "$xml_file" "$before_sequence"; then
    REAL_KILL_RESULT="PASS — real external Gecko tab-process kill produced a fresh causal SESSION_KILLED recovery witness"
  else
    kill_rc=$?
    if [[ "$kill_rc" -eq 2 ]]; then
      echo "BKE CERT: a fresh SESSION_KILLED was observed during real-kill injection, but bounded recovery did not return ATTACHED + READY." >&2
      return 1
    fi
    echo "BKE CERT: real Gecko kill injection unavailable on this device; continuing with required fixed onKill callback proof." >&2
  fi

  before_sequence="$(read_recovery_sequence "$xml_file")" || return 1
  run_sidecar_service_action bke.worker.cert.simulate_content_kill
  wait_for_recovery_witness "$before_sequence" "SESSION_KILLED" 60 "$xml_file" || {
    echo "BKE CERT: fixed onKill callback did not produce a fresh SESSION_KILLED READY witness." >&2
    return 1
  }

  return 0
}

initialize_cert_worker_identity() {
  local parent_head="$1"
  local short_head epoch
  short_head="${parent_head:0:8}"
  epoch="$(date +%s)"
  WORKER_ID="${CERT_WORKER_PREFIX}${short_head}-${epoch}-$$"
  WORKER_LABEL="bke-worker:${WORKER_ID}"

  [[ "${#WORKER_ID}" -le 63 ]] || fail "certification worker id is too long"
  [[ "${#WORKER_LABEL}" -le 50 ]] || fail "certification worker label is too long"
  case "$WORKER_ID" in
    ""|*[!a-z0-9-]*)
      fail "certification worker id is invalid"
      ;;
  esac
}

require_no_worker_assignment() {
  local worker_matches
  worker_matches="$(
    gh pr list --repo "$REPOSITORY" --state open --limit 200 --json number,labels |
      WORKER_LABEL="$WORKER_LABEL" python3 -c '
import json
import os
import sys

worker_label = os.environ["WORKER_LABEL"]
rows = json.load(sys.stdin)
matches = []
for row in rows:
    labels = [label.get("name") for label in row.get("labels", [])]
    if worker_label in labels:
        matches.append(str(row["number"]))
print("\n".join(matches))
'
  )"
  [[ -z "$worker_matches" ]] || fail "$WORKER_LABEL is already assigned to open PR(s): $worker_matches"

  local labels
  labels="$(gh pr view "$PARENT_PR" --repo "$REPOSITORY" --json labels --jq '.labels[].name | select(startswith("bke-worker:"))')"
  [[ -z "$labels" ]] || fail "PR #$PARENT_PR already has a worker assignment; explicitly resolve and release the existing owner before rerunning: $labels"
}

ensure_worker_label_exists() {
  if gh label list --repo "$REPOSITORY" --limit 200 --json name --jq '.[].name' | grep -Fxq "$WORKER_LABEL"; then
    return
  fi
  gh label create "$WORKER_LABEL" --repo "$REPOSITORY" --color "1D76DB" --description "BKE recovery certification worker" >/dev/null || fail "unable to create certification worker label"
}

comment_parent() {
  local title="$1"
  local parent_head="$2"
  local sidecar_head="$3"
  local run_id="$4"
  local apk_sha="$5"
  local actual_kill="$6"
  local uncertain="$7"
  local device_model android_release
  device_model="$("${ADB[@]}" shell getprop ro.product.model | tr -d '\r')"
  android_release="$("${ADB[@]}" shell getprop ro.build.version.release | tr -d '\r')"
  gh pr comment "$PARENT_PR" --repo "$REPOSITORY" --body "$(cat <<EOF_COMMENT
$title

Parent exact head: \`$parent_head\`
Sidecar exact head: \`$sidecar_head\`
Sidecar certification run: \`$run_id\`
Sidecar APK SHA-256: \`$apk_sha\`
Device: \`$device_model\` / Android \`$android_release\`

Observed locally:
- side-by-side package coexistence: PASS
- human-authenticated ChatGPT READY baseline: PASS
- app close/reopen recovery: PASS
- controlled Gecko content crash recovery: PASS
- real external Gecko tab-process kill integration (optional lab proof): $actual_kill
- Gecko onKill callback recovery with fresh SESSION_KILLED witness (required): PASS
- NO_COMPOSER bounded recovery: PASS
- native-port loss bounded recovery: PASS
- exhausted recovery -> FAILED: PASS
- in-flight crash -> BLOCKED_UNCERTAIN_TURN: $uncertain
- explicit uncertain-turn reject/recovery: $uncertain
- temporary recovery worker assignment released: $uncertain

No credentials, cookies, relay master key, worker bearer token, OAuth/MFA/CAPTCHA data, or browser-profile contents are recorded here.
Production remains LOCKED.
EOF_COMMENT
)"
}

main() {
  cert_stage "preflight" "[1/10] Checking required tools and GitHub authentication..."
  for command_name in git gh adb python3 node awk; do
    require_command "$command_name"
  done
  ensure_github_auth
  require_relay_secret_file
  cert_stage "exact-head" "[2/10] Verifying exact PR #52 worktree..."
  ensure_trusted_worktree

  trap 'cert_exit_guard "$?"' EXIT

  local parent_head head_ref current_head
  parent_head="$(gh pr view "$PARENT_PR" --repo "$REPOSITORY" --json headRefOid --jq .headRefOid)"
  head_ref="$(gh pr view "$PARENT_PR" --repo "$REPOSITORY" --json headRefName --jq .headRefName)"
  current_head="$(git -C "$ROOT_DIR" rev-parse HEAD)"
  [[ "$parent_head" == "$current_head" ]] || fail "local trusted head is not exact PR #$PARENT_PR head"
  initialize_cert_worker_identity "$parent_head"

  cert_stage "device" "[3/10] Selecting authorized Android target..."
  select_device

  local temp_dir apk artifact_manifest run_id actual_apk_sha artifact_source_sha local_build_dir xml_file
  temp_dir="$(mktemp -d "${TMPDIR:-/tmp}/bke-android-recovery-cert.XXXXXX")"
  xml_file="$temp_dir/window.xml"
  OPERATOR_TEMP_DIRS+=("$temp_dir")

  cert_stage "sidecar-proof" "[4/10] Resolving exact-head recovery certification run..."
  run_id="$(resolve_recovery_run "$parent_head" "$head_ref")" ||
    fail "no successful exact-head recovery certification run is available"
  verify_recovery_run "$run_id" "$parent_head" ||
    fail "recovery certification run failed exact-head verification"

  cert_stage "local-apk" "[5/10] Verifying local exact-head recovery APK..."
  if [[ -z "$LOCAL_BUILD_ROOT" ]]; then
    LOCAL_BUILD_ROOT="$ROOT_DIR/artifacts/android-recovery-local"
  fi
  local_build_dir="$LOCAL_BUILD_ROOT/$parent_head"
  apk="$(find "$local_build_dir" -maxdepth 1 -type f -name '*.apk' -print -quit 2>/dev/null || true)"
  artifact_manifest="$local_build_dir/manifest.json"

  if [[ -z "$apk" || ! -f "$artifact_manifest" ]]; then
    echo "BKE CERT: local exact-head recovery build is missing."
    echo "Run: BKE_ANDROID_RECOVERY_EXPECTED_SHA=$parent_head bash scripts/build-android-recovery-local.sh"
    fail "local recovery APK is required; remote artifact download is disabled"
  fi

  actual_apk_sha="$(sha256_file "$apk")"
  artifact_source_sha="$(verify_local_recovery_manifest "$artifact_manifest" "$actual_apk_sha" "$parent_head")" ||
    fail "local recovery APK provenance verification failed"
  [[ "$artifact_source_sha" == "$parent_head" ]] || fail "local recovery APK source is not exact parent head"
  verify_local_recovery_apk "$apk"
  echo "BKE CERT: local APK verified; GitHub artifact download skipped."

  cert_stage "sidecar-install" "[6/10] Installing stable-signed recovery sidecar..."
  "${ADB[@]}" shell pm path "$PRIMARY_PACKAGE" >/dev/null 2>&1 || fail "existing $PRIMARY_PACKAGE installation is required to prove side-by-side safety"

  [[ "$SIDECAR_PACKAGE" == "com.bke.worker.gecko.recoverycert" ]] || fail "refusing to replace unexpected sidecar package: $SIDECAR_PACKAGE"

  install_output=""
  if ! install_output="$("${ADB[@]}" install -r "$apk" 2>&1)"; then
    if grep -Fq "INSTALL_FAILED_UPDATE_INCOMPATIBLE" <<<"$install_output"; then
      echo "BKE CERT: one-time migration to the stable LOCAL certification signer..."
      "${ADB[@]}" uninstall "$SIDECAR_PACKAGE" >/dev/null || fail "unable to remove legacy recovery-cert package during signer migration"
      "${ADB[@]}" shell pm path "$PRIMARY_PACKAGE" >/dev/null 2>&1 || fail "primary Worker disappeared during recovery signer migration"
      "${ADB[@]}" install "$apk" >/dev/null || fail "stable-signed recovery sidecar did not install after signer migration"
      echo "BKE CERT: local signer migration complete; future local recovery builds can upgrade in place and preserve app data."
    else
      printf '%s\n' "$install_output" >&2
      fail "stable-signed recovery sidecar install failed"
    fi
  fi

  "${ADB[@]}" shell pm path "$PRIMARY_PACKAGE" >/dev/null 2>&1 || fail "primary Worker disappeared during sidecar install"
  "${ADB[@]}" shell pm path "$SIDECAR_PACKAGE" >/dev/null 2>&1 || fail "recovery sidecar did not install"

  cert_stage "local-recovery" "[7/10] Running local Android recovery matrix..."
  launch_sidecar
  wait_for_text "BROWSER: ATTACHED" 30 "$xml_file" || fail "sidecar browser did not attach"
  if ! wait_for_text "CHAT: READY" 30 "$xml_file"; then
    echo
    echo "Human boundary: authenticate ChatGPT manually inside BKE Worker Recovery Cert."
    echo "Do not paste credentials, cookies, OAuth codes, MFA codes, or security-challenge data into this terminal."
    read -r -p "Press Enter after the ChatGPT composer is visibly usable: " _
    "${ADB[@]}" shell am force-stop --user "$ANDROID_USER_ID" "$SIDECAR_PACKAGE"
    launch_sidecar
    wait_for_text "BROWSER: ATTACHED" 30 "$xml_file" ||
      fail "sidecar browser did not reattach after initial human authentication restart"
    wait_for_text "CHAT: READY" 60 "$xml_file" ||
      fail "ChatGPT did not reach READY after initial human authentication restart"
  fi

  restart_and_require_ready "$xml_file"

  local before_sequence after_sequence failed_sequence
  before_sequence="$(read_recovery_sequence "$xml_file")" || fail "unable to read recovery sequence before content crash"
  run_sidecar_service_action bke.worker.cert.crash_content
  wait_for_recovery_witness "$before_sequence" "SESSION_CRASHED|SESSION_KILLED" 60 "$xml_file" ||
    fail "content crash injection did not produce a fresh Gecko crash/kill recovery witness"

  certify_content_kill_recovery "$xml_file" ||
    fail "content-kill recovery certification failed"
  local actual_kill_result="$REAL_KILL_RESULT"

  before_sequence="$(read_recovery_sequence "$xml_file")" || fail "unable to read recovery sequence before NO_COMPOSER"
  run_sidecar_service_action bke.worker.cert.no_composer
  wait_for_text "CHAT: NO_COMPOSER" 10 "$xml_file" || fail "NO_COMPOSER condition was not observed"
  wait_for_recovery_witness "$before_sequence" "CHAT_READY_TIMEOUT:NO_COMPOSER" 70 "$xml_file" ||
    fail "NO_COMPOSER did not produce a fresh bounded recovery witness"

  before_sequence="$(read_recovery_sequence "$xml_file")" || fail "unable to read recovery sequence before native-port loss"
  run_sidecar_service_action bke.worker.cert.native_port_loss
  wait_for_recovery_witness "$before_sequence" "NATIVE_PORT_DISCONNECTED" 60 "$xml_file" ||
    fail "native-port loss did not produce a fresh bounded recovery witness"

  run_sidecar_service_action bke.worker.cert.exhaust_recovery
  wait_for_text "CHAT: FAILED" 10 "$xml_file" || fail "exhausted recovery did not fail closed"
  wait_for_text "LAST RECOVERY: CERTIFICATION_EXHAUSTED" 5 "$xml_file" || fail "terminal FAILED did not retain exhausted-recovery reason"
  failed_sequence="$(read_recovery_sequence "$xml_file")" || fail "unable to read terminal recovery sequence"
  sleep 17
  wait_for_text "CHAT: FAILED" 5 "$xml_file" || fail "terminal FAILED did not remain sticky beyond readiness window"
  after_sequence="$(read_recovery_sequence "$xml_file")" || fail "unable to read recovery sequence after terminal quiescence window"
  [[ "$after_sequence" == "$failed_sequence" ]] || fail "terminal FAILED continued scheduling recovery after exhaustion"
  restart_and_require_ready "$xml_file"

  cert_stage "relay-config" "[8/10] Preparing PREPRODUCTION relay proof..."
  require_relay_secret_file
  chmod 600 "$SECRET_FILE" 2>/dev/null || true
  set -a
  # shellcheck disable=SC1090
  source "$SECRET_FILE"
  set +a
  [[ "${BKE_WORKER_RELAY_TOKEN_KEY:-}" =~ .{32,} ]] || fail "PREPRODUCTION relay master key is unavailable in the authorized local secret file"

  local derived_token broker_url relay_origin relay_url
  derived_token="$(BKE_WORKER_RELAY_TOKEN_KEY="$BKE_WORKER_RELAY_TOKEN_KEY" node "$ROOT_DIR/cloudflare-relay/scripts/derive-worker-token.mjs" "$WORKER_ID")"
  broker_url="$(gh variable get "$BROKER_VARIABLE" --repo "$REPOSITORY" --json value --jq .value)"
  broker_url="${broker_url%/}"
  [[ "$broker_url" == https://* ]] || fail "$BROKER_VARIABLE is not a valid PREPRODUCTION HTTPS origin"
  relay_origin="${broker_url%/github/app/install-token}"
  relay_origin="${relay_origin%/}"
  [[ "$relay_origin" == https://*.workers.dev ]] || fail "$BROKER_VARIABLE is not the expected PREPRODUCTION workers.dev origin"
  relay_url="wss://${relay_origin#https://}/relay/$WORKER_ID"

  apply_relay_config_securely "$relay_url" "$derived_token"
  unset derived_token BKE_WORKER_RELAY_TOKEN_KEY BKE_WORKER_GITHUB_WEBHOOK_SECRET
  run_sidecar_service_action bke.worker.start_relay
  wait_for_text "RELAY: CONNECTED" 30 "$xml_file" || fail "recovery sidecar did not connect to PREPRODUCTION relay"

  "${ADB[@]}" shell am force-stop --user "$ANDROID_USER_ID" "$SIDECAR_PACKAGE"
  launch_sidecar
  wait_for_text "CHAT: READY" 60 "$xml_file" || fail "process recreation did not restore ChatGPT READY"
  wait_for_text "RELAY: CONNECTED" 45 "$xml_file" || fail "process recreation did not restore requested relay connection"

  cert_stage "uncertain-turn" "[9/10] Running bounded uncertain-turn ownership proof..."
  require_no_worker_assignment
  ensure_worker_label_exists
  gh pr edit "$PARENT_PR" --repo "$REPOSITORY" --add-label "$WORKER_LABEL" >/dev/null || fail "unable to assign certification worker label"

  if ! wait_for_text "CHAT: BUSY" 30 "$xml_file"; then
    run_sidecar_service_action bke.worker.stop_relay || true
    gh pr edit "$PARENT_PR" --repo "$REPOSITORY" --remove-label "$WORKER_LABEL" >/dev/null || true
    comment_parent "BKE EXECUTION CHECKPOINT — LOCAL RECOVERY CERTIFICATION BLOCKED" "$parent_head" "$artifact_source_sha" "$run_id" "$actual_apk_sha" "$actual_kill_result" "BLOCKED — wake never reached CHAT: BUSY"
    fail "bounded wake did not reach an active ChatGPT turn"
  fi

  run_sidecar_service_action bke.worker.cert.crash_content
  wait_for_text "CHAT: BLOCKED_UNCERTAIN_TURN" 20 "$xml_file" || fail "in-flight crash did not fail closed as BLOCKED_UNCERTAIN_TURN"
  run_sidecar_service_action bke.worker.cert.no_composer
  wait_for_text "CHAT: BLOCKED_UNCERTAIN_TURN" 5 "$xml_file" ||
    fail "raw page readiness overwrote unresolved BLOCKED_UNCERTAIN_TURN"
  sleep 15
  wait_for_text "CHAT: BLOCKED_UNCERTAIN_TURN" 5 "$xml_file" || fail "uncertain turn was cleared without explicit operator recovery"

  run_sidecar_service_action bke.worker.cert.resolve_uncertain_reject
  wait_for_text "CHAT: READY" 45 "$xml_file" || fail "explicit uncertain-turn recovery did not return ChatGPT to READY"
  run_sidecar_service_action bke.worker.stop_relay
  wait_for_text "RELAY: STOPPED" 20 "$xml_file" || fail "relay did not stop before ownership release"
  gh pr edit "$PARENT_PR" --repo "$REPOSITORY" --remove-label "$WORKER_LABEL" >/dev/null
  require_no_worker_assignment

  cert_stage "ledger" "[10/10] Recording local certification checkpoint..."
  comment_parent "BKE EXECUTION CHECKPOINT — LOCAL DEVICE CERTIFIED" "$parent_head" "$artifact_source_sha" "$run_id" "$actual_apk_sha" "$actual_kill_result" "PASS"
  CERT_FINAL_RESULT="PASS"
  echo "BKE ANDROID RECOVERY CERTIFICATION: PASS"
  echo "Parent exact head: $parent_head"
  echo "Stable recovery artifact head: $artifact_source_sha"
  echo "Real external Gecko kill lab proof: $actual_kill_result"
  echo "Production: LOCKED"
}

if [[ "${BASH_SOURCE[0]}" == "$0" ]]; then
  main "$@"
fi
