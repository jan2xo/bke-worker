#!/usr/bin/env python3
from pathlib import Path
import json
import os
import subprocess
import tempfile

root = Path(__file__).resolve().parents[1]
operator_script_path = root / "scripts/certify-android-chat-target-recovery.sh"
builder_script_path = root / "scripts/build-android-recovery-local.sh"
operator_script = operator_script_path.read_text(encoding="utf-8")
builder_script = builder_script_path.read_text(encoding="utf-8")

subprocess.run(["bash", "-n", str(operator_script_path)], check=True)
subprocess.run(["bash", "-n", str(builder_script_path)], check=True)

for token in (
    'resolve_recovery_run "$parent_head" "$head_ref"',
    'gh run list',
    '--event workflow_dispatch',
    'verify_recovery_run "$run_id" "$parent_head"',
    'gh run view "$run_id" --repo "$REPOSITORY" --json headSha,conclusion,event,jobs',
    '"Android recovery local contract"',
    '"Required certification"',
    'verify_local_recovery_manifest',
    'verify_local_recovery_apk',
    'LOCAL_CERT_FILE="$LOCAL_SIGNING_DIR/cert.sha256"',
    '"build_origin": "local-exact-head"',
    '"package_name": "com.bke.worker.gecko.recoverycert"',
    '"signing_authority": "LOCAL_CERTIFICATION"',
    '"certification_state": "recovery-cert-local-build"',
    'artifact_source_sha="$(verify_local_recovery_manifest',
    'local sidecar_head="$3"',
    'Sidecar certification run:',
    'cert_stage "local-apk" "[5/10] Verifying local exact-head recovery APK..."',
    'bash scripts/build-android-recovery-local.sh',
    'remote artifact download is disabled',
    'wait_for_recovery_witness',
    '"SESSION_CRASHED|SESSION_KILLED"',
    '"SESSION_KILLED"',
    '"CHAT_READY_TIMEOUT:NO_COMPOSER"',
    'terminal FAILED continued scheduling recovery after exhaustion',
    'explicitly resolve and release the existing owner before rerunning',
    'status --porcelain --untracked-files=no',
    'force-stop --user "$ANDROID_USER_ID" "$SIDECAR_PACKAGE"',
    'sidecar browser did not reattach after human authentication restart',
    'ChatGPT did not reach READY after human authentication restart',
    'list_gecko_tab_pids',
    'read_sidecar_main_pid',
    'am kill --user "$ANDROID_USER_ID" "$SIDECAR_PACKAGE"',
    'ActivityManager real package-process kill proved active-session recovery',
    'refusing whole-app restart as tab-kill proof',
    'refusing causal attribution',
    'ADB_ROOTED_BY_CERT=0',
    'restore_adb_privilege',
    'getprop ro.kernel.qemu',
    'getprop ro.build.type',
    '"${ADB[@]}" root',
    '"${ADB[@]}" shell id -u',
    '"${ADB[@]}" shell kill -9 "$pid"',
    'emulator-root real Gecko tab-process kill proved active-session recovery',
    'refusing contaminated tab-kill proof',
    'certify_content_kill_recovery',
    'optional lab proof not observed',
    'real Gecko process death was observed but required recovery proof failed or became ambiguous',
    'Gecko onKill callback recovery with fresh SESSION_KILLED witness (required): PASS',
    'real external Gecko tab-process kill integration (optional lab proof)',
):
    assert token in operator_script, token

human_start = operator_script.index('Human boundary: complete ChatGPT authentication/security checks inside BKE Worker Recovery Cert.')
human_end = operator_script.index('read_recovery_sequence()', human_start)
human_block = operator_script[human_start:human_end]
assert human_block.index('Press Enter after the ChatGPT composer is visibly usable') < human_block.index('force-stop --user "$ANDROID_USER_ID" "$SIDECAR_PACKAGE"')
assert human_block.index('force-stop --user "$ANDROID_USER_ID" "$SIDECAR_PACKAGE"') < human_block.index('ChatGPT did not reach READY after human authentication restart')

assert 'gh run download "$run_id"' not in operator_script
assert 'repos/$REPOSITORY/issues/$PARENT_PR/comments' not in operator_script
assert 'RECOVERY SIDECAR SIGNED' not in operator_script
assert 'signer certificate SHA-256' not in operator_script
assert "clear_stale_certification_assignments" not in operator_script
assert 'if [[ "$actual_kill_result" != "PASS" ]]' not in operator_script
assert 'All bounded recovery/uncertain-turn proof passed except a real Gecko tab-process kill' not in operator_script

