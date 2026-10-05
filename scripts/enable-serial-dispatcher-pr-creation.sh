#!/usr/bin/env bash
set -euo pipefail

REPOSITORY="${BKE_WORKER_REPOSITORY:-jan2xo/bke-worker}"
API_VERSION="2022-11-28"

if [[ "$REPOSITORY" != "jan2xo/bke-worker" ]]; then
  echo "Refusing unexpected repository: $REPOSITORY" >&2
  exit 2
fi

if ! command -v gh >/dev/null 2>&1; then
  echo "GitHub CLI (gh) is required." >&2
  exit 2
fi

# Authentication, SSO, MFA, and security challenges remain human-owned.
gh auth status --hostname github.com >/dev/null

permission_path="/repos/$REPOSITORY/actions/permissions/workflow"
current_json="$(
  gh api     -H "Accept: application/vnd.github+json"     -H "X-GitHub-Api-Version: $API_VERSION"     "$permission_path"
)"

read -r current_default current_allow < <(
  CURRENT_JSON="$current_json" python3 - <<'PY'
import json
import os

payload = json.loads(os.environ["CURRENT_JSON"])
default = payload.get("default_workflow_permissions")
allowed = payload.get("can_approve_pull_request_reviews")
if default not in {"read", "write"} or not isinstance(allowed, bool):
    raise SystemExit("Unexpected GitHub workflow-permission payload")
print(default, "true" if allowed else "false")
PY
)

if [[ "$current_allow" == "true" ]]; then
  echo "BKE serial dispatcher PR-creation permission already enabled for $REPOSITORY"
  exit 0
fi

echo "Enabling GitHub Actions PR creation for $REPOSITORY using the current human-authenticated gh session."
echo "Preserving default_workflow_permissions=$current_default"

gh api   --method PUT   -H "Accept: application/vnd.github+json"   -H "X-GitHub-Api-Version: $API_VERSION"   "$permission_path"   -f "default_workflow_permissions=$current_default"   -F "can_approve_pull_request_reviews=true"   >/dev/null

verified="$(
  gh api     -H "Accept: application/vnd.github+json"     -H "X-GitHub-Api-Version: $API_VERSION"     "$permission_path"     --jq '.can_approve_pull_request_reviews'
)"

if [[ "$verified" != "true" ]]; then
  echo "GitHub did not report PR-creation permission enabled; refusing to continue." >&2
  exit 3
fi

echo "BKE serial dispatcher PR-creation permission: ENABLED for $REPOSITORY"
