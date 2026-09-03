#!/usr/bin/env bash
set -euo pipefail

TUNNEL_NAME="${BKE_WORKER_TUNNEL_NAME:-bke-worker-utm}"
HOSTNAME="${BKE_WORKER_TUNNEL_HOSTNAME:-worker.jl-bke.com}"
ORIGIN="${BKE_WORKER_TUNNEL_ORIGIN:-http://127.0.0.1:5080}"
CF_DIR="${BKE_WORKER_CLOUDFLARED_DIR:-$HOME/.cloudflared}"
CONFIG_FILE="${BKE_WORKER_CLOUDFLARED_CONFIG:-$CF_DIR/bke-worker-webhook.yml}"
CERT_FILE="$CF_DIR/cert.pem"

command -v cloudflared >/dev/null 2>&1 || {
  echo "ERROR: cloudflared is not installed." >&2
  echo "Run: bash scripts/install-cloudflared-ubuntu.sh" >&2
  exit 1
}

command -v python3 >/dev/null 2>&1 || {
  echo "ERROR: python3 is required to resolve the tunnel UUID." >&2
  exit 1
}

mkdir -p "$CF_DIR"
chmod 700 "$CF_DIR"

if [[ ! -f "$CERT_FILE" ]]; then
  echo "HUMAN AUTH REQUIRED"
  echo "Run this once in the UTM GUI session:"
  echo "  cloudflared tunnel login"
  echo
  echo "Complete the Cloudflare browser authorization for jl-bke.com, then rerun this script."
  echo "BKE Worker does not automate Cloudflare login/MFA/security challenges."
  exit 2
fi

resolve_tunnel_id() {
  cloudflared tunnel list --output json \
    | python3 -c 'import json,sys; name=sys.argv[1]; rows=json.load(sys.stdin); matches=[str(row.get("id", "")) for row in rows if row.get("name") == name and not row.get("deleted_at")]; print(matches[0] if matches else "")' "$TUNNEL_NAME"
}

TUNNEL_ID="$(resolve_tunnel_id)"
if [[ -z "$TUNNEL_ID" ]]; then
  echo "Creating locally-managed Cloudflare Tunnel: $TUNNEL_NAME"
  cloudflared tunnel create "$TUNNEL_NAME"
  TUNNEL_ID="$(resolve_tunnel_id)"
fi

if [[ -z "$TUNNEL_ID" ]]; then
  echo "ERROR: could not resolve tunnel UUID for $TUNNEL_NAME after creation." >&2
  exit 1
fi

CREDENTIALS_FILE="$CF_DIR/$TUNNEL_ID.json"
if [[ ! -f "$CREDENTIALS_FILE" ]]; then
  echo "ERROR: tunnel credentials file not found: $CREDENTIALS_FILE" >&2
  exit 1
fi

cat > "$CONFIG_FILE" <<EOF
# BKE Worker Phase 6B — webhook-only public ingress.
# DO NOT route /control, /health, operator UI, or Chromium CDP through this tunnel.
tunnel: $TUNNEL_ID
credentials-file: $CREDENTIALS_FILE

ingress:
  - hostname: $HOSTNAME
    path: ^/webhooks/github$
    service: $ORIGIN
  - service: http_status:404
EOF
chmod 600 "$CONFIG_FILE"

echo "Validating webhook-only ingress..."
cloudflared tunnel --config "$CONFIG_FILE" ingress validate

echo "Checking exact webhook route..."
cloudflared tunnel --config "$CONFIG_FILE" ingress rule "https://$HOSTNAME/webhooks/github"

echo "Checking private control route falls through to 404..."
PRIVATE_RULE="$(cloudflared tunnel --config "$CONFIG_FILE" ingress rule "https://$HOSTNAME/control/state")"
printf '%s\n' "$PRIVATE_RULE"
printf '%s\n' "$PRIVATE_RULE" | grep -q 'http_status:404' || {
  echo "ERROR: /control/state did not resolve to the 404 catch-all." >&2
  exit 1
}

echo "Routing DNS hostname to the tunnel..."
cloudflared tunnel route dns --overwrite-dns "$TUNNEL_ID" "$HOSTNAME"

echo
printf '%s\n' \
  "CLOUDFLARE WEBHOOK TUNNEL CONFIGURED" \
  "tunnel: $TUNNEL_NAME" \
  "uuid: $TUNNEL_ID" \
  "public: https://$HOSTNAME/webhooks/github" \
  "origin: $ORIGIN" \
  "config: $CONFIG_FILE" \
  "guard: every unmatched public path returns Cloudflare Tunnel 404" \
  "guard: Chromium CDP 127.0.0.1:9222 is NOT exposed"

echo
echo "Next: bash scripts/run-cloudflare-webhook-tunnel.sh"