for token in (
    'BKE_ANDROID_RECOVERY_LOCAL_SIGNING_DIR',
    'recovery-local.p12',
    'signing.env',
    'cert.sha256',
    'keytool -genkeypair',
    'BKE_ANDROID_RECOVERY_KEYSTORE_PATH',
    'BKE_ANDROID_RECOVERY_STORE_PASSWORD',
    'BKE_ANDROID_RECOVERY_KEY_ALIAS',
    'BKE_ANDROID_RECOVERY_KEY_PASSWORD',
    'BKE_ANDROID_GRADLE_OFFLINE',
    ':app:assembleRecovery',
    '--offline',
    'verify --verbose --print-certs',
    'manifest debuggable',
    'manifest application-id',
    '"build_origin": "local-exact-head"',
    '"signing_authority": "LOCAL_CERTIFICATION"',
    '"certification_state": "recovery-cert-local-build"',
    'artifacts/android-recovery-local',
    'Network artifact download: NONE',
    'diff --quiet --ignore-submodules',
):
    assert token in builder_script, token

for forbidden in (
    "gh run download",
    "curl ",
    "wget ",
    "wrangler deploy",
    "production deploy",
    "set -x",
    "trap cleanup EXIT",
    '; cleanup\' EXIT',
):
    assert forbidden not in builder_script, forbidden

assert 'trap \'rm -f -- "$signer_report"\' EXIT' in builder_script
assert 'rm -f -- "$signer_report"\n  trap - EXIT' in builder_script

head = "0123456789abcdef0123456789abcdef01234567"
run_id = 123456789
apk_sha = "a" * 64
signer_sha = "b" * 64

good_run = {
    "headSha": head,
    "conclusion": "success",
    "event": "workflow_dispatch",
    "jobs": [
        {"name": "Android recovery local contract", "conclusion": "success"},
        {"name": "Required certification", "conclusion": "success"},
    ],
}

run_probe = r"""
set -euo pipefail
source "$1"
gh() {
    if [[ "$1" == "run" && "$2" == "view" ]]; then
        printf '%s\n' "$MOCK_RUN_JSON"
        return 0
    fi
    return 99
}
verify_recovery_run "$2" "$3"
"""

resolver_runs = [
    {"databaseId": run_id, "headSha": head, "conclusion": "success", "createdAt": "2026-10-07T00:00:00Z"},
    {"databaseId": run_id - 1, "headSha": "f" * 40, "conclusion": "success", "createdAt": "2026-10-06T00:00:00Z"},
]
resolver_probe = r"""
set -euo pipefail
source "$1"
gh() {
    if [[ "$1" == "run" && "$2" == "list" ]]; then
        printf '%s\n' "$MOCK_RUNS_JSON"
        return 0
    fi
    if [[ "$1" == "run" && "$2" == "view" ]]; then
        printf '%s\n' "$MOCK_RUN_JSON"
        return 0
    fi
    return 99
}
resolved="$(resolve_recovery_run "$2" "$3")"
[[ "$resolved" == "$4" ]]
"""
resolver_env = dict(os.environ)
resolver_env["MOCK_RUNS_JSON"] = json.dumps(resolver_runs)
resolver_env["MOCK_RUN_JSON"] = json.dumps(good_run)
subprocess.run(
    [
        "bash", "-c", resolver_probe, "bke-recovery-run-resolver",
        str(operator_script_path), head, "fix/android-chat-target-recovery", str(run_id),
    ],
    check=True,
    env=resolver_env,
)

env = dict(os.environ)
env["MOCK_RUN_JSON"] = json.dumps(good_run)
subprocess.run(
    ["bash", "-c", run_probe, "bke-recovery-run-proof", str(operator_script_path), str(run_id), head],
    check=True,
    env=env,
)

bad_run = dict(good_run)
bad_run["headSha"] = "f" * 40
env["MOCK_RUN_JSON"] = json.dumps(bad_run)
bad = subprocess.run(
    ["bash", "-c", run_probe, "bke-recovery-run-proof", str(operator_script_path), str(run_id), head],
    env=env,
)
assert bad.returncode != 0

