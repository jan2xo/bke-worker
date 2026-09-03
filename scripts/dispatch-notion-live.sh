#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ENV_FILE="${BKE_WORKER_ENV_FILE:-$HOME/.config/bke-worker/bke-worker.env}"

if [[ ! -f "$ENV_FILE" ]]; then
  echo "ERROR: missing environment file: $ENV_FILE" >&2
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
export BKE_WORKER_HEADLESS=false

for name in BKE_WORKER_NOTION_TOKEN BKE_WORKER_NOTION_PAGE; do
  if [[ -z "${!name:-}" || "${!name}" == "REPLACE_ME" ]]; then
    echo "ERROR: required setting is missing: $name" >&2
    exit 1
  fi
done

# This smoke proves only Notion -> target -> WorkerLoop -> one ChatGPT send.
# It must not enter the GitHub webhook loop.
unset BKE_WORKER_GITHUB_WEBHOOK_SECRET

cd "$ROOT_DIR"
bash scripts/verify-live-host.sh

echo "PHASE 6B ISOLATED NOTION DISPATCH"
echo "GUARD: human auth first; one Notion-driven continuation only."
echo "GUARD: no GitHub webhook; no Notion checkbox mutation; no autonomous continuation loop."
echo "notion page: $BKE_WORKER_NOTION_PAGE"

dotnet build tools/BKE.Worker.Notion.DispatchSmoke/BKE.Worker.Notion.DispatchSmoke.csproj -c Release >/dev/null

dotnet run \
  --project tools/BKE.Worker.Notion.DispatchSmoke/BKE.Worker.Notion.DispatchSmoke.csproj \
  -c Release \
  --no-build
