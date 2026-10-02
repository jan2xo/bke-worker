#!/usr/bin/env bash
set -euo pipefail

FIXTURE=http://127.0.0.1:5094
WORKER=http://127.0.0.1:5084
STATE_FILE="$RUNNER_TEMP/bke-worker-phase3-atomic/state.json"
PROFILE_DIR="$RUNNER_TEMP/bke-worker-phase3-atomic/chatgpt-profile"
WORKER_LOG="$RUNNER_TEMP/bke-worker-phase3-atomic.log"
FIXTURE_LOG="$RUNNER_TEMP/bke-worker-phase3-atomic-fixture.log"
WORKER_PID=""

mkdir -p "$(dirname "$STATE_FILE")"
python3 tests/integration/phase3_fixture.py --port 5094 > "$FIXTURE_LOG" 2>&1 &
FIXTURE_PID=$!

cleanup() {
  if [ -n "${WORKER_PID:-}" ]; then
    kill "$WORKER_PID" 2>/dev/null || true
    wait "$WORKER_PID" 2>/dev/null || true
  fi
  kill "$FIXTURE_PID" 2>/dev/null || true
  wait "$FIXTURE_PID" 2>/dev/null || true
}
trap cleanup EXIT

for attempt in $(seq 1 20); do
  curl --fail --silent "$FIXTURE/fixture-health" >/dev/null && break
  sleep 1
done
curl --fail --silent "$FIXTURE/fixture-health" >/dev/null

start_worker() {
  export ASPNETCORE_URLS=http://127.0.0.1:5084
  export BKE_WORKER_NOTION_TOKEN=phase3-fixture-token
  export BKE_WORKER_NOTION_PAGE=aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa
  export BKE_WORKER_NOTION_BASE_URL="$FIXTURE/"
  export BKE_WORKER_CHATGPT_PROJECT="BKE Worker"
  export BKE_WORKER_CHATGPT_CONVERSATION="Worker Engineering"
  export BKE_WORKER_CHATGPT_BASE_URL="$FIXTURE/chatgpt/"
  export BKE_WORKER_GITHUB_WEBHOOK_SECRET=phase3-atomic-secret
  export BKE_WORKER_CHATGPT_PROFILE="$PROFILE_DIR"
  export BKE_WORKER_STATE_FILE="$STATE_FILE"
  export BKE_WORKER_HEADLESS=true
  export BKE_WORKER_RECOVERY_SECONDS=300
  export BKE_WORKER_MIN_DISPATCH_SECONDS=1

  dotnet artifacts/bke-worker-server/BKE.Worker.Server.dll >> "$WORKER_LOG" 2>&1 &
  WORKER_PID=$!
  for attempt in $(seq 1 30); do
    curl --fail --silent "$WORKER/health/ready" >/dev/null && return 0
    if ! kill -0 "$WORKER_PID" 2>/dev/null; then
      cat "$WORKER_LOG"
      return 1
    fi
    sleep 1
  done
  cat "$WORKER_LOG"
  return 1
}

stop_worker() {
  kill "$WORKER_PID" 2>/dev/null || true
  wait "$WORKER_PID" 2>/dev/null || true
  WORKER_PID=""
  sleep 1
}

prompt_count() {
  curl --fail --silent "$FIXTURE/admin/state" | python3 -c 'import json,sys; print(len(json.load(sys.stdin)["prompts"]))'
}

worker_state() {
  curl --fail --silent "$WORKER/control/state" | python3 -c 'import json,sys; print(json.load(sys.stdin)["state"])'
}

for attempt in $(seq 1 30); do
  start_worker
  break
done
for attempt in $(seq 1 30); do
  [ "$(prompt_count)" = "1" ] && break
  sleep 1
done
test "$(prompt_count)" = "1"
test "$(worker_state)" = "WAITING_FOR_ENGINEERING_EVENT"
stop_worker

echo 'PHASE3 ATOMIC STATE: inject a stale partial temp file beside committed state'
printf '{partial-write-that-must-never-win' > "$STATE_FILE.tmp"
test -s "$STATE_FILE"
test -s "$STATE_FILE.tmp"

start_worker
sleep 3
test "$(prompt_count)" = "1"
test "$(worker_state)" = "WAITING_FOR_ENGINEERING_EVENT"

echo 'PHASE3 ATOMIC STATE: committed file remained canonical; stale temp caused no duplicate dispatch'
echo 'PHASE3 ATOMIC STATE: GREEN'
