#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

WRANGLER_VERSION="4.147.0"
ENVIRONMENT="preproduction"
WORKER_ID="${BKE_WORKER_ID:-android-worker-a}"
SECRET_DIR="${BKE_WORKER_SECRET_DIR:-$HOME/.bke-secrets}"
SECRET_FILE="${BKE_WORKER_RELAY_SECRET_FILE:-$SECRET_DIR/bke-worker-cloudflare-preproduction.env}"

wrangler() {
  npx --yes "wrangler@${WRANGLER_VERSION}" "$@"
}

for command_name in npx node python3; do
  command -v "$command_name" >/dev/null 2>&1 || {
    echo "ERROR: $command_name is required." >&2
    exit 1
  }
done

if ! wrangler whoami >/dev/null 2>&1; then
  cat >&2 <<'EOF'
Cloudflare authentication is required before PREPRODUCTION creation.

Run:
  cd ~/bke-worker/cloudflare-relay
  npx --yes wrangler@4.147.0 login

Complete the Cloudflare browser authentication, then rerun:
  bash scripts/create-preproduction-worker.sh
EOF
  exit 3
fi

mkdir -p "$SECRET_DIR"
chmod 700 "$SECRET_DIR"

if [[ ! -f "$SECRET_FILE" ]]; then
  umask 077
  python3 - "$SECRET_FILE" <<'PY'
from pathlib import Path
import secrets
import sys

path = Path(sys.argv[1]).expanduser()
path.parent.mkdir(parents=True, exist_ok=True)
content = (
    "BKE_WORKER_GITHUB_WEBHOOK_SECRET="
    + secrets.token_urlsafe(48)
    + "\nBKE_WORKER_RELAY_TOKEN_KEY="
    + secrets.token_urlsafe(48)
    + "\n"
)
with path.open("x", encoding="utf-8") as handle:
    handle.write(content)
PY
fi
chmod 600 "$SECRET_FILE"

set -a
# shellcheck disable=SC1090
source "$SECRET_FILE"
set +a

if [[ "${#BKE_WORKER_GITHUB_WEBHOOK_SECRET}" -lt 32 ]]; then
  echo "ERROR: BKE_WORKER_GITHUB_WEBHOOK_SECRET is unexpectedly short." >&2
  exit 1
fi
if [[ "${#BKE_WORKER_RELAY_TOKEN_KEY}" -lt 32 ]]; then
  echo "ERROR: BKE_WORKER_RELAY_TOKEN_KEY is unexpectedly short." >&2
  exit 1
fi

BOOTSTRAP_CONFIG="$(mktemp "$ROOT_DIR/.wrangler-bootstrap.XXXXXX.toml")"
DEPLOY_LOG="$(mktemp "${TMPDIR:-/tmp}/bke-worker-relay-deploy.XXXXXX.log")"
cleanup() {
  rm -f "$BOOTSTRAP_CONFIG" "$DEPLOY_LOG"
}
trap cleanup EXIT

python3 - "$ROOT_DIR/wrangler.toml" "$BOOTSTRAP_CONFIG" <<'PY'
from pathlib import Path
import sys

source = Path(sys.argv[1]).read_text(encoding="utf-8").splitlines()
targets = {"[secrets]", "[env.preproduction.secrets]"}
output = []
skipping = False

for line in source:
    stripped = line.strip()
    if stripped in targets:
        skipping = True
        continue
    if skipping and stripped.startswith("["):
        skipping = False
    if not skipping:
        output.append(line)

Path(sys.argv[2]).write_text("\n".join(output) + "\n", encoding="utf-8")
PY

echo "Creating PREPRODUCTION Worker shell: bke-worker-relay-preproduction"
wrangler deploy   --env "$ENVIRONMENT"   --config "$BOOTSTRAP_CONFIG"

echo "Binding PREPRODUCTION webhook secret..."
printf '%s' "$BKE_WORKER_GITHUB_WEBHOOK_SECRET"   | wrangler secret put BKE_WORKER_GITHUB_WEBHOOK_SECRET       --env "$ENVIRONMENT"       --config "$BOOTSTRAP_CONFIG"       >/dev/null

echo "Binding PREPRODUCTION relay master key..."
printf '%s' "$BKE_WORKER_RELAY_TOKEN_KEY"   | wrangler secret put BKE_WORKER_RELAY_TOKEN_KEY       --env "$ENVIRONMENT"       --config "$BOOTSTRAP_CONFIG"       >/dev/null

echo "Deploying certified PREPRODUCTION configuration..."
if ! wrangler deploy --env "$ENVIRONMENT" 2>&1 | tee "$DEPLOY_LOG"; then
  echo "ERROR: final PREPRODUCTION deployment failed." >&2
  exit 1
fi

WORKER_URL="$(
  grep -Eo 'https://[^[:space:]]+\.workers\.dev' "$DEPLOY_LOG"     | tail -n 1     || true
)"

DERIVED_TOKEN="$(
  BKE_WORKER_RELAY_TOKEN_KEY="$BKE_WORKER_RELAY_TOKEN_KEY"     node scripts/derive-worker-token.mjs "$WORKER_ID"
)"

echo
echo "BKE Worker PREPRODUCTION Cloudflare relay: CREATED"
echo "Worker ID: $WORKER_ID"
echo "Local secret file: $SECRET_FILE"

if [[ -n "$WORKER_URL" ]]; then
  echo "HTTPS webhook endpoint: $WORKER_URL/webhooks/github"
  echo "Android relay URL: ${WORKER_URL/https:\/\//wss:\/\/}/relay/$WORKER_ID"
else
  echo "Worker URL: inspect the final Wrangler deployment output above."
fi

echo "Android runtime token (worker-bound; NOT the master key):"
printf '%s\n' "$DERIVED_TOKEN"

if [[ -n "$WORKER_URL" ]]; then
  echo
  BKE_WORKER_CLOUDFLARE_WEBHOOK_URL="$WORKER_URL/webhooks/github"     bash scripts/configure-github-webhook.sh
fi

echo
echo "GitHub webhook mutation was NOT performed."
echo "Production remains LOCKED."