with tempfile.TemporaryDirectory() as td:
    manifest_path = Path(td) / "manifest.json"
    manifest = {
        "source_sha": head,
        "build_origin": "local-exact-head",
        "component": "BKE Worker Android Recovery Cert",
        "package_name": "com.bke.worker.gecko.recoverycert",
        "architecture": "arm64-v8a",
        "version_name": "0.0.1-probe-recoverycert",
        "version_code": 1,
        "sha256": apk_sha,
        "signer_certificate_sha256": signer_sha,
        "signing_authority": "LOCAL_CERTIFICATION",
        "certification_state": "recovery-cert-local-build",
        "apk_file": "BKE.Worker.Android.RECOVERY-CERT.arm64-v0.0.1-probe-recoverycert.apk",
    }
    manifest_path.write_text(json.dumps(manifest), encoding="utf-8")

    manifest_probe = r"""
set -euo pipefail
source "$1"
verified="$(verify_local_recovery_manifest "$2" "$3" "$4")"
[[ "$verified" == "$4" ]]
"""
    subprocess.run(
        [
            "bash",
            "-c",
            manifest_probe,
            "bke-recovery-local-manifest-proof",
            str(operator_script_path),
            str(manifest_path),
            apk_sha,
            head,
        ],
        check=True,
    )

    manifest["source_sha"] = "e" * 40
    manifest_path.write_text(json.dumps(manifest), encoding="utf-8")
    bad = subprocess.run(
        [
            "bash",
            "-c",
            manifest_probe,
            "bke-recovery-local-manifest-proof",
            str(operator_script_path),
            str(manifest_path),
            apk_sha,
            head,
        ]
    )
    assert bad.returncode != 0

witness_probe = r"""
set -euo pipefail
source "$1"

ui_text() {
    printf '%s\n' \
      "BROWSER: ATTACHED" \
      "CHAT: READY" \
      "LAST RECOVERY: SESSION_KILLED" \
      "RECOVERY SEQ: 7"
}
if wait_for_recovery_witness 7 'SESSION_CRASHED|SESSION_KILLED' 1 /tmp/unused; then
    exit 91
fi

ui_text() {
    printf '%s\n' \
      "BROWSER: ATTACHED" \
      "CHAT: READY" \
      "LAST RECOVERY: SESSION_KILLED" \
      "RECOVERY SEQ: 8"
}
wait_for_recovery_witness 7 'SESSION_CRASHED|SESSION_KILLED' 2 /tmp/unused
"""
subprocess.run(
    ["bash", "-c", witness_probe, "bke-recovery-witness-proof", str(operator_script_path)],
    check=True,
)

kill_timeout_classifier_probe = r"""
set -euo pipefail
source "$1"
MODE="$2"

ui_text() {
    if [[ "$MODE" == "killed-unhealthy" ]]; then
        printf '%s\n' \
          "BROWSER: ATTACHED" \
          "CHAT: RECOVERING" \
          "LAST RECOVERY: SESSION_KILLED" \
          "RECOVERY SEQ: 8"
    else
        printf '%s\n' \
          "BROWSER: ATTACHED" \
          "CHAT: READY" \
          "LAST RECOVERY: NATIVE_PORT_DISCONNECTED" \
          "RECOVERY SEQ: 8"
    fi
}

set +e
classify_failed_kill_witness 7 /tmp/unused
rc=$?
set -e

if [[ "$MODE" == "killed-unhealthy" ]]; then
    [[ "$rc" -eq 2 ]]
else
    [[ "$rc" -eq 1 ]]
fi
"""
subprocess.run(
    ["bash", "-c", kill_timeout_classifier_probe, "bke-recovery-kill-timeout-hard-fail", str(operator_script_path), "killed-unhealthy"],
    check=True,
)
subprocess.run(
    ["bash", "-c", kill_timeout_classifier_probe, "bke-recovery-kill-timeout-contaminated", str(operator_script_path), "other-recovery"],
    check=True,
)

