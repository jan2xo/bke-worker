#!/usr/bin/env bash
set -euo pipefail

FIXTURE=http://127.0.0.1:5093
WORKER=http://127.0.0.1:5083
SECRET=phase3-hardening-secret
FIXTURE_LOG="$RUNNER_TEMP/bke-worker-phase3-hardening-fixture.log"
WORKER_PID=""
SCENARIO=none
STATE_FILE=""
PROFILE_DIR=""
WORKER_LOG=""

python3 tests/integration/phase3_fixture.py --port 5093 > "$FIXTURE_LOG" 2>&1 &
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

reset_fixture() {
  curl --fail --silent -X POST "$FIXTURE/admin/reset" >/dev/null
}

prepare_scenario() {
  SCENARIO="$1"
  STATE_FILE="$RUNNER_TEMP/bke-worker-hardening-$SCENARIO/state.json"
  PROFILE_DIR="$RUNNER_TEMP/bke-worker-hardening-$SCENARIO/chatgpt-profile"
  WORKER_LOG="$RUNNER_TEMP/bke-worker-hardening-$SCENARIO.log"
  rm -rf "$(dirname "$STATE_FILE")"
  mkdir -p "$(dirname "$STATE_FILE")"
  reset_fixture
}

export_worker_env() {
  export ASPNETCORE_URLS=http://127.0.0.1:5083
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
}

