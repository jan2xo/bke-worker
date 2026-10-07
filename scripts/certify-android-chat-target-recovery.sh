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
LEGACY_CERT_WORKER_PREFIX="android-recovery-cert-"
LEGACY_CERT_WORKER_LABEL="bke-worker:android-worker-recovery-cert"
BROKER_VARIABLE="BKE_WORKER_GITHUB_APP_BROKER_URL"
SECRET_FILE="${BKE_WORKER_RELAY_SECRET_FILE:-$HOME/.bke-secrets/bke-worker-cloudflare-preproduction.env}"
TRUSTED_WORKTREE="${BKE_ANDROID_RECOVERY_TRUSTED_WORKTREE:-0}"
OPERATOR_TEMP_DIRS=()
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

ensure_github_auth() {
  if gh auth status --hostname github.com >/dev/null 2>&1; then
    return
  fi
  echo "GitHub authentication is required. Opening the official browser login flow..."
  gh auth login --hostname github.com --web
  gh auth status --hostname github.com >/dev/null 2>&1 || fail "GitHub authentication is still unavailable"
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
    [[ -z "$(git -C "$top" status --porcelain)" ]] || fail "trusted worktree is dirty"
    return
  fi

  git -C "$top" fetch --quiet origin "pull/$PARENT_PR/head"

  if [[ "$(git -C "$top" rev-parse HEAD)" == "$remote_head" && -z "$(git -C "$top" status --porcelain)" ]]; then
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
    wait_for_text "CHAT: READY" 60 "$xml_file" || fail "ChatGPT did not reach READY after human authentication"
  fi
}

