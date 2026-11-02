#!/usr/bin/env python3
from pathlib import Path
import subprocess
import tempfile

root = Path(__file__).resolve().parents[1]
script_path = root / "scripts/forge-f1-desktop-readiness.sh"
policy_path = root / "browser-extension/scripts/forge-f1-readiness-policy.mjs"
manifest_path = root / "browser-extension/manifest.json"
script = script_path.read_text(encoding="utf-8")
policy = policy_path.read_text(encoding="utf-8")
manifest = manifest_path.read_text(encoding="utf-8")
helper = (root / "scripts/forge_f1_chrome_readiness.py").read_text(encoding="utf-8")
workflow = (root / ".github/workflows/pr-guard.yml").read_text(encoding="utf-8")

for token in (
    "scripts/smoke-desktop-native-integration.sh",
    "scripts/prepare-chrome-native-host.sh",
    "scripts/forge_f1_chrome_readiness.py",
    "--check-profile-chain",
    "--check-process",
    "--validate-extension-count",
    "PROFILE_CHAIN_UNSAFE",
    "EXTENSION_COUNT_INPUT",
    "refs/heads/main:refs/remotes/origin/main",
    "STALE_CHECKOUT",
    "PROFILE_PATH_UNSAFE",
    "chrome://extensions",
    "CHATGPT_AUTHENTICATED_AND_IDLE",
    "THIS_IS_THE_ONLY_F1_EXPERIMENT_PROFILE",
    "PREPARE_USER_LEVEL_CHROME_NATIVE_HOST",
    "nativeMessagingPermission\":\"NOT_CHECKED\"",
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

assert 'JSON.stringify(p.optional_permissions)!==JSON.stringify(["nativeMessaging"])' in script
import json
extension_manifest = json.loads(manifest)
assert extension_manifest["permissions"] == ["storage"]
assert extension_manifest["optional_permissions"] == ["nativeMessaging"]
assert 'extension.permissions[0] !== "storage"' in policy
assert "NATIVE_HOST_EXTENSION_ORIGIN_MISMATCH" in policy
assert "CHATGPT_TARGET_COUNT_NOT_ONE" in policy
assert "PROFILE_PATH_UNSAFE" in policy
assert "MESSAGE_SEND_NOT_PROVEN_ABSENT" in policy
assert "SOURCE_SMOKE_PASS" in policy and "REAL_CHROME_READY" in policy
assert 'live_chrome_connection: "NOT_TESTED"' in policy
assert "linux_chrome_binary_for_launcher" in helper
assert "ps_line_matches_profile" in helper
assert "PROFILE_CHAIN_UNSAFE" in helper
assert "EXTENSION_MISSING_OR_DUPLICATE" in helper
assert "python3 tests/forge_f1_chrome_readiness_test.py" in workflow

# Exercise the real inline validator, including security-negative manifest cases.
validator = 'import {readFileSync} from "node:fs";' + script.split(
    'import {readFileSync} from "node:fs";', 1
)[1].split("\nNODE\n", 1)[0]
with tempfile.TemporaryDirectory() as temporary:
    fixture_path = Path(temporary) / "manifest.json"
    for mutate, should_pass in (
        (lambda m: None, True),
        (lambda m: m.update(permissions=["storage", "nativeMessaging"]), False),
        (lambda m: m.update(optional_permissions=[]), False),
        (lambda m: m.update(optional_permissions=["nativeMessaging", "debugger"]), False),
        (lambda m: m.update(host_permissions=["<all_urls>"]), False),
    ):
        candidate = json.loads(manifest)
        mutate(candidate)
        fixture_path.write_text(json.dumps(candidate), encoding="utf-8")
        result = subprocess.run(
            ["node", "--input-type=module", "-", str(fixture_path)],
            input=validator, text=True, capture_output=True,
        )
        assert (result.returncode == 0) == should_pass, (candidate, result.stderr)

for command in (
    ["bash", "-n", str(script_path)],
    ["node", "--check", str(policy_path)],
):
    result = subprocess.run(command, text=True, capture_output=True)
    assert result.returncode == 0, result.stderr

print("BKE FORGE F1 desktop readiness entrypoint contract: PASS")
