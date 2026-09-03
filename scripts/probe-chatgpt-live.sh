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
fi

export ASPNETCORE_URLS="${ASPNETCORE_URLS:-http://127.0.0.1:5084}"
export BKE_WORKER_BROWSER_CDP_ENDPOINT="${BKE_WORKER_BROWSER_CDP_ENDPOINT:-http://127.0.0.1:9222}"
export BKE_WORKER_CHATGPT_BASE_URL="${BKE_WORKER_CHATGPT_BASE_URL:-https://chatgpt.com/}"
export BKE_WORKER_CHATGPT_PROFILE="${BKE_WORKER_CHATGPT_PROFILE:-$HOME/snap/chromium/common/bke-worker-chatgpt-profile}"
export BKE_WORKER_STATE_FILE="${BKE_WORKER_STATE_FILE:-$HOME/.local/share/bke-worker/state/worker.json}"
export BKE_WORKER_HEADLESS=false

present_value() {
  [[ -n "${1:-}" && "$1" != "REPLACE_ME" ]]
}

has_override=false
has_project=false
has_conversation=false
present_value "${BKE_WORKER_CHATGPT_OVERRIDE_URL:-}" && has_override=true
present_value "${BKE_WORKER_CHATGPT_PROJECT:-}" && has_project=true
present_value "${BKE_WORKER_CHATGPT_CONVERSATION:-}" && has_conversation=true

if [[ "$has_override" == true && ( "$has_project" == true || "$has_conversation" == true ) ]]; then
  echo "ERROR: ChatGPT target is ambiguous. Configure Override Link OR Project + Conversation, not both." >&2
  exit 1
fi

if [[ "$has_project" != "$has_conversation" ]]; then
  echo "ERROR: ChatGPT Project and Conversation must be configured together." >&2
  exit 1
fi

if [[ "$has_override" == true ]]; then
  target_mode="override-link"
elif [[ "$has_project" == true ]]; then
  target_mode="project-chat"
else
  target_mode="new-chat"
fi

# Phase 6A is intentionally ChatGPT-only. Force the hosted worker to remain
# unconfigured so no Notion reconciliation or GitHub-driven engineering loop
# can start during a non-mutating adapter probe.
unset BKE_WORKER_NOTION_TOKEN
unset BKE_WORKER_NOTION_PAGE
unset BKE_WORKER_GITHUB_WEBHOOK_SECRET

mkdir -p "$(dirname "$BKE_WORKER_STATE_FILE")"
chmod 700 "$(dirname "$BKE_WORKER_STATE_FILE")"

cd "$ROOT_DIR"
bash scripts/verify-live-host.sh

echo "Starting isolated Phase 6A ChatGPT probe server."
echo "target: $target_mode"
echo "GUARD: Notion and GitHub are disabled for this process; the probe must not send a prompt."

dotnet build src/BKE.Worker.Server/BKE.Worker.Server.csproj -c Release >/dev/null

dotnet run \
  --project src/BKE.Worker.Server/BKE.Worker.Server.csproj \
  -c Release \
  --no-build \
  >/tmp/bke-worker-phase6a-probe.log 2>&1 &
server_pid=$!

cleanup() {
  if kill -0 "$server_pid" >/dev/null 2>&1; then
    kill "$server_pid" >/dev/null 2>&1 || true
    wait "$server_pid" >/dev/null 2>&1 || true
  fi
}
trap cleanup EXIT INT TERM

probe_url="${ASPNETCORE_URLS%/}/control/chatgpt/probe"
ready_url="${ASPNETCORE_URLS%/}/health/live"

for _ in $(seq 1 50); do
  if curl --fail --silent "$ready_url" >/dev/null 2>&1; then
    break
  fi
  if ! kill -0 "$server_pid" >/dev/null 2>&1; then
    echo "ERROR: probe server exited before becoming ready." >&2
    cat /tmp/bke-worker-phase6a-probe.log >&2 || true
    exit 1
  fi
  sleep 0.2
done

if ! curl --fail --silent "$ready_url" >/dev/null 2>&1; then
  echo "ERROR: probe server did not become ready." >&2
  cat /tmp/bke-worker-phase6a-probe.log >&2 || true
  exit 1
fi

response_file="$(mktemp)"
trap 'rm -f "$response_file"; cleanup' EXIT INT TERM

http_code="$(curl --silent --show-error \
  --output "$response_file" \
  --write-out '%{http_code}' \
  --request POST \
  "$probe_url")"

printf 'PHASE 6A CHATGPT PROBE\n'
printf '  HTTP: %s\n' "$http_code"
jq . "$response_file"

if [[ "$http_code" != "200" ]]; then
  echo "PROBE NOT CERTIFIED: adapter returned HTTP $http_code." >&2
  exit 1
fi

jq -e '
  .compatible == true and
  .authenticated == true and
  .composerAvailable == true and
  .turnBusy == false and
  .canSendNextTurn == true and
  (.failure == null)
' "$response_file" >/dev/null || {
  echo "PROBE NOT CERTIFIED: expected authenticated compatible idle composer state." >&2
  exit 1
}

echo "PHASE 6A LIVE CHATGPT ADAPTER PROBE GREEN"
