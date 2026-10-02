#!/usr/bin/env bash
set -euo pipefail

ORIGIN="${BKE_WORKER_TUNNEL_ORIGIN:-http://127.0.0.1:5080}"
CF_DIR="${BKE_WORKER_CLOUDFLARED_DIR:-$HOME/.cloudflared}"
CONFIG_FILE="${BKE_WORKER_CLOUDFLARED_CONFIG:-$CF_DIR/bke-worker-webhook.yml}"

command -v cloudflared >/dev/null 2>&1 || {
  echo "ERROR: cloudflared is not installed." >&2
  exit 1
}

if [[ ! -f "$CONFIG_FILE" ]]; then
  echo "ERROR: Cloudflare Tunnel config not found: $CONFIG_FILE" >&2
  echo "Run: bash scripts/setup-cloudflare-webhook-tunnel.sh" >&2
  exit 1
fi

BASE_ORIGIN="${ORIGIN%/}"
echo "Checking local BKE Worker before opening tunnel..."
curl --fail --silent --show-error "$BASE_ORIGIN/health/live" >/dev/null || {
  echo "ERROR: BKE Worker is not reachable at $BASE_ORIGIN" >&2
  echo "Start Chromium first, then run BKE Worker in another terminal:" >&2
  echo "  bash scripts/start-chatgpt-browser.sh" >&2
  echo "  bash scripts/run-worker.sh" >&2
  exit 1
}

cloudflared tunnel --config "$CONFIG_FILE" ingress validate

echo "Starting webhook-only Cloudflare Tunnel."
echo "PUBLIC: /webhooks/github only"
echo "PRIVATE: /control/* /health/* / operator UI"
echo "PRIVATE: Chromium CDP 127.0.0.1:9222"

echo
exec cloudflared tunnel --config "$CONFIG_FILE" run
