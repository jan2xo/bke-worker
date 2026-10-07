#!/usr/bin/env python3
from pathlib import Path
import json
import os
import subprocess
import tempfile

root = Path(__file__).resolve().parents[1]
operator_script_path = root / "scripts/certify-android-chat-target-recovery.sh"
operator_script = operator_script_path.read_text(encoding="utf-8")

subprocess.run(["bash", "-n", str(operator_script_path)], check=True)

for token in (
    'verify_recovery_run "$run_id" "$parent_head"',
    'gh run view "$run_id" --repo "$REPOSITORY" --json headSha,conclusion,event,jobs',
    '"Android recovery sidecar stable signed build"',
    '"Required certification"',
    'verify_recovery_artifact_manifest',
    '"workflow_run_id": int(run_id)',
    '"package_name": "com.bke.worker.gecko.recoverycert"',
    '"signing_authority": "PREPRODUCTION"',
    '"certification_state": "recovery-cert-certified"',
    'artifact_source_sha="$(verify_recovery_artifact_manifest',
    'local sidecar_head="$3"',
    'Sidecar certification run:',
    'wait_for_recovery_witness',
    '"SESSION_CRASHED"',
    '"SESSION_KILLED"',
    '"CHAT_READY_TIMEOUT:NO_COMPOSER"',
    'terminal FAILED continued scheduling recovery after exhaustion',
    'explicitly resolve and release the existing owner before rerunning',
):
    assert token in operator_script, token

assert "clear_stale_certification_assignments" not in operator_script

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
        "workflow_run_id": run_id,
        "component": "BKE Worker Android Recovery Cert",
        "package_name": "com.bke.worker.gecko.recoverycert",
        "architecture": "arm64-v8a",
        "version_name": "0.0.1-probe-recoverycert",
        "version_code": 1,
        "sha256": apk_sha,
        "signer_certificate_sha256": signer_sha,
        "signing_authority": "PREPRODUCTION",
        "certification_state": "recovery-cert-certified",
    }
    manifest_path.write_text(json.dumps(manifest), encoding="utf-8")

    manifest_probe = r"""
set -euo pipefail
source "$1"
verified="$(verify_recovery_artifact_manifest "$2" "$3" "$4" "$5")"
[[ "$verified" == "$4" ]]
"""
    subprocess.run(
        [
            "bash",
            "-c",
            manifest_probe,
            "bke-recovery-manifest-proof",
            str(operator_script_path),
            str(manifest_path),
            apk_sha,
            head,
            str(run_id),
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
            "bke-recovery-manifest-proof",
            str(operator_script_path),
            str(manifest_path),
            apk_sha,
            head,
            str(run_id),
        ]
    )
    assert bad.returncode != 0

witness_probe = r"""
set -euo pipefail
source "$1"

ui_text() {
    printf '%s\n'       "BROWSER: ATTACHED"       "CHAT: READY"       "LAST RECOVERY: SESSION_CRASHED"       "RECOVERY SEQ: 7"
}
if wait_for_recovery_witness 7 SESSION_CRASHED 1 /tmp/unused; then
    exit 91
fi

ui_text() {
    printf '%s\n'       "BROWSER: ATTACHED"       "CHAT: READY"       "LAST RECOVERY: SESSION_CRASHED"       "RECOVERY SEQ: 8"
}
wait_for_recovery_witness 7 SESSION_CRASHED 2 /tmp/unused
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
