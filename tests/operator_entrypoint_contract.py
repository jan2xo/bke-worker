#!/usr/bin/env python3
from pathlib import Path

root = Path(__file__).resolve().parents[1]
canonical = (root / "BKE-WORKER-CANONICAL-PROJECT-EXECUTION-INSTRUCTIONS.md").read_text(encoding="utf-8")
template = (root / ".github/pull_request_template.md").read_text(encoding="utf-8")
doc = (root / "docs/operator-entrypoints.md").read_text(encoding="utf-8")
script = (root / "scripts/complete-github-app-actuator-preproduction.sh").read_text(encoding="utf-8")
actuator = (root / "docs/github-app-dispatch-actuator.md").read_text(encoding="utf-8")

for token in (
    "Operator action entrypoints",
    "one repo-tracked operator entrypoint script",
    "prompt **inside the script, at the point of need**",
    "without automating credentials",
    "docs/operator-entrypoints.md",
):
    assert token in canonical, token

for token in (
    "## Operator Action",
    "bash scripts/<intent-entrypoint>.sh",
    "Human-only inputs",
):
    assert token in template, token

template_words = " ".join(template.split())
assert (
    "prompts internally only for genuinely human-required input"
    in template_words
)

for token in (
    "Discovery before prompting",
    "Human-only interaction",
    "Fail-closed behavior",
    "discover -> authenticate if needed -> execute -> verify -> durable checkpoint",
):
    assert token in doc, token

for token in (
    'REPOSITORY="jan2xo/bke-worker"',
    'CLOUDFLARE_ENV="preproduction"',
    'gh auth login --hostname github.com --web',
    'wrangler login',
    'git merge --ff-only origin/main',
    'BKE_WORKER_GITHUB_APP_ID',
    'BKE_WORKER_GITHUB_APP_PRIVATE_KEY_PEM',
    'read -r -p "GitHub App ID: "',
    'read -r -p "GitHub App private-key PEM path: "',
    'assert_frozen_queue',
    'wrangler deploy --env "$CLOUDFLARE_ENV"',
    'gh workflow run "$WORKFLOW"',
    'BKE GitHub App installation token minted;',
    '{"reason": "NO_RUNNABLE_TASK", "state": "WAITING"}',
    'cmp -s "$before_heads" "$after_heads"',
    'cmp -s "$before_prs" "$after_prs"',
    'gh issue comment "$CERTIFICATION_ISSUE"',
    'Production: LOCKED',
):
    assert token in script, token

for forbidden in (
    "BKE_WORKER_GITHUB_APP_INSTALLATION_ID",
    "CLOUDFLARE_API_TOKEN=",
    "gh auth token",
    "cat $HOME/.bke-secrets",
    "production deploy",
):
    assert forbidden not in script, forbidden

assert "bash scripts/complete-github-app-actuator-preproduction.sh" in actuator

print("BKE Worker operator entrypoint contract: PASS")
