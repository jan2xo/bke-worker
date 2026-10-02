#!/usr/bin/env bash
set -euo pipefail

FIXTURE=http://127.0.0.1:5092
WORKER=http://127.0.0.1:5082
SECRET=phase3-crash-secret
STATE_FILE="$RUNNER_TEMP/bke-worker-phase3-crash/state.json"
PROFILE_DIR="$RUNNER_TEMP/bke-worker-phase3-crash/chatgpt-profile"
WORKER_LOG="$RUNNER_TEMP/bke-worker-phase3-crash.log"
FIXTURE_LOG="$RUNNER_TEMP/bke-worker-phase3-crash-fixture.log"
WORKER_PID=""

mkdir -p "$(dirname "$STATE_FILE")"

python3 tests/integration/phase3_fixture.py --port 5092 > "$FIXTURE_LOG" 2>&1 &
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
  if curl --fail --silent "$FIXTURE/fixture-health" >/dev/null; then
    break
  fi
  sleep 1
done
curl --fail --silent "$FIXTURE/fixture-health" >/dev/null

start_worker() {
  export ASPNETCORE_URLS=http://127.0.0.1:5082
  export BKE_WORKER_NOTION_TOKEN=phase3-fixture-token
  export BKE_WORKER_NOTION_PAGE=aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa
  export BKE_WORKER_NOTION_BASE_URL="$FIXTURE/"
  export BKE_WORKER_CHATGPT_PROJECT="BKE Worker"
  export BKE_WORKER_CHATGPT_CONVERSATION="Worker Engineering"
  export BKE_WORKER_CHATGPT_BASE_URL="$FIXTURE/chatgpt/"
  export BKE_WORKER_GITHUB_WEBHOOK_SECRET="$SECRET"
  export BKE_WORKER_CHATGPT_PROFILE="$PROFILE_DIR"
  export BKE_WORKER_STATE_FILE="$STATE_FILE"
  export BKE_WORKER_HEADLESS=true
  export BKE_WORKER_WEBHOOK_DEBOUNCE_SECONDS=1
  export BKE_WORKER_RECOVERY_SECONDS=300
  export BKE_WORKER_MIN_DISPATCH_SECONDS=1

  dotnet artifacts/bke-worker-server/BKE.Worker.Server.dll >> "$WORKER_LOG" 2>&1 &
  WORKER_PID=$!

  for attempt in $(seq 1 30); do
    if curl --fail --silent "$WORKER/health/ready" >/dev/null; then
      return 0
    fi
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
  if [ -n "${WORKER_PID:-}" ]; then
    kill "$WORKER_PID" 2>/dev/null || true
    wait "$WORKER_PID" 2>/dev/null || true
    WORKER_PID=""
    sleep 1
  fi
}

prompt_count() {
  curl --fail --silent "$FIXTURE/admin/state" | python3 -c 'import json,sys; print(len(json.load(sys.stdin)["prompts"]))'
}

worker_field() {
  field="$1"
  curl --fail --silent "$WORKER/control/state" | python3 -c "import json,sys; print(json.load(sys.stdin).get('$field'))"
}

wait_prompt_count() {
  expected="$1"
  for attempt in $(seq 1 30); do
    if [ "$(prompt_count)" = "$expected" ]; then
      return 0
    fi
    sleep 1
  done
  echo "expected prompt count $expected but got $(prompt_count)"
  cat "$WORKER_LOG"
  cat "$FIXTURE_LOG"
  return 1
}

wait_worker_state() {
  expected="$1"
  for attempt in $(seq 1 30); do
    if [ "$(worker_field state)" = "$expected" ]; then
      return 0
    fi
    sleep 1
  done
  echo "expected worker state $expected but got $(worker_field state)"
  cat "$WORKER_LOG"
  return 1
}

send_webhook() {
  delivery="$1"
  body='{"ref":"refs/heads/main"}'
  signature=$(BODY="$body" SECRET="$SECRET" python3 - <<'PY'
import hashlib, hmac, os
print("sha256=" + hmac.new(os.environ["SECRET"].encode(), os.environ["BODY"].encode(), hashlib.sha256).hexdigest())
PY
  )
  code=$(curl --silent --output "$RUNNER_TEMP/crash-webhook.json" --write-out '%{http_code}' \
    -X POST "$WORKER/webhooks/github" \
    -H 'Content-Type: application/json' \
    -H 'X-GitHub-Event: push' \
    -H "X-GitHub-Delivery: $delivery" \
    -H "X-Hub-Signature-256: $signature" \
    --data "$body")
  test "$code" = "202"
}

echo 'PHASE3 CRASH: force browser SEND to reach fixture while state remains DISPATCHING'
curl --fail --silent -X POST "$FIXTURE/admin/block-send/on" >/dev/null
start_worker
wait_prompt_count 1
wait_worker_state DISPATCHING

echo 'PHASE3 CRASH: kill server after external SEND is observable but before WAITING persistence'
stop_worker
curl --fail --silent -X POST "$FIXTURE/admin/block-send/off" >/dev/null

echo 'PHASE3 CRASH: restart must fail closed rather than resend ambiguous instruction'
start_worker
wait_worker_state BLOCKED
test "$(worker_field failure)" = "DISPATCH_OUTCOME_UNKNOWN_AFTER_RESTART"
test "$(prompt_count)" = "1"

echo 'PHASE3 CRASH: even a later webhook cannot cause a duplicate from BLOCKED state'
send_webhook crash-delivery
sleep 3
test "$(prompt_count)" = "1"
test "$(worker_field state)" = "BLOCKED"

echo 'PHASE3 CRASH WINDOW: GREEN'
