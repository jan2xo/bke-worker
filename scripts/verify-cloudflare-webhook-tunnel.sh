#!/usr/bin/env bash
set -euo pipefail

HOSTNAME="${BKE_WORKER_TUNNEL_HOSTNAME:-worker.jl-bke.com}"
BASE="https://$HOSTNAME"

status_for() {
  local method=$1
  local url=$2
  curl --silent --show-error --output /dev/null --write-out '%{http_code}' -X "$method" "$url"
}

echo "Verifying public Cloudflare surface: $HOSTNAME"

WEBHOOK_STATUS="$(status_for POST "$BASE/webhooks/github")"
CONTROL_STATUS="$(status_for GET "$BASE/control/state")"
HEALTH_STATUS="$(status_for GET "$BASE/health/live")"
ROOT_STATUS="$(status_for GET "$BASE/")"

printf '%-32s %s\n' "/webhooks/github (POST)" "$WEBHOOK_STATUS"
printf '%-32s %s\n' "/control/state (GET)" "$CONTROL_STATUS"
printf '%-32s %s\n' "/health/live (GET)" "$HEALTH_STATUS"
printf '%-32s %s\n' "/ (GET)" "$ROOT_STATUS"

# A signature-less, non-push request reaches the BKE Worker webhook endpoint and is
# intentionally ignored with 202. Every other public path must die at the tunnel.
[[ "$WEBHOOK_STATUS" == "202" ]] || {
  echo "ERROR: webhook path did not reach BKE Worker (expected HTTP 202 for ignored unsigned/non-push probe)." >&2
  exit 1
}

for status in "$CONTROL_STATUS" "$HEALTH_STATUS" "$ROOT_STATUS"; do
  [[ "$status" == "404" ]] || {
    echo "ERROR: a private BKE Worker route escaped the Cloudflare 404 catch-all." >&2
    exit 1
  }
done

echo "CLOUDFLARE WEBHOOK SURFACE GREEN"
echo "public: POST $BASE/webhooks/github"
echo "private: operator/control/health/CDP remain unexposed"
