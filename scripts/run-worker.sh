#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ENV_FILE="${BKE_WORKER_ENV_FILE:-$HOME/.config/bke-worker/bke-worker.env}"

if [[ -f "$ENV_FILE" ]]; then
  chmod 600 "$ENV_FILE"
  set -a
  # shellcheck disable=SC1090
  source "$ENV_FILE"
  set +a
else
  echo "WARNING: environment file not found: $ENV_FILE" >&2
  echo "WARNING: starting the operator UI in NOT READY state." >&2
fi

# Notion authentication is UI/session-owned. Preserve only transport configuration.
while IFS= read -r name; do
  if [[ "$name" != "BKE_WORKER_NOTION_BASE_URL" ]]; then unset "$name"; fi
done < <(compgen -A variable BKE_WORKER_NOTION_ || true)

# Deterministic ChatGPT conversation selection is UI/session-owned too.
# Ignore/purge any legacy override URL inherited from old host env files.
unset BKE_WORKER_CHATGPT_OVERRIDE_URL || true

export BKE_WORKER_BROWSER_CDP_ENDPOINT="${BKE_WORKER_BROWSER_CDP_ENDPOINT:-http://127.0.0.1:9222}"
export BKE_WORKER_CHATGPT_BASE_URL="${BKE_WORKER_CHATGPT_BASE_URL:-https://chatgpt.com/}"
export BKE_WORKER_CHATGPT_PROFILE="${BKE_WORKER_CHATGPT_PROFILE:-$HOME/snap/chromium/common/bke-worker-chatgpt-profile}"
export BKE_WORKER_STATE_FILE="${BKE_WORKER_STATE_FILE:-$HOME/.local/share/bke-worker/state/notion-watchdog.json}"
export BKE_WORKER_WATCHDOG_SECONDS="${BKE_WORKER_WATCHDOG_SECONDS:-2}"
export BKE_WORKER_IDLE_RETRY_SECONDS="${BKE_WORKER_IDLE_RETRY_SECONDS:-5}"
export BKE_WORKER_HEADLESS=false
export ASPNETCORE_URLS="${ASPNETCORE_URLS:-http://0.0.0.0:5080}"

mkdir -p "$(dirname "$BKE_WORKER_STATE_FILE")"
chmod 700 "$(dirname "$BKE_WORKER_STATE_FILE")"

cd "$ROOT_DIR"
if bash scripts/verify-live-host.sh; then
  echo "Live ChatGPT host prerequisites: READY"
else
  echo "WARNING: live ChatGPT host prerequisites are not ready yet." >&2
  echo "WARNING: operator UI will still start; ChatGPT actions remain unavailable until fixed." >&2
fi

echo "Starting BKE Worker — Notion checkbox watchdog."
echo "operator UI: $ASPNETCORE_URLS"
echo "CDP: $BKE_WORKER_BROWSER_CDP_ENDPOINT (loopback only)"
echo "Notion secret: operator UI memory only"
echo "ChatGPT target URL: operator UI memory only"
echo "project discovery: Notion pages whose title starts with ENGINEERING:"
echo "project identity: exact selected Notion page ID"
echo "task identity: exact Notion to_do block ID"
echo "instruction authority: same selected-page Notion tables with KEY | NAME | INSTRUCTION"
echo "watchdog: ${BKE_WORKER_WATCHDOG_SECONDS}s"
echo "idle retry: ${BKE_WORKER_IDLE_RETRY_SECONDS}s"
echo "guard: names discover; IDs execute"
echo "guard: unchecked + ChatGPT busy = wait"
echo "guard: unchecked + ChatGPT idle = continue current TODO"
echo "guard: checked = next unchecked TODO on the locked page"
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
exec dotnet run --project src/BKE.Worker.Server/BKE.Worker.Server.csproj -c Release --no-build
