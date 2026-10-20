#!/usr/bin/env python3
from pathlib import Path
import subprocess

root = Path(__file__).resolve().parents[1]
script_path = root / "scripts/forge-f1-desktop-readiness.sh"
policy_path = root / "browser-extension/scripts/forge-f1-readiness-policy.mjs"
manifest_path = root / "browser-extension/manifest.json"
script = script_path.read_text(encoding="utf-8")
policy = policy_path.read_text(encoding="utf-8")
manifest = manifest_path.read_text(encoding="utf-8")

for token in (
    "scripts/smoke-desktop-native-integration.sh",
    "scripts/prepare-chrome-native-host.sh",
    "refs/heads/main:refs/remotes/origin/main",
    "STALE_CHECKOUT",
    "PROFILE_PATH_UNSAFE",
    "chrome://extensions",
    "CHATGPT_AUTHENTICATED_AND_IDLE",
    "THIS_IS_THE_ONLY_F1_EXPERIMENT_PROFILE",
    "PREPARE_USER_LEVEL_CHROME_NATIVE_HOST",
    "nativeMessagingPermission\":False",
    "NOT_CREATED_NO_SEND_OCCURRED",
    "BKE_F1_CHROME_RUNTIME_SHA256",
    "umask 077",
    "SOURCE_SMOKE_SHA_MISMATCH",
):
    assert token in script, token

for forbidden in (
    "chrome.cookies",
    "chrome.debugger",
    "--remote-debugging-port",
    "playwright",
    "puppeteer",
    "wrangler deploy",
    "gh workflow run",
    "readFileSync(PREFERENCES",
    "localStorage",
):
    assert forbidden not in script, forbidden

assert '"nativeMessaging"' in script  # deny-list, never permission grant
assert "nativeMessaging" not in manifest
assert "permissions: [\"storage\"]" in policy
assert "NATIVE_HOST_EXTENSION_ORIGIN_MISMATCH" in policy
assert "CHATGPT_TARGET_COUNT_NOT_ONE" in policy
assert "PROFILE_PATH_UNSAFE" in policy
assert "MESSAGE_SEND_NOT_PROVEN_ABSENT" in policy
assert "SOURCE_SMOKE_PASS" in policy and "REAL_CHROME_READY" in policy
assert "NOT_TESTED_NATIVE_MESSAGING_PERMISSION_ABSENT_BY_DESIGN" in policy

for command in (
    ["bash", "-n", str(script_path)],
    ["node", "--check", str(policy_path)],
):
    result = subprocess.run(command, text=True, capture_output=True)
    assert result.returncode == 0, result.stderr

print("BKE FORGE F1 desktop readiness entrypoint contract: PASS")
