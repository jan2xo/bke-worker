#!/usr/bin/env bash
set -euo pipefail

FIXTURE=http://127.0.0.1:5094
WORKER=http://127.0.0.1:5084
SECRET=ui-ci-secret
ROOT="${RUNNER_TEMP:-/tmp}/bke-worker-ui"
STATE_FILE="$ROOT/state/worker-a.json"
PROFILE_DIR="$ROOT/profiles/worker-a"
LOCK_DIR="$ROOT/locks"
WORKER_LOG="$ROOT/worker.log"
FIXTURE_LOG="$ROOT/fixture.log"
PUBLISHED_DIR="${PUBLISHED_DIR:-artifacts/bke-worker-server}"

rm -rf "$ROOT"
mkdir -p "$ROOT/state" "$ROOT/profiles" "$LOCK_DIR"

python3 tests/integration/phase3_fixture.py --port 5094 > "$FIXTURE_LOG" 2>&1 &
FIXTURE_PID=$!
WORKER_PID=""

cleanup() {
  if [[ -n "${WORKER_PID:-}" ]]; then
    kill "$WORKER_PID" 2>/dev/null || true
    wait "$WORKER_PID" 2>/dev/null || true
  fi
  kill "$FIXTURE_PID" 2>/dev/null || true
  wait "$FIXTURE_PID" 2>/dev/null || true
}
trap cleanup EXIT

for attempt in $(seq 1 30); do
  curl --fail --silent "$FIXTURE/fixture-health" >/dev/null && break
  sleep 1
done
curl --fail --silent "$FIXTURE/fixture-health" >/dev/null

export ASPNETCORE_URLS="$WORKER"
export BKE_WORKER_ID=worker-a
export BKE_WORKER_CHATGPT_PROJECT="BKE Worker"
export BKE_WORKER_CHATGPT_CONVERSATION="Worker Engineering"
export BKE_WORKER_CHATGPT_OVERRIDE_URL=""
export BKE_WORKER_CHATGPT_BASE_URL="$FIXTURE/chatgpt/"
export BKE_WORKER_GITHUB_WEBHOOK_SECRET="$SECRET"
export BKE_WORKER_CHATGPT_PROFILE="$PROFILE_DIR"
export BKE_WORKER_STATE_FILE="$STATE_FILE"
export BKE_WORKER_RESOURCE_LOCK_DIRECTORY="$LOCK_DIR"
export BKE_WORKER_HEADLESS=true
export BKE_WORKER_WEBHOOK_DEBOUNCE_SECONDS=1
unset BKE_WORKER_HEARTBEAT_SECONDS
export BKE_WORKER_MIN_DISPATCH_SECONDS=1

dotnet "$PUBLISHED_DIR/BKE.Worker.Server.dll" > "$WORKER_LOG" 2>&1 &
WORKER_PID=$!

for attempt in $(seq 1 40); do
  curl --fail --silent "$WORKER/health/ready" >/dev/null && break
  if ! kill -0 "$WORKER_PID" 2>/dev/null; then
    cat "$WORKER_LOG"
    exit 1
  fi
  sleep 1
done
curl --fail --silent "$WORKER/health/ready" >/dev/null

body='{"action":"labeled","number":101,"pull_request":{"number":101,"state":"open","head":{"ref":"feat/pr-a","sha":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"},"labels":[{"name":"bke-worker:worker-a"}]}}'
signature="$(
  BODY="$body" SECRET="$SECRET" python3 - <<'PY'
import hashlib
import hmac
import os
print(
    "sha256=" +
    hmac.new(
        os.environ["SECRET"].encode(),
        os.environ["BODY"].encode(),
        hashlib.sha256,
    ).hexdigest()
)
PY
)"
code="$(
  curl --silent \
    --output "$ROOT/assignment.json" \
    --write-out '%{http_code}' \
    -X POST "$WORKER/webhooks/github" \
    -H 'Content-Type: application/json' \
    -H 'X-GitHub-Event: pull_request' \
    -H 'X-GitHub-Delivery: ui-assignment' \
    -H "X-Hub-Signature-256: $signature" \
    --data "$body"
)"
test "$code" = "202"

for attempt in $(seq 1 40); do
  count="$(
    curl --fail --silent "$FIXTURE/admin/state" |
      python3 -c 'import json,sys; print(len(json.load(sys.stdin)["prompts"]))'
  )"
  [[ "$count" == "1" ]] && break
  sleep 1
done
test "${count:-0}" = "1"

export BKE_WORKER_UI_BASE_URL="$WORKER"
export BKE_WORKER_UI_FIXTURE_URL="$FIXTURE"

dotnet test \
  tests/BKE.Worker.Server.Ui.Tests/BKE.Worker.Server.Ui.Tests.csproj \
  --configuration Release \
  --no-build \
  --logger "console;verbosity=normal"

echo "GITHUB-NATIVE OPERATOR UI: GREEN"