unattributed_tab_disappearance_probe = r"""
set -euo pipefail
source "$1"
ADB=(adb_mock)
KILLED=0
SIDECAR_PACKAGE="com.bke.worker.gecko.recoverycert"

adb_mock() {
    if [[ "$1" == "shell" && "$2" == "ps" ]]; then
        printf '%s\n' "PID NAME" "100 $SIDECAR_PACKAGE"
        if [[ "$KILLED" == "0" ]]; then
            printf '%s\n' "200 $SIDECAR_PACKAGE:tab0"
        fi
        return 0
    fi
    if [[ "$1" == "shell" && "$2" == "run-as" && "$4" == "kill" ]]; then
        KILLED=1
        return 0
    fi
    return 99
}

wait_for_recovery_witness() {
    return 1
}

ui_text() {
    printf '%s\n' \
      "BROWSER: ATTACHED" \
      "CHAT: READY" \
      "LAST RECOVERY: SESSION_KILLED" \
      "RECOVERY SEQ: 7"
}

set +e
try_real_tab_kill /tmp/unused 7
rc=$?
set -e
[[ "$rc" -eq 1 ]]
[[ "$REAL_KILL_RESULT" == INCONCLUSIVE* ]]
"""
subprocess.run(
    ["bash", "-c", unattributed_tab_disappearance_probe, "bke-recovery-unattributed-tab-disappearance", str(operator_script_path)],
    check=True,
)

activity_manager_kill_probe = r"""
set -euo pipefail
source "$1"
ANDROID_USER_ID=0
ADB=(adb_mock)
AM_KILL_DONE=0
AM_CHANGE_MAIN="${2:-0}"

adb_mock() {
    if [[ "$1" == "shell" && "$2" == "ps" ]]; then
        if [[ "$AM_KILL_DONE" == "0" ]]; then
            printf '%s\n'               "PID NAME"               "100 com.bke.worker.gecko.recoverycert"               "200 com.bke.worker.gecko.recoverycert:tab0"
        else
            if [[ "$AM_CHANGE_MAIN" == "1" ]]; then
                main_pid=101
            else
                main_pid=100
            fi
            printf '%s\n'               "PID NAME"               "$main_pid com.bke.worker.gecko.recoverycert"               "201 com.bke.worker.gecko.recoverycert:tab1"
        fi
        return 0
    fi
    if [[ "$1" == "shell" && "$2" == "run-as" ]]; then
        return 1
    fi
    if [[ "$1" == "shell" && "$2" == "am" && "$3" == "kill" ]]; then
        AM_KILL_DONE=1
        return 0
    fi
    return 99
}

wait_for_recovery_witness() {
    [[ "$AM_KILL_DONE" == "1" ]]
}

try_real_tab_kill /tmp/unused 7
"""

subprocess.run(
    ["bash", "-c", activity_manager_kill_probe, "bke-recovery-am-kill-proof", str(operator_script_path), "0"],
    check=True,
)

bad = subprocess.run(
    ["bash", "-c", activity_manager_kill_probe, "bke-recovery-am-kill-restart-reject", str(operator_script_path), "1"],
)
assert bad.returncode != 0

root_kill_probe = r"""
set -euo pipefail
source "$1"
ADB=(adb_mock)
ROOTED=0
KILLED_PID=""
MAIN_CHANGED="${2:-0}"

adb_mock() {
    if [[ "$1" == "root" ]]; then
        ROOTED=1
        return 0
    fi
    if [[ "$1" == "unroot" ]]; then
        ROOTED=0
        return 0
    fi
    if [[ "$1" == "wait-for-device" ]]; then
        return 0
    fi
    if [[ "$1" == "shell" && "$2" == "getprop" && "$3" == "ro.kernel.qemu" ]]; then
        printf '1\n'
        return 0
    fi
    if [[ "$1" == "shell" && "$2" == "getprop" && "$3" == "ro.build.type" ]]; then
        printf 'userdebug\n'
        return 0
    fi
    if [[ "$1" == "shell" && "$2" == "id" && "$3" == "-u" ]]; then
        if [[ "$ROOTED" == "1" ]]; then printf '0\n'; else printf '2000\n'; fi
        return 0
    fi
    if [[ "$1" == "shell" && "$2" == "ps" ]]; then
        if [[ -z "$KILLED_PID" ]]; then
            printf '%s\n'               "PID NAME"               "100 com.bke.worker.gecko.recoverycert"               "200 com.bke.worker.gecko.recoverycert:tab0"
        else
            if [[ "$MAIN_CHANGED" == "1" ]]; then main_pid=101; else main_pid=100; fi
            printf '%s\n'               "PID NAME"               "$main_pid com.bke.worker.gecko.recoverycert"               "201 com.bke.worker.gecko.recoverycert:tab1"
        fi
        return 0
    fi
    if [[ "$1" == "shell" && "$2" == "kill" && "$3" == "-9" ]]; then
        [[ "$ROOTED" == "1" ]] || return 1
        KILLED_PID="$4"
        return 0
    fi
    return 99
}

wait_for_recovery_witness() {
    [[ -n "$KILLED_PID" ]]
}

read_recovery_sequence() {
    printf '7\n'
}

try_root_emulator_tab_kill /tmp/unused 7
[[ "$ROOTED" == "0" ]]
"""

