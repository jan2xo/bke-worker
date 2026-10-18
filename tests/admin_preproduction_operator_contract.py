#!/usr/bin/env python3
"""Source and operator guard: PREPRODUCTION only, never proof of a live login."""
from pathlib import Path
import subprocess

root = Path(__file__).resolve().parents[1]
shell = (root / "scripts/activate-admin-preproduction.sh").read_text()
node = (root / "scripts/admin_preproduction_activation.mjs").read_text()
subprocess.run(["bash", "-n", str(root / "scripts/activate-admin-preproduction.sh")], check=True)
subprocess.run(["node", "--check", str(root / "scripts/admin_preproduction_activation.mjs")], check=True)

required_shell = (
    'REPO="jan2xo/bke-worker"',
    'COMMAND_REPO="jan2xo/bke-command-center"',
    "git -C \"$ENTRY_DIR\" fetch origin main",
    "gh api \"repos/$REPO/commits/main\"",
    "git -C \"$ENTRY_DIR\" worktree add --detach --quiet",
    "gh repo clone \"$COMMAND_REPO\"",
    "gh auth login --hostname github.com --web",
    "git -C \"$ROOT_TMP/command-center\" status --porcelain",
    'node "$WORKTREE/scripts/admin_preproduction_activation.mjs"',
)
for fragment in required_shell:
    assert fragment in shell, "Missing operator trust anchor: " + fragment

required_node = (
    '"bke-worker-relay-preproduction"',
    '"bke-command-center-preproduction"',
    '"https://" + HOST + "/admin"',
    '"ACCESS_ANONYMOUS_NOT_DENIED"',
    '"ACCESS_POLICY_NOT_OPERATOR_ONLY"',
    '"ACCESS_APPLICATION_NOT_VISIBLE"',
    '"ACCESS_APPLICATION_DETAIL_MISMATCH"',
    '"&exact=true&per_page=100&page=1"',
    '"ADMIN_ACTIVATION_ALREADY_OR_PARTIALLY_CONFIGURED"',
    '"BKE_ADMIN_BROKER_ENABLED"',
    '"BKE_ADMIN_REPO_CATALOG_ENABLED"',
    '"BKE_ADMIN_DISCOVERY_ENABLED"',
    '"GITHUB_DISCOVERY_AUTH_MODE"',
    '"catalog"',
    '["deploy", "--env", "preproduction"]',
    '["secret", "put", key, "--env", "preproduction"]',
    '["auth", "token", "--json"]',
    '"OWNER_ACCESS_LOGIN_REQUIRED"',
    "await denyAnonymous(ADMIN_URL, snapshot.access.issuer)",
    "await verifyBoundRpc(token, snapshot.accountId)",
    'checkpoint("BLOCKED_AFTER_MUTATION_" + phase',
)
for fragment in required_node:
    assert fragment in node, "Missing activation boundary: " + fragment
assert node.index('secretPut("BKE_ADMIN_DISCOVERY_ENABLED"') > node.index(
    'secretPut("GITHUB_DISCOVERY_AUTH_MODE"')
assert node.index("await denyAnonymous(ADMIN_URL, snapshot.access.issuer)") < node.index('wrangler(["deploy"')
for forbidden in (
    "gh secret set",
    "wrangler deploy --env production",
    '"--env", "production"',
    "adb install", "adb uninstall",
    "gh pr edit", "gh pr merge",
    "CLOUDFLARE_API_TOKEN=",
    "BKE_WORKER_GITHUB_APP_PRIVATE_KEY_PEM =",
):
    assert forbidden not in shell + node, "Unapproved mutation/secret risk: " + forbidden
print("BKE Admin PREPRODUCTION operator safety contract: PASS")
