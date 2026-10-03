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

required=(
  BKE_WORKER_ID
  BKE_WORKER_GITHUB_WEBHOOK_SECRET
  BKE_WORKER_BROWSER_CDP_ENDPOINT
)

for name in "${required[@]}"; do
  if [[ -z "${!name:-}" || "${!name}" == "REPLACE_ME" ]]; then
    echo "ERROR: required setting is missing: $name" >&2
    exit 1
  fi
done

if [[ ! "$BKE_WORKER_ID" =~ ^[a-z0-9][a-z0-9-]{0,62}$ ]]; then
  echo "ERROR: BKE_WORKER_ID must match [a-z0-9][a-z0-9-]{0,62}" >&2
  exit 1
fi

export BKE_WORKER_CHATGPT_BASE_URL="${BKE_WORKER_CHATGPT_BASE_URL:-https://chatgpt.com/}"
export BKE_WORKER_CHATGPT_PROFILE="${BKE_WORKER_CHATGPT_PROFILE:-$HOME/snap/chromium/common/bke-worker-$BKE_WORKER_ID-chatgpt-profile}"
export BKE_WORKER_STATE_FILE="${BKE_WORKER_STATE_FILE:-$HOME/.local/share/bke-worker/state/$BKE_WORKER_ID.json}"
export BKE_WORKER_RESOURCE_LOCK_DIRECTORY="${BKE_WORKER_RESOURCE_LOCK_DIRECTORY:-$HOME/.local/share/bke-worker/locks}"
export BKE_WORKER_HEARTBEAT_SECONDS="${BKE_WORKER_HEARTBEAT_SECONDS:-1800}"
export BKE_WORKER_HEADLESS=false
export ASPNETCORE_URLS="${ASPNETCORE_URLS:-http://127.0.0.1:5080}"

mkdir -p   "$(dirname "$BKE_WORKER_STATE_FILE")"   "$BKE_WORKER_RESOURCE_LOCK_DIRECTORY"
chmod 700   "$(dirname "$BKE_WORKER_STATE_FILE")"   "$BKE_WORKER_RESOURCE_LOCK_DIRECTORY"

cd "$ROOT_DIR"
bash scripts/verify-live-host.sh

echo "Starting BKE Worker in GitHub-native multi-worker mode."
echo "worker_id: $BKE_WORKER_ID"
echo "assignment label: bke-worker:$BKE_WORKER_ID"
echo "listen: $ASPNETCORE_URLS (loopback only)"
echo "CDP: $BKE_WORKER_BROWSER_CDP_ENDPOINT (loopback only)"
echo "profile: $BKE_WORKER_CHATGPT_PROFILE"
echo "state: $BKE_WORKER_STATE_FILE"
echo "engineering truth: GitHub main + PR assignment labels + PR ledger + certification"
echo "heartbeat: ${BKE_WORKER_HEARTBEAT_SECONDS}s"
echo "invariant: one worker -> one active PR; one PR -> one active worker"
echo "GUARD: ChatGPT authentication remains human-only."

if [[ -n "${BKE_WORKER_SERVER_DLL:-}" ]]; then
  if [[ ! -f "$BKE_WORKER_SERVER_DLL" ]]; then
    echo "ERROR: BKE_WORKER_SERVER_DLL does not exist: $BKE_WORKER_SERVER_DLL" >&2
    exit 1
  fi
  exec dotnet "$BKE_WORKER_SERVER_DLL"
fi

dotnet build src/BKE.Worker.Server/BKE.Worker.Server.csproj -c Release >/dev/null
exec dotnet run   --project src/BKE.Worker.Server/BKE.Worker.Server.csproj   -c Release   --no-build
