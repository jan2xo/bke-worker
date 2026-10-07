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
    '"Android recovery sidecar stable signed build"',
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
):
    assert token in operator_script, token

assert 'gh run download "$run_id"' not in operator_script
assert 'repos/$REPOSITORY/issues/$PARENT_PR/comments' not in operator_script
assert 'RECOVERY SIDECAR SIGNED' not in operator_script
assert 'signer certificate SHA-256' not in operator_script
assert "clear_stale_certification_assignments" not in operator_script

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
):
    assert forbidden not in builder_script, forbidden

head = "0123456789abcdef0123456789abcdef01234567"
run_id = 123456789
apk_sha = "a" * 64
signer_sha = "b" * 64

good_run = {
    "headSha": head,
    "conclusion": "success",
    "event": "workflow_dispatch",
    "jobs": [
        {"name": "Android recovery sidecar stable signed build", "conclusion": "success"},
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
    return 99
}
resolved="$(resolve_recovery_run "$2" "$3")"
[[ "$resolved" == "$4" ]]
"""
resolver_env = dict(os.environ)
resolver_env["MOCK_RUNS_JSON"] = json.dumps(resolver_runs)
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
