#!/usr/bin/env bash
set -euo pipefail

WORKER_ID="${BKE_WORKER_ID:-}"
CDP_ENDPOINT="${BKE_WORKER_BROWSER_CDP_ENDPOINT:-}"

if [[ -z "$WORKER_ID" ]]; then
  echo "ERROR: BKE_WORKER_ID is required." >&2
  exit 1
fi
if [[ ! "$WORKER_ID" =~ ^[a-z0-9][a-z0-9-]{0,62}$ ]]; then
  echo "ERROR: BKE_WORKER_ID must match [a-z0-9][a-z0-9-]{0,62}" >&2
  exit 1
fi
if [[ -z "$CDP_ENDPOINT" ]]; then
  echo "ERROR: BKE_WORKER_BROWSER_CDP_ENDPOINT is required per worker." >&2
  exit 1
fi

PROFILE_DIR="${BKE_WORKER_CHATGPT_PROFILE:-$HOME/snap/chromium/common/bke-worker-$WORKER_ID-chatgpt-profile}"

read -r CDP_HOST CDP_PORT < <(
  python3 - "$CDP_ENDPOINT" <<'PY'
import sys
from urllib.parse import urlparse

uri = urlparse(sys.argv[1])
if uri.scheme != "http":
    raise SystemExit("ERROR: Chromium CDP endpoint must use http")
if uri.hostname not in {"127.0.0.1", "localhost", "::1"}:
    raise SystemExit("ERROR: Chromium CDP endpoint must be loopback-only")
if uri.port is None:
    raise SystemExit("ERROR: Chromium CDP endpoint must include an explicit port")
print("127.0.0.1", uri.port)
PY
)

if ! command -v chromium >/dev/null 2>&1; then
  echo "ERROR: system Chromium is not installed. Run bash scripts/bootstrap-linux-host.sh first." >&2
  exit 1
fi

mkdir -p "$PROFILE_DIR"
chmod 700 "$PROFILE_DIR"

if curl --fail --silent "$CDP_ENDPOINT/json/version" >/dev/null 2>&1; then
  echo "ERROR: CDP endpoint $CDP_ENDPOINT is already active; do not share it across workers." >&2
  exit 1
fi

if command -v ss >/dev/null 2>&1 &&
   ss -ltnH | awk '{print $4}' | grep -Eq "(^|:)${CDP_PORT}$"; then
  echo "ERROR: port $CDP_PORT is already in use." >&2
  exit 1
fi

cat <<EOF
BKE Worker browser guardrail
  worker:  $WORKER_ID
  profile: $PROFILE_DIR
  CDP:     $CDP_ENDPOINT (loopback only)

Authentication is HUMAN-ONLY.
If ChatGPT requests OAuth, MFA, CAPTCHA, or another security challenge, complete it manually in this GUI browser.
BKE Worker must never automate or bypass authentication.
EOF

exec chromium   --user-data-dir="$PROFILE_DIR"   --remote-debugging-address="$CDP_HOST"   --remote-debugging-port="$CDP_PORT"   https://chatgpt.com
