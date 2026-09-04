#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ENV_FILE="${BKE_WORKER_ENV_FILE:-$HOME/.config/bke-worker/bke-worker.env}"

if [[ ! -f "$ENV_FILE" ]]; then
  echo "ERROR: missing environment file: $ENV_FILE" >&2
  echo "Run bash scripts/bootstrap-linux-host.sh, then configure the generated file." >&2
  exit 1
fi

chmod 600 "$ENV_FILE"
set -a
# shellcheck disable=SC1090
source "$ENV_FILE"
set +a

export BKE_WORKER_BROWSER_CDP_ENDPOINT="${BKE_WORKER_BROWSER_CDP_ENDPOINT:-http://127.0.0.1:9222}"
export BKE_WORKER_CHATGPT_BASE_URL="${BKE_WORKER_CHATGPT_BASE_URL:-https://chatgpt.com/}"
export BKE_WORKER_CHATGPT_PROFILE="${BKE_WORKER_CHATGPT_PROFILE:-$HOME/snap/chromium/common/bke-worker-chatgpt-profile}"
export BKE_WORKER_STATE_FILE="${BKE_WORKER_STATE_FILE:-$HOME/.local/share/bke-worker/state/notion-watchdog.json}"
export BKE_WORKER_WATCHDOG_SECONDS="${BKE_WORKER_WATCHDOG_SECONDS:-2}"
export BKE_WORKER_IDLE_RETRY_SECONDS="${BKE_WORKER_IDLE_RETRY_SECONDS:-5}"
export BKE_WORKER_HEADLESS=false
export ASPNETCORE_URLS="${ASPNETCORE_URLS:-http://127.0.0.1:5080}"

mkdir -p "$(dirname "$BKE_WORKER_STATE_FILE")"
chmod 700 "$(dirname "$BKE_WORKER_STATE_FILE")"

required=(
  BKE_WORKER_NOTION_TOKEN
  BKE_WORKER_NOTION_PAGE
  BKE_WORKER_CHATGPT_OVERRIDE_URL
)

for name in "${required[@]}"; do
  if [[ -z "${!name:-}" || "${!name}" == "REPLACE_ME" ]]; then
    echo "ERROR: required setting is missing: $name" >&2
    exit 1
  fi
done

python3 - "$BKE_WORKER_CHATGPT_OVERRIDE_URL" <<'PY'
import sys
from urllib.parse import urlparse

value = sys.argv[1]
uri = urlparse(value)
segments = [segment for segment in uri.path.split('/') if segment]
valid = (
    uri.scheme == 'https'
    and uri.hostname in {'chatgpt.com', 'www.chatgpt.com'}
    and any(segments[i].lower() == 'c' and i + 1 < len(segments) and segments[i + 1]
            for i in range(len(segments)))
)
if not valid:
    raise SystemExit('ERROR: BKE_WORKER_CHATGPT_OVERRIDE_URL must be an HTTPS chatgpt.com conversation URL containing /c/<conversation-id>.')
PY

cd "$ROOT_DIR"
bash scripts/verify-live-host.sh

echo "Starting BKE Worker — Notion checkbox watchdog."
echo "listen: $ASPNETCORE_URLS (loopback only)"
echo "task authority: one Notion control page"
echo "task identity: exact Notion to_do block ID"
echo "instruction authority: same-page Notion tables with KEY | NAME | INSTRUCTION"
echo "chat target: deterministic configured conversation URL"
echo "watchdog: ${BKE_WORKER_WATCHDOG_SECONDS}s"
echo "idle retry: ${BKE_WORKER_IDLE_RETRY_SECONDS}s"
echo "guard: unchecked + ChatGPT busy = wait"
echo "guard: unchecked + ChatGPT idle = continue current TODO"
echo "guard: checked = next unchecked TODO"
echo "guard: no unchecked TODO = COMPLETE"
echo "GitHub webhook is NOT orchestration authority on this branch."

if [[ -n "${BKE_WORKER_SERVER_DLL:-}" ]]; then
  if [[ ! -f "$BKE_WORKER_SERVER_DLL" ]]; then
    echo "ERROR: BKE_WORKER_SERVER_DLL does not exist: $BKE_WORKER_SERVER_DLL" >&2
    exit 1
  fi
  exec dotnet "$BKE_WORKER_SERVER_DLL"
fi

dotnet build src/BKE.Worker.Server/BKE.Worker.Server.csproj -c Release >/dev/null
exec dotnet run \
  --project src/BKE.Worker.Server/BKE.Worker.Server.csproj \
  -c Release \
  --no-build
