#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ENV_FILE="${BKE_WORKER_ENV_FILE:-$HOME/.config/bke-worker/bke-worker.env}"

if [[ $# -ne 1 || -z "$1" ]]; then
  echo 'USAGE: bash scripts/send-chatgpt-live.sh "message"' >&2
  exit 2
fi

if [[ -f "$ENV_FILE" ]]; then
  chmod 600 "$ENV_FILE"
  set -a
  # shellcheck disable=SC1090
  source "$ENV_FILE"
  set +a
fi

export BKE_WORKER_BROWSER_CDP_ENDPOINT="${BKE_WORKER_BROWSER_CDP_ENDPOINT:-http://127.0.0.1:9222}"
export BKE_WORKER_CHATGPT_BASE_URL="${BKE_WORKER_CHATGPT_BASE_URL:-https://chatgpt.com/}"
export BKE_WORKER_CHATGPT_PROFILE="${BKE_WORKER_CHATGPT_PROFILE:-$HOME/snap/chromium/common/bke-worker-chatgpt-profile}"
export BKE_WORKER_HEADLESS=false

# This smoke is intentionally isolated from the autonomous loop.
unset BKE_WORKER_NOTION_TOKEN
unset BKE_WORKER_NOTION_PAGE
unset BKE_WORKER_GITHUB_WEBHOOK_SECRET

cd "$ROOT_DIR"
bash scripts/verify-live-host.sh

echo "LIVE SEND SMOKE"
echo "GUARD: one explicit message only; Notion/GitHub loop disabled for this process."

dotnet run \
  --project tools/BKE.Worker.ChatGPT.SendSmoke/BKE.Worker.ChatGPT.SendSmoke.csproj \
  -c Release \
  -- "$1"