start_worker() {
  export_worker_env
  dotnet artifacts/bke-worker-server/BKE.Worker.Server.dll > "$WORKER_LOG" 2>&1 &
  WORKER_PID=$!
  for attempt in $(seq 1 30); do
    if curl --fail --silent "$WORKER/health/live" >/dev/null; then
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

worker_field() {
  field="$1"
  curl --fail --silent "$WORKER/control/state" | python3 -c "import json,sys; print(json.load(sys.stdin).get('$field'))"
}

wait_worker_state() {
  expected="$1"
  for attempt in $(seq 1 30); do
    if kill -0 "$WORKER_PID" 2>/dev/null; then
      actual=$(worker_field state 2>/dev/null || true)
      if [ "$actual" = "$expected" ]; then
        return 0
      fi
    fi
    sleep 1
  done
  echo "scenario=$SCENARIO expected=$expected actual=$(worker_field state 2>/dev/null || true)"
  cat "$WORKER_LOG"
  cat "$FIXTURE_LOG"
  return 1
}

prompt_count() {
  curl --fail --silent "$FIXTURE/admin/state" | python3 -c 'import json,sys; print(len(json.load(sys.stdin)["prompts"]))'
}

wait_prompt_count() {
  expected="$1"
  for attempt in $(seq 1 30); do
    if [ "$(prompt_count)" = "$expected" ]; then
      return 0
    fi
    sleep 1
  done
  echo "scenario=$SCENARIO expected prompts=$expected actual=$(prompt_count)"
  cat "$WORKER_LOG"
  return 1
}

assert_failure_contains() {
  expected="$1"
  actual=$(worker_field failure)
  echo "scenario=$SCENARIO failure=$actual"
  [[ "$actual" == *"$expected"* ]]
}

echo 'PHASE3 HARDENING: missing Project blocks safely after one UI reset/retry'
prepare_scenario missing-project
curl --fail --silent -X POST "$FIXTURE/admin/project/off" >/dev/null
start_worker
wait_worker_state BLOCKED
assert_failure_contains PROJECT_NOT_FOUND
test "$(prompt_count)" = "0"
stop_worker

echo 'PHASE3 HARDENING: missing Conversation blocks safely after one UI reset/retry'
prepare_scenario missing-conversation
curl --fail --silent -X POST "$FIXTURE/admin/conversation/off" >/dev/null
start_worker
wait_worker_state BLOCKED
assert_failure_contains CONTEXT_NOT_FOUND
test "$(prompt_count)" = "0"
stop_worker

echo 'PHASE3 HARDENING: authentication requirement blocks safely'
prepare_scenario auth-required
curl --fail --silent -X POST "$FIXTURE/admin/auth/on" >/dev/null
start_worker
wait_worker_state BLOCKED
assert_failure_contains CHATGPT_AUTH_REQUIRED
test "$(prompt_count)" = "0"
stop_worker

echo 'PHASE3 HARDENING: missing composer fails deterministically without fake success'
prepare_scenario composer-missing
curl --fail --silent -X POST "$FIXTURE/admin/composer/off" >/dev/null
start_worker
wait_worker_state FAILED
assert_failure_contains CHATGPT_COMPOSER_NOT_AVAILABLE
test "$(prompt_count)" = "0"
stop_worker

echo 'PHASE3 HARDENING: first project lookup failure resets UI once and succeeds on retry'
prepare_scenario one-reset-retry
curl --fail --silent -X POST "$FIXTURE/admin/project/fail-once" >/dev/null
start_worker
wait_prompt_count 1
wait_worker_state WAITING_FOR_ENGINEERING_EVENT
test "$(worker_field currentChecklistIdentifier)" = "11111111-1111-1111-1111-111111111111"
stop_worker

echo 'PHASE3 HARDENING: malformed durable state fails closed before browser dispatch'
prepare_scenario corrupt-state
printf '{this-is-not-valid-json' > "$STATE_FILE"
export_worker_env
dotnet artifacts/bke-worker-server/BKE.Worker.Server.dll > "$WORKER_LOG" 2>&1 &
WORKER_PID=$!
for attempt in $(seq 1 20); do
  if ! kill -0 "$WORKER_PID" 2>/dev/null; then
    break
  fi
  sleep 1
done
if kill -0 "$WORKER_PID" 2>/dev/null; then
  echo 'corrupted state unexpectedly left worker process running'
  cat "$WORKER_LOG"
  exit 1
fi
WORKER_PID=""
test "$(prompt_count)" = "0"
grep -Eq 'JsonException|JSON|json' "$WORKER_LOG"
echo 'corrupt state stopped the worker before any browser prompt was emitted'

echo 'PHASE3 HARDENING: missing state file initializes cleanly'
prepare_scenario missing-state
start_worker
wait_prompt_count 1
wait_worker_state WAITING_FOR_ENGINEERING_EVENT
test -s "$STATE_FILE"
stop_worker

echo 'PHASE3 HARDENING: missing webhook secret is not ready and webhook fails closed'
prepare_scenario missing-webhook-secret
export_worker_env
export BKE_WORKER_GITHUB_WEBHOOK_SECRET=
dotnet artifacts/bke-worker-server/BKE.Worker.Server.dll > "$WORKER_LOG" 2>&1 &
WORKER_PID=$!
for attempt in $(seq 1 20); do
  if curl --fail --silent "$WORKER/health/live" >/dev/null; then
    break
  fi
  sleep 1
done
ready_code=$(curl --silent --output "$RUNNER_TEMP/hardening-ready.json" --write-out '%{http_code}' "$WORKER/health/ready")
test "$ready_code" = "503"
webhook_code=$(curl --silent --output "$RUNNER_TEMP/hardening-webhook.json" --write-out '%{http_code}' \
  -X POST "$WORKER/webhooks/github" \
  -H 'X-GitHub-Event: push' \
  -H 'X-GitHub-Delivery: no-secret' \
  --data '{}')
test "$webhook_code" = "503"
test "$(prompt_count)" = "0"
stop_worker

echo 'PHASE3 HARDENING: deployment artifact and systemd unit are structurally valid'
test -f artifacts/bke-worker-server/BKE.Worker.Server.dll
test -f artifacts/bke-worker-server/BKE.Worker.Core.dll
test -f artifacts/bke-worker-server/BKE.Worker.ChatGPT.dll
test -f artifacts/bke-worker-server/BKE.Worker.Notion.dll
test -f artifacts/bke-worker-server/BKE.Worker.GitHub.dll
test -f deploy/systemd/bke-worker.service
grep -q 'ExecStart=/usr/bin/dotnet /opt/bke-worker/BKE.Worker.Server.dll' deploy/systemd/bke-worker.service
grep -q 'EnvironmentFile=/etc/bke-worker/bke-worker.env' deploy/systemd/bke-worker.service
grep -q 'Restart=on-failure' deploy/systemd/bke-worker.service

sudo mkdir -p /opt/bke-worker /etc/bke-worker
sudo cp -a artifacts/bke-worker-server/. /opt/bke-worker/
sudo touch /etc/bke-worker/bke-worker.env
if ! id bke-worker >/dev/null 2>&1; then
  sudo useradd --system --no-create-home --shell /usr/sbin/nologin bke-worker
fi
systemd-analyze verify deploy/systemd/bke-worker.service

echo 'PHASE3 HARDENING: GREEN'
