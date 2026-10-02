#!/usr/bin/env bash
set -euo pipefail

CDP_ENDPOINT="${BKE_WORKER_BROWSER_CDP_ENDPOINT:-http://127.0.0.1:9222}"
PROFILE_DIR="${BKE_WORKER_CHATGPT_PROFILE:-$HOME/snap/chromium/common/bke-worker-chatgpt-profile}"

for command in curl jq dotnet chromium; do
  if ! command -v "$command" >/dev/null 2>&1; then
    echo "ERROR: required command missing: $command" >&2
    exit 1
  fi
done

python3 - "$CDP_ENDPOINT" <<'PY'
import sys
from urllib.parse import urlparse

uri = urlparse(sys.argv[1])
if uri.scheme not in {"http", "https"}:
    raise SystemExit("ERROR: CDP endpoint must be HTTP(S)")
if uri.hostname not in {"127.0.0.1", "localhost", "::1"}:
    raise SystemExit("ERROR: CDP endpoint must be loopback-only")
PY

if [[ ! -d "$PROFILE_DIR" ]]; then
  echo "ERROR: browser profile directory is missing: $PROFILE_DIR" >&2
  exit 1
fi

version_json="$(curl --fail --silent "$CDP_ENDPOINT/json/version")" || {
  echo "ERROR: Chromium CDP is unavailable at $CDP_ENDPOINT" >&2
  exit 1
}

echo "$version_json" | jq -e '.Browser and .["Protocol-Version"] and .webSocketDebuggerUrl' >/dev/null

echo "$version_json" | jq -e -r '.webSocketDebuggerUrl' | grep -Eq '^ws://(127\.0\.0\.1|localhost|\[::1\])(:|/)' || {
  echo "ERROR: Chromium advertised a non-loopback debugger WebSocket." >&2
  exit 1
}

if command -v ss >/dev/null 2>&1; then
  port="$(python3 - "$CDP_ENDPOINT" <<'PY'
import sys
from urllib.parse import urlparse
u=urlparse(sys.argv[1])
print(u.port or (443 if u.scheme == 'https' else 80))
PY
)"
  listeners="$(ss -ltnH | awk -v port=":$port" '$4 ~ port"$" {print $4}')"
  if [[ -n "$listeners" ]] && echo "$listeners" | grep -Evq '^(127\.0\.0\.1|\[::1\]|localhost):'; then
    echo "ERROR: CDP port $port is listening on a non-loopback interface:" >&2
    echo "$listeners" >&2
    exit 1
  fi
fi

pages_json="$(curl --fail --silent "$CDP_ENDPOINT/json/list")"
if ! echo "$pages_json" | jq -e 'map(select((.url // "") | startswith("https://chatgpt.com"))) | length > 0' >/dev/null; then
  echo "ERROR: Chromium is reachable but no chatgpt.com tab is open." >&2
  exit 1
fi

printf 'LIVE HOST GREEN\n'
printf '  browser: %s\n' "$(echo "$version_json" | jq -r '.Browser')"
printf '  protocol: %s\n' "$(echo "$version_json" | jq -r '.["Protocol-Version"]')"
printf '  CDP: %s\n' "$CDP_ENDPOINT"
printf '  profile: %s\n' "$PROFILE_DIR"
printf '  guard: loopback-only CDP verified\n'
printf '  auth: human-owned; worker probe remains authoritative\n'
