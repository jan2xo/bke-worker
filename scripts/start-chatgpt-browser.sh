#!/usr/bin/env bash
set -euo pipefail

PROFILE_DIR="${BKE_WORKER_CHATGPT_PROFILE:-$HOME/snap/chromium/common/bke-worker-chatgpt-profile}"
CDP_HOST="127.0.0.1"
CDP_PORT="${BKE_WORKER_BROWSER_CDP_PORT:-9222}"
CDP_ENDPOINT="http://${CDP_HOST}:${CDP_PORT}"

if ! command -v chromium >/dev/null 2>&1; then
  echo "ERROR: system Chromium is not installed. Run bash scripts/bootstrap-linux-host.sh first." >&2
  exit 1
fi

mkdir -p "$PROFILE_DIR"
chmod 700 "$PROFILE_DIR"

if curl --fail --silent "$CDP_ENDPOINT/json/version" >/dev/null 2>&1; then
  echo "System Chromium CDP is already available at $CDP_ENDPOINT"
  exit 0
fi

if command -v ss >/dev/null 2>&1 && ss -ltnH | awk '{print $4}' | grep -Eq "(^|:)${CDP_PORT}$"; then
  echo "ERROR: port $CDP_PORT is already in use but does not expose Chromium CDP." >&2
  exit 1
fi

cat <<EOF
BKE Worker browser guardrail
  profile: $PROFILE_DIR
  CDP:     $CDP_ENDPOINT (loopback only)

Authentication is HUMAN-ONLY.
If ChatGPT requests OAuth, MFA, CAPTCHA, or another security challenge, complete it manually in this GUI browser.
BKE Worker must never automate or bypass authentication.
EOF

exec chromium \
  --user-data-dir="$PROFILE_DIR" \
  --remote-debugging-address="$CDP_HOST" \
  --remote-debugging-port="$CDP_PORT" \
  https://chatgpt.com
