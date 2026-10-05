#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

WRANGLER_VERSION="4.147.0"
ENVIRONMENT="preproduction"
REPOSITORY="jan2xo/bke-worker"
APP_ID="${BKE_WORKER_GITHUB_APP_ID:-}"
INSTALLATION_ID="${BKE_WORKER_GITHUB_APP_INSTALLATION_ID:-}"
PRIVATE_KEY_FILE="${BKE_WORKER_GITHUB_APP_PRIVATE_KEY_FILE:-}"
BROKER_URL="${BKE_WORKER_GITHUB_APP_BROKER_URL:-}"

wrangler() {
  npx --yes "wrangler@${WRANGLER_VERSION}" "$@"
}

cat <<'EOF'
BKE WORKER GITHUB APP ACTUATOR — PREPRODUCTION

Required GitHub App repository permissions:
  Metadata: read
  Contents: read & write
  Issues: read & write
  Pull requests: read & write

No Administration, Secrets, Organization, or production permission is required.

This script never prints the GitHub App private key.
EOF

if [[ "${1:-}" != "--apply" ]]; then
  cat <<'EOF'

PLAN ONLY — NO MUTATION

To apply after the owner has granted the permissions above and generated a
GitHub App private key:

  export BKE_WORKER_GITHUB_APP_ID='<app id>'
  export BKE_WORKER_GITHUB_APP_INSTALLATION_ID='<installation id>'
  export BKE_WORKER_GITHUB_APP_PRIVATE_KEY_FILE='<path to downloaded PEM>'
  export BKE_WORKER_GITHUB_APP_BROKER_URL='https://<preproduction-worker>.workers.dev'

  bash scripts/configure-github-app-actuator.sh --apply
EOF
  exit 0
fi

for command_name in npx gh; do
  command -v "$command_name" >/dev/null 2>&1 || {
    echo "ERROR: $command_name is required." >&2
    exit 2
  }
done

if [[ ! "$APP_ID" =~ ^[0-9]+$ ]]; then
  echo "ERROR: BKE_WORKER_GITHUB_APP_ID must be numeric." >&2
  exit 2
fi
if [[ ! "$INSTALLATION_ID" =~ ^[0-9]+$ ]]; then
  echo "ERROR: BKE_WORKER_GITHUB_APP_INSTALLATION_ID must be numeric." >&2
  exit 2
fi
if [[ -z "$PRIVATE_KEY_FILE" || ! -f "$PRIVATE_KEY_FILE" ]]; then
  echo "ERROR: BKE_WORKER_GITHUB_APP_PRIVATE_KEY_FILE must point to the GitHub App PEM." >&2
  exit 2
fi
if [[ ! "$BROKER_URL" =~ ^https://[^/]+$ ]]; then
  echo "ERROR: BKE_WORKER_GITHUB_APP_BROKER_URL must be the HTTPS Worker origin only." >&2
  exit 2
fi

gh auth status --hostname github.com >/dev/null
if ! wrangler whoami >/dev/null 2>&1; then
  echo "ERROR: human Cloudflare authentication is required." >&2
  exit 3
fi

echo "Binding GitHub App identity to Cloudflare PREPRODUCTION..."
printf '%s' "$APP_ID"   | wrangler secret put BKE_WORKER_GITHUB_APP_ID --env "$ENVIRONMENT" >/dev/null
printf '%s' "$INSTALLATION_ID"   | wrangler secret put BKE_WORKER_GITHUB_APP_INSTALLATION_ID --env "$ENVIRONMENT" >/dev/null
cat "$PRIVATE_KEY_FILE"   | wrangler secret put BKE_WORKER_GITHUB_APP_PRIVATE_KEY_PEM --env "$ENVIRONMENT" >/dev/null

echo "Deploying PREPRODUCTION relay + GitHub App broker..."
wrangler deploy --env "$ENVIRONMENT"

echo "Setting non-secret GitHub repository broker URL variable..."
gh variable set BKE_WORKER_GITHUB_APP_BROKER_URL   --repo "$REPOSITORY"   --body "$BROKER_URL"

echo
echo "BKE GitHub App actuator bootstrap: CONFIGURED"
echo "Repository: $REPOSITORY"
echo "Broker URL: $BROKER_URL/github/app/install-token"
echo "Private key: stored only as Cloudflare encrypted secret binding"
echo
echo "Next proof: manually dispatch Serial Master Queue Dispatcher while the queue is frozen."
echo "Expected state: WAITING / NO_RUNNABLE_TASK with a successfully minted App token."
echo "Production remains LOCKED."