subprocess.run(
    ["bash", "-c", root_kill_probe, "bke-recovery-root-kill-proof", str(operator_script_path), "0"],
    check=True,
)

bad = subprocess.run(
    ["bash", "-c", root_kill_probe, "bke-recovery-root-kill-main-restart-reject", str(operator_script_path), "1"],
)
assert bad.returncode != 0

physical_device_probe = r"""
set -euo pipefail
source "$1"
ADB=(adb_mock)
ROOT_CALLED=0

adb_mock() {
    if [[ "$1" == "shell" && "$2" == "getprop" && "$3" == "ro.kernel.qemu" ]]; then
        printf '0\n'
        return 0
    fi
    if [[ "$1" == "root" ]]; then
        ROOT_CALLED=1
        return 0
    fi
    return 99
}

set +e
try_root_emulator_tab_kill /tmp/unused 7
rc=$?
set -e
[[ "$rc" -ne 0 ]]
[[ "$ROOT_CALLED" == "0" ]]
"""
subprocess.run(
    ["bash", "-c", physical_device_probe, "bke-recovery-root-kill-physical-reject", str(operator_script_path)],
    check=True,
)

optional_kill_probe = r"""
set -euo pipefail
source "$1"
SEQUENCE=7
CALLBACK_INJECTED=0

read_recovery_sequence() {
    printf '%s\n' "$SEQUENCE"
}

try_real_tab_kill() {
    return 1
}

run_sidecar_service_action() {
    [[ "$1" == "bke.worker.cert.simulate_content_kill" ]]
    CALLBACK_INJECTED=1
    SEQUENCE=8
}

wait_for_recovery_witness() {
    [[ "$1" == "7" ]]
    [[ "$2" == "SESSION_KILLED" ]]
    [[ "$CALLBACK_INJECTED" == "1" ]]
    [[ "$SEQUENCE" == "8" ]]
}

certify_content_kill_recovery /tmp/unused
[[ "$REAL_KILL_RESULT" == NOT\ AVAILABLE* ]]
[[ "$CALLBACK_INJECTED" == "1" ]]
"""
subprocess.run(
    ["bash", "-c", optional_kill_probe, "bke-recovery-optional-real-kill-proof", str(operator_script_path)],
    check=True,
)

contradictory_kill_probe = r"""
set -euo pipefail
source "$1"
CALLBACK_INJECTED=0

read_recovery_sequence() {
    printf '7\n'
}

try_real_tab_kill() {
    return 2
}

run_sidecar_service_action() {
    CALLBACK_INJECTED=1
}

set +e
certify_content_kill_recovery /tmp/unused
rc=$?
set -e
[[ "$rc" -ne 0 ]]
[[ "$CALLBACK_INJECTED" == "0" ]]
"""
subprocess.run(
    ["bash", "-c", contradictory_kill_probe, "bke-recovery-real-kill-contradiction-fails", str(operator_script_path)],
    check=True,
)

with tempfile.TemporaryDirectory() as td:
    removal_marker = Path(td) / "removed"
    ownership_probe = r"""
set -euo pipefail
source "$1"
export REMOVAL_MARKER="$2"

gh() {
    if [[ "$1" == "pr" && "$2" == "list" ]]; then
        printf '%s\n' '[]'
        return 0
    fi
    if [[ "$1" == "pr" && "$2" == "view" ]]; then
        printf '%s\n' 'bke-worker:rc-live-owner'
        return 0
    fi
    if [[ " $* " == *" --remove-label "* ]]; then
        touch "$REMOVAL_MARKER"
        return 0
    fi
    return 99
}

set +e
( require_no_worker_assignment )
rc=$?
set -e
[[ "$rc" -ne 0 ]]
[[ ! -e "$REMOVAL_MARKER" ]]
"""
    subprocess.run(
        [
            "bash",
            "-c",
            ownership_probe,
            "bke-recovery-ownership-proof",
            str(operator_script_path),
            str(removal_marker),
        ],
        check=True,
    )

print("BKE Worker Android recovery operator negative-path contract: PASS")
