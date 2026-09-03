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
export BKE_WORKER_STATE_FILE="${BKE_WORKER_STATE_FILE:-$HOME/.local/share/bke-worker/state/worker.json}"
export BKE_WORKER_HEADLESS=false

mkdir -p "$(dirname "$BKE_WORKER_STATE_FILE")"
chmod 700 "$(dirname "$BKE_WORKER_STATE_FILE")"

required=(
  BKE_WORKER_NOTION_TOKEN
  BKE_WORKER_NOTION_PAGE
  BKE_WORKER_GITHUB_WEBHOOK_SECRET
)

for name in "${required[@]}"; do
  if [[ -z "${!name:-}" || "${!name}" == "REPLACE_ME" ]]; then
    echo "ERROR: required setting is missing: $name" >&2
    exit 1
  fi
done

has_override=false
if [[ -n "${BKE_WORKER_CHATGPT_OVERRIDE_URL:-}" && "${BKE_WORKER_CHATGPT_OVERRIDE_URL}" != "REPLACE_ME" ]]; then
  has_override=true
fi

has_semantic=false
if [[ -n "${BKE_WORKER_CHATGPT_PROJECT:-}" && "${BKE_WORKER_CHATGPT_PROJECT}" != "REPLACE_ME" && \
      -n "${BKE_WORKER_CHATGPT_CONVERSATION:-}" && "${BKE_WORKER_CHATGPT_CONVERSATION}" != "REPLACE_ME" ]]; then
  has_semantic=true
fi

if [[ "$has_override" != true && "$has_semantic" != true ]]; then
  echo "ERROR: configure either BKE_WORKER_CHATGPT_OVERRIDE_URL or both BKE_WORKER_CHATGPT_PROJECT and BKE_WORKER_CHATGPT_CONVERSATION." >&2
  exit 1
fi

cd "$ROOT_DIR"
bash scripts/verify-live-host.sh

echo "Starting BKE Worker in live CDP-attach mode."
if [[ "$has_override" == true ]]; then
  echo "target: override-link (takes precedence over Project + Conversation)"
else
  echo "target: project-chat"
fi
echo "GUARD: authentication remains human-only; CHATGPT_AUTH_REQUIRED must block all further movement."

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
