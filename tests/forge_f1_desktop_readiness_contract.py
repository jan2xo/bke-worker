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
    "nativeMessagingPermission\":None",
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

# Check optional permission only; the F1-01 script cannot measure the
# separate human runtime grant, and must never claim one is absent.
import json
manifest_contract=json.loads(manifest)
assert manifest_contract["permissions"]==["storage"]
assert manifest_contract["optional_permissions"]==["nativeMessaging"]
assert "permissions.request" not in script
assert 'extension.permissions[0] !== "storage"' in policy
assert "NATIVE_HOST_EXTENSION_ORIGIN_MISMATCH" in policy
assert "CHATGPT_TARGET_COUNT_NOT_ONE" in policy
assert "PROFILE_PATH_UNSAFE" in policy
assert "MESSAGE_SEND_NOT_PROVEN_ABSENT" in policy
assert "SOURCE_SMOKE_PASS" in policy and "REAL_CHROME_READY" in policy
assert "NOT_TESTED_OPTIONAL_NATIVE_PERMISSION_UNVERIFIED" in policy
assert "linux_chrome_binary_for_launcher" in helper
assert "ps_line_matches_profile" in helper
assert "PROFILE_CHAIN_UNSAFE" in helper
assert "EXTENSION_MISSING_OR_DUPLICATE" in helper
# An imported module plus unconditional PASS is not a valid security test.
# Require the isolated executable suite AND the independent injected-failure
# subprocess contract, in the same required PR-Guard job.
assert "python3 -I tests/forge_f1_chrome_readiness_test.py" in workflow
assert "python3 -I tests/forge_f1_process_test_harness_contract.py" in workflow
harness_contract = (root / "tests/forge_f1_process_test_harness_contract.py").read_text(encoding="utf-8")
assert "test_all_twenty_cases_run_with_named_darwin_cases" in harness_contract
assert "test_injected_assertion_must_fail_ci_and_never_print_pass" in harness_contract

for command in (
    ["bash", "-n", str(script_path)],
    ["node", "--check", str(policy_path)],
):
    result = subprocess.run(command, text=True, capture_output=True)
    assert result.returncode == 0, result.stderr

print("BKE FORGE F1 desktop readiness entrypoint contract: PASS")