load_recovery_proof() {
  local comments_file="$1"
  gh api --paginate --slurp "repos/$REPOSITORY/issues/$PARENT_PR/comments?per_page=100" >"$comments_file"
  python3 - "$comments_file" <<'PY'
import json
import re
import sys
from pathlib import Path
pages = json.loads(Path(sys.argv[1]).read_text(encoding="utf-8"))
comments = [item for page in pages for item in page]
for comment in reversed(comments):
    body = comment.get("body") or ""
    if "RECOVERY SIDECAR SIGNED" not in body:
        continue
    head = re.search(r"Exact head:\s*`([0-9a-f]{40})`", body)
    run = re.search(r"Android Intent Certification\s*`([0-9]+)`", body)
    apk = re.search(r"(?:extracted )?APK SHA-256:?\s*`([0-9a-f]{64})`", body, re.I)
    if head and run and apk:
        print(head.group(1), run.group(1), apk.group(1).lower())
        raise SystemExit(0)
raise SystemExit("No exact-head stable-signed recovery APK checkpoint found on parent PR")
PY
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

try_real_tab_kill() {
  local xml_file="$1"
  local pid
  pid="$("${ADB[@]}" shell ps -A -o PID,NAME 2>/dev/null | tr -d '\r' | awk -v pkg="$SIDECAR_PACKAGE" '$2 ~ ("^" pkg ":") && tolower($2) ~ /tab/ {print $1; exit}')"
  [[ -n "$pid" ]] || return 1

  if "${ADB[@]}" shell run-as "$SIDECAR_PACKAGE" kill -9 "$pid" >/dev/null 2>&1; then
    wait_for_text "CHAT: RECOVERING" 15 "$xml_file" || true
    wait_for_text "CHAT: READY" 45 "$xml_file"
    return
  fi
  return 1
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

clear_stale_certification_assignments() {
  local labels stale
  labels="$(gh pr view "$PARENT_PR" --repo "$REPOSITORY" --json labels --jq '.labels[].name')"
  stale="$(
    printf '%s\n' "$labels" |
      while IFS= read -r label; do
        [[ -n "$label" ]] || continue
        if [[ "$label" == "$LEGACY_CERT_WORKER_LABEL" ||
              "$label" == "bke-worker:${LEGACY_CERT_WORKER_PREFIX}"* ||
              "$label" == "bke-worker:${CERT_WORKER_PREFIX}"* ]]; then
          printf '%s\n' "$label"
        fi
      done
  )"

  [[ -n "$stale" ]] || return 0
  echo "BKE CERT: clearing stale certification-only worker assignment(s) from prior aborted ceremony..."
  while IFS= read -r label; do
    [[ -n "$label" ]] || continue
    gh pr edit "$PARENT_PR" --repo "$REPOSITORY" --remove-label "$label" >/dev/null
  done <<<"$stale"
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
  [[ -z "$labels" ]] || fail "PR #$PARENT_PR already has a worker assignment: $labels"
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
  local sidecar_head="$parent_head"
  local apk_sha="$3"
  local actual_kill="$4"
  local uncertain="$5"
  local device_model android_release
  device_model="$("${ADB[@]}" shell getprop ro.product.model | tr -d '\r')"
  android_release="$("${ADB[@]}" shell getprop ro.build.version.release | tr -d '\r')"
  gh pr comment "$PARENT_PR" --repo "$REPOSITORY" --body "$(cat <<EOF_COMMENT
$title

Parent exact head: \`$parent_head\`
Sidecar exact head: \`$sidecar_head\`
Sidecar APK SHA-256: \`$apk_sha\`
Device: \`$device_model\` / Android \`$android_release\`

Observed locally:
- side-by-side package coexistence: PASS
- human-authenticated ChatGPT READY baseline: PASS
- app close/reopen recovery: PASS
- controlled Gecko content crash recovery: PASS
- real Gecko tab-process kill recovery: $actual_kill
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
  cert_stage "exact-head" "[2/10] Verifying exact PR #52 worktree..."
  ensure_trusted_worktree

  trap 'cert_exit_guard "$?"' EXIT

  local parent_head current_head
  parent_head="$(gh pr view "$PARENT_PR" --repo "$REPOSITORY" --json headRefOid --jq .headRefOid)"
  current_head="$(git -C "$ROOT_DIR" rev-parse HEAD)"
  [[ "$parent_head" == "$current_head" ]] || fail "local trusted head is not exact PR #$PARENT_PR head"
  initialize_cert_worker_identity "$parent_head"

  cert_stage "device" "[3/10] Selecting authorized Android target..."
  select_device

  local temp_dir comments_file proof apk run_id expected_apk_sha proof_head actual_apk_sha xml_file
  temp_dir="$(mktemp -d "${TMPDIR:-/tmp}/bke-android-recovery-cert.XXXXXX")"
  comments_file="$temp_dir/comments.json"
  xml_file="$temp_dir/window.xml"
  OPERATOR_TEMP_DIRS+=("$temp_dir")

  cert_stage "sidecar-proof" "[4/10] Resolving certified sidecar proof..."
  proof="$(load_recovery_proof "$comments_file")"
  read -r proof_head run_id expected_apk_sha <<<"$proof"
  [[ "$proof_head" == "$parent_head" ]] || fail "latest stable recovery proof is stale: certified $proof_head, current $parent_head"

  cert_stage "artifact-download" "[5/10] Downloading stable-signed recovery APK..."
  gh run download "$run_id" --repo "$REPOSITORY" -n bke-worker-android-recovery-sidecar -D "$temp_dir/artifact" >/dev/null
  apk="$(find "$temp_dir/artifact" -type f -name '*.apk' -print -quit)"
  [[ -n "$apk" ]] || fail "certified sidecar artifact did not contain an APK"
  actual_apk_sha="$(sha256_file "$apk")"
  [[ "$actual_apk_sha" == "$expected_apk_sha" ]] || fail "sidecar APK SHA mismatch"

  cert_stage "sidecar-install" "[6/10] Installing stable-signed recovery sidecar..."
  "${ADB[@]}" shell pm path "$PRIMARY_PACKAGE" >/dev/null 2>&1 || fail "existing $PRIMARY_PACKAGE installation is required to prove side-by-side safety"

  [[ "$SIDECAR_PACKAGE" == "com.bke.worker.gecko.recoverycert" ]] || fail "refusing to replace unexpected sidecar package: $SIDECAR_PACKAGE"

  install_output=""
  if ! install_output="$("${ADB[@]}" install -r "$apk" 2>&1)"; then
    if grep -Fq "INSTALL_FAILED_UPDATE_INCOMPATIBLE" <<<"$install_output"; then
      echo "BKE CERT: one-time migration from ephemeral recovery signature to stable PREPRODUCTION signing authority..."
      "${ADB[@]}" uninstall "$SIDECAR_PACKAGE" >/dev/null || fail "unable to remove legacy recovery-cert package during signer migration"
      "${ADB[@]}" shell pm path "$PRIMARY_PACKAGE" >/dev/null 2>&1 || fail "primary Worker disappeared during recovery signer migration"
      "${ADB[@]}" install "$apk" >/dev/null || fail "stable-signed recovery sidecar did not install after signer migration"
      echo "BKE CERT: signer migration complete; future recovery builds can upgrade in place and preserve app data."
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
    wait_for_text "CHAT: READY" 60 "$xml_file" || fail "ChatGPT did not reach READY"
  fi

  restart_and_require_ready "$xml_file"

  run_sidecar_service_action bke.worker.cert.crash_content
  wait_for_text "CHAT: RECOVERING" 15 "$xml_file" || true
  wait_for_text "CHAT: READY" 45 "$xml_file" || fail "content crash did not recover to READY"

  local actual_kill_result="PASS"
  if ! try_real_tab_kill "$xml_file"; then
    actual_kill_result="BLOCKED — device denied real tab-process kill; fixed onKill callback path only"
    run_sidecar_service_action bke.worker.cert.simulate_content_kill
    wait_for_text "CHAT: RECOVERING" 15 "$xml_file" || true
    wait_for_text "CHAT: READY" 45 "$xml_file" || fail "simulated content-kill callback did not recover"
  fi

  run_sidecar_service_action bke.worker.cert.no_composer
  wait_for_text "CHAT: NO_COMPOSER" 10 "$xml_file" || fail "NO_COMPOSER condition was not observed"
  wait_for_text "CHAT: READY" 50 "$xml_file" || fail "NO_COMPOSER did not recover to READY"

  run_sidecar_service_action bke.worker.cert.native_port_loss
  wait_for_text "CHAT: RECOVERING" 15 "$xml_file" || true
  wait_for_text "LAST RECOVERY: NATIVE_PORT_DISCONNECTED" 25 "$xml_file" || fail "native-port loss did not traverse bounded recovery"
  wait_for_text "CHAT: READY" 45 "$xml_file" || fail "native-port loss did not recover to READY"

  run_sidecar_service_action bke.worker.cert.exhaust_recovery
  wait_for_text "CHAT: FAILED" 10 "$xml_file" || fail "exhausted recovery did not fail closed"
  restart_and_require_ready "$xml_file"

  cert_stage "relay-config" "[8/10] Preparing PREPRODUCTION relay proof..."
  [[ -f "$SECRET_FILE" ]] || fail "PREPRODUCTION relay secret file not found: $SECRET_FILE"
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
  clear_stale_certification_assignments
  require_no_worker_assignment
  ensure_worker_label_exists
  gh pr edit "$PARENT_PR" --repo "$REPOSITORY" --add-label "$WORKER_LABEL" >/dev/null || fail "unable to assign certification worker label"

  if ! wait_for_text "CHAT: BUSY" 30 "$xml_file"; then
    run_sidecar_service_action bke.worker.stop_relay || true
    gh pr edit "$PARENT_PR" --repo "$REPOSITORY" --remove-label "$WORKER_LABEL" >/dev/null || true
    comment_parent "BKE EXECUTION CHECKPOINT — LOCAL RECOVERY CERTIFICATION BLOCKED" "$parent_head" "$actual_apk_sha" "$actual_kill_result" "BLOCKED — wake never reached CHAT: BUSY"
    fail "bounded wake did not reach an active ChatGPT turn"
  fi

  run_sidecar_service_action bke.worker.cert.crash_content
  wait_for_text "CHAT: BLOCKED_UNCERTAIN_TURN" 20 "$xml_file" || fail "in-flight crash did not fail closed as BLOCKED_UNCERTAIN_TURN"
  sleep 15
  wait_for_text "CHAT: BLOCKED_UNCERTAIN_TURN" 5 "$xml_file" || fail "uncertain turn was cleared without explicit operator recovery"

  run_sidecar_service_action bke.worker.cert.resolve_uncertain_reject
  wait_for_text "CHAT: READY" 45 "$xml_file" || fail "explicit uncertain-turn recovery did not return ChatGPT to READY"
  run_sidecar_service_action bke.worker.stop_relay
  wait_for_text "RELAY: STOPPED" 20 "$xml_file" || fail "relay did not stop before ownership release"
  gh pr edit "$PARENT_PR" --repo "$REPOSITORY" --remove-label "$WORKER_LABEL" >/dev/null
  require_no_worker_assignment

  cert_stage "ledger" "[10/10] Recording local certification checkpoint..."
  if [[ "$actual_kill_result" != "PASS" ]]; then
    comment_parent "BKE EXECUTION CHECKPOINT — LOCAL RECOVERY CERTIFICATION BLOCKED" "$parent_head" "$actual_apk_sha" "$actual_kill_result" "PASS"
    CERT_FINAL_RESULT="BLOCKED"
    echo "BKE ANDROID RECOVERY CERTIFICATION: BLOCKED"
    echo "All bounded recovery/uncertain-turn proof passed except a real Gecko tab-process kill, which this Android device denied."
    exit 2
  fi

  comment_parent "BKE EXECUTION CHECKPOINT — LOCAL DEVICE CERTIFIED" "$parent_head" "$actual_apk_sha" "PASS" "PASS"
  CERT_FINAL_RESULT="PASS"
  echo "BKE ANDROID RECOVERY CERTIFICATION: PASS"
  echo "Parent exact head: $parent_head"
  echo "Stable recovery artifact head: $parent_head"
  echo "Production: LOCKED"
}

if [[ "${BASH_SOURCE[0]}" == "$0" ]]; then
  main "$@"
fi
