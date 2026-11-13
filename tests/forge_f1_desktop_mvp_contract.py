#!/usr/bin/env python3
from pathlib import Path
import subprocess

root = Path(__file__).resolve().parents[1]
script_path = root / "scripts/certify-forge-f1-desktop-mvp.sh"
script = script_path.read_text(encoding="utf-8")

subprocess.run(["bash", "-n", str(script_path)], check=True)
help_res = subprocess.run(
    ["bash", str(script_path), "--help"],
    check=True,
    capture_output=True,
    text=True,
)
assert "Usage: bash scripts/certify-forge-f1-desktop-mvp.sh" in help_res.stdout
assert "--dry-run" in help_res.stdout

for token in (
    "set -Eeuo pipefail",
    "umask 077",
    "OPERATOR_TEMP_FILES=()",
    "cleanup_operator_temp_files()",
    "trap cleanup_operator_temp_files EXIT",
    "pwd -P",
    'REPOSITORY_CANONICAL="jan2xo/bke-worker"',
    "FIRST_MESSAGE_LIVE_SEND_ENABLED = false as const",
    "CONVERSATION_CONTINUATION_LIVE_SEND_ENABLED = false as const",
    'npm --prefix "$ROOT_DIR/browser-extension" run check',
    'node "$ROOT_DIR/scripts/input-only-lint.mjs"',
    'node --test "$ROOT_DIR/scripts/input-only-lint.test.mjs"',
    'npm --prefix "$ROOT_DIR/browser-extension" run smoke:native',
    'python3 "$ROOT_DIR/tests/chrome_native_host_installer_contract.py"',
    "BKE_F1_MVP_SOURCE_ACCEPTANCE=PASS",
    "BKE_F1_LIVE_SEND_DEFAULTS=LOCKED_FALSE",
    "BKE_REAL_CHROME_ACCEPTANCE=NOT_RUN",
):
    assert token in script, token

for forbidden in (
    "git commit",
    "git push",
    "FIRST_MESSAGE_LIVE_SEND_ENABLED = true",
    "CONVERSATION_CONTINUATION_LIVE_SEND_ENABLED = true",
    "gh auth token",
):
    assert forbidden not in script, forbidden

print("BKE Worker FORGE F1 Desktop MVP contract: PASS")
