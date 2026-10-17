#!/usr/bin/env python3
"""Cheap safety contract for the *operator* entrypoint, not live Android proof."""
from pathlib import Path
import subprocess

root = Path(__file__).resolve().parents[1]
script_path = root / "scripts/certify-android-continuation-preproduction.sh"
s = script_path.read_text(encoding="utf-8")
subprocess.run(["bash", "-n", str(script_path)], check=True)

required = (
    'REPO="jan2xo/bke-worker"',
    'WORKER="android-worker-a"',
    'LABEL="bke-worker:android-worker-a"',
    'MARKER="BKE ANDROID CONTINUATION CERTIFICATION"',
    'git fetch origin main',
    'gh api "repos/$REPO/commits/main"',
    'git worktree add --detach',
    'BKE_CONTINUATION_TRUSTED_MAIN=1',
    'gh auth login --hostname github.com --web',
    'is:pr is:open label:$LABEL',
    'CERTIFICATION_TARGET_AMBIGUOUS',
    'CERTIFICATION_PR_ALREADY_OWNED',
    'android-single-worker-continuation-acceptance.md',
    'gh pr view "$number" --repo "$REPO" --json files',
    '[[ -t 0 ]]',
    'BROWSER: ATTACHED',
    'CHAT: READY',
    'RELAY: CONNECTED',
    'ARM-android-worker-a',
    'gh issue comment "$number"',
    'BKE EXECUTION CHECKPOINT — OWNER_DEVICE_PREFLIGHT',
    'gh pr edit "$number" --repo "$REPO" --add-label "$LABEL"',
    '.total_count == 1',
    'post-label worker ownership ambiguous',
    'ARMED / NOT CERTIFIED',
    'Production locked',
)
for token in required:
    assert token in s, "Missing fail-closed operator boundary: " + token

assert s.count('gh pr edit "$number"') == 1
assert s.index('ARM-android-worker-a') < s.index('gh issue comment "$number"')
assert s.index('gh issue comment "$number"') < s.index('gh pr edit "$number"')
assert s.index('gh pr edit "$number"') < s.index('.total_count == 1')
for forbidden in (
    'adb uninstall', 'adb install', 'wrangler deploy', 'gh workflow run',
    'gh pr merge', 'gh issue create', 'gh pr create',
    'gh auth token', 'gh secret', 'gh variable set', 'gh release create',
    'production deploy', 'BKE_ANDROID_PREPRODUCTION_KEYSTORE_B64',
):
    assert forbidden not in s, "Unexpected mutation or credential boundary: " + forbidden

print("BKE Android continuation owner entrypoint safety contract: PASS")
