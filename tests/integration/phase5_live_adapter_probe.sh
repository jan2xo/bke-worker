#!/usr/bin/env bash
set -euo pipefail

FIXTURE=${FIXTURE:-http://127.0.0.1:5095}
WORKER=${WORKER:-http://127.0.0.1:5085}
PUBLISHED_DIR=${PUBLISHED_DIR:-artifacts/bke-worker-server}
STATE_FILE=${STATE_FILE:-${RUNNER_TEMP:-/tmp}/bke-worker-phase5/state.json}
PROFILE_DIR=${PROFILE_DIR:-${RUNNER_TEMP:-/tmp}/bke-worker-phase5/chatgpt-profile}
WORKER_LOG=${WORKER_LOG:-${RUNNER_TEMP:-/tmp}/bke-worker-phase5.log}
FIXTURE_LOG=${FIXTURE_LOG:-${RUNNER_TEMP:-/tmp}/bke-worker-phase5-fixture.log}
PROBE_JSON=${PROBE_JSON:-${RUNNER_TEMP:-/tmp}/phase5-probe.json}

mkdir -p "$(dirname "$STATE_FILE")"

python3 tests/integration/phase3_fixture.py --port 5095 > "$FIXTURE_LOG" 2>&1 &
FIXTURE_PID=$!

cleanup() {
  kill "${WORKER_PID:-0}" 2>/dev/null || true
  wait "${WORKER_PID:-0}" 2>/dev/null || true
  kill "$FIXTURE_PID" 2>/dev/null || true
  wait "$FIXTURE_PID" 2>/dev/null || true
}
trap cleanup EXIT

for attempt in $(seq 1 20); do
  if curl --fail --silent "$FIXTURE/fixture-health" >/dev/null; then break; fi
  sleep 1
done
curl --fail --silent "$FIXTURE/fixture-health" >/dev/null

export ASPNETCORE_URLS="$WORKER"
export BKE_WORKER_NOTION_TOKEN=phase5-fixture-token
export BKE_WORKER_NOTION_PAGE=aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa
export BKE_WORKER_NOTION_BASE_URL="$FIXTURE/"
export BKE_WORKER_CHATGPT_PROJECT="BKE Worker"
export BKE_WORKER_CHATGPT_CONVERSATION="Worker Engineering"
export BKE_WORKER_CHATGPT_BASE_URL="$FIXTURE/chatgpt/"
export BKE_WORKER_GITHUB_WEBHOOK_SECRET=phase5-ci-secret
export BKE_WORKER_CHATGPT_PROFILE="$PROFILE_DIR"
export BKE_WORKER_STATE_FILE="$STATE_FILE"
export BKE_WORKER_HEADLESS=true
export BKE_WORKER_WEBHOOK_DEBOUNCE_SECONDS=1
export BKE_WORKER_RECOVERY_SECONDS=3600
export BKE_WORKER_MIN_DISPATCH_SECONDS=60

dotnet "$PUBLISHED_DIR/BKE.Worker.Server.dll" > "$WORKER_LOG" 2>&1 &
WORKER_PID=$!

for attempt in $(seq 1 30); do
  if curl --fail --silent "$WORKER/health/ready" >/dev/null; then break; fi
  if ! kill -0 "$WORKER_PID" 2>/dev/null; then
    cat "$WORKER_LOG"
    exit 1
  fi
  sleep 1
done
curl --fail --silent "$WORKER/health/ready" >/dev/null

prompt_count() {
  curl --fail --silent "$FIXTURE/admin/state" | python3 -c 'import json,sys; print(len(json.load(sys.stdin)["prompts"]))'
}

for attempt in $(seq 1 30); do
  count=$(prompt_count)
  if [ "$count" = "1" ]; then break; fi
  sleep 1
done
test "${count:-0}" = "1" || {
  echo "initial worker dispatch did not reach fixture"
  cat "$WORKER_LOG"
  cat "$FIXTURE_LOG"
  exit 1
}

probe_expect() {
  local expected_status=$1
  local label=$2
  local status
  status=$(curl --silent --output "$PROBE_JSON" --write-out '%{http_code}' -X POST "$WORKER/control/chatgpt/probe")
  echo "PHASE5 PROBE [$label] HTTP $status"
  cat "$PROBE_JSON"
  echo
  test "$status" = "$expected_status" || exit 1
  test "$(prompt_count)" = "1" || {
    echo "probe mutated ChatGPT prompt count"
    exit 1
  }
}

echo 'PHASE5: compatible idle surface'
probe_expect 200 idle
python3 - "$PROBE_JSON" <<'PY'
import json, pathlib, sys
p = json.loads(pathlib.Path(sys.argv[1]).read_text())
assert p["compatible"] is True, p
assert p["authenticated"] is True, p
assert p["project"] == "BKE Worker", p
assert p["conversation"] == "Worker Engineering", p
assert p["composerAvailable"] is True, p
assert p["turnBusy"] is False, p
assert p["canSendNextTurn"] is True, p
assert p["failure"] is None, p
PY

echo 'PHASE5: busy surface remains adapter-compatible and non-mutating'
curl --fail --silent -X POST "$FIXTURE/admin/busy/on" >/dev/null
probe_expect 200 busy
python3 - "$PROBE_JSON" <<'PY'
import json, pathlib, sys
p = json.loads(pathlib.Path(sys.argv[1]).read_text())
assert p["compatible"] is True, p
assert p["authenticated"] is True, p
assert p["turnBusy"] is True, p
assert p["canSendNextTurn"] is False, p
assert p["failure"] is None, p
PY
curl --fail --silent -X POST "$FIXTURE/admin/busy/off" >/dev/null

echo 'PHASE5: missing composer fails deterministically without sending'
curl --fail --silent -X POST "$FIXTURE/admin/composer/off" >/dev/null
probe_expect 503 composer-missing
python3 - "$PROBE_JSON" <<'PY'
import json, pathlib, sys
p = json.loads(pathlib.Path(sys.argv[1]).read_text())
assert p["compatible"] is False, p
assert p["failure"] == "CHATGPT_COMPOSER_NOT_AVAILABLE", p
PY
curl --fail --silent -X POST "$FIXTURE/admin/composer/on" >/dev/null

echo 'PHASE5: missing exact Project fails deterministically without sending'
curl --fail --silent -X POST "$FIXTURE/admin/project/off" >/dev/null
probe_expect 503 project-missing
python3 - "$PROBE_JSON" <<'PY'
import json, pathlib, sys
p = json.loads(pathlib.Path(sys.argv[1]).read_text())
assert p["compatible"] is False, p
assert p["failure"] == "PROJECT_NOT_FOUND", p
PY
curl --fail --silent -X POST "$FIXTURE/admin/project/on" >/dev/null

echo 'PHASE5: missing exact Conversation fails deterministically without sending'
curl --fail --silent -X POST "$FIXTURE/admin/conversation/off" >/dev/null
probe_expect 503 conversation-missing
python3 - "$PROBE_JSON" <<'PY'
import json, pathlib, sys
p = json.loads(pathlib.Path(sys.argv[1]).read_text())
assert p["compatible"] is False, p
assert p["failure"] == "CONTEXT_NOT_FOUND", p
PY
curl --fail --silent -X POST "$FIXTURE/admin/conversation/on" >/dev/null

echo 'PHASE5: authentication requirement fails closed without sending'
curl --fail --silent -X POST "$FIXTURE/admin/auth/on" >/dev/null
probe_expect 503 auth-required
python3 - "$PROBE_JSON" <<'PY'
import json, pathlib, sys
p = json.loads(pathlib.Path(sys.argv[1]).read_text())
assert p["compatible"] is False, p
assert p["authenticated"] is False, p
assert p["failure"] == "CHATGPT_AUTH_REQUIRED", p
PY

echo 'PHASE5 LIVE ADAPTER HARNESS: GREEN'
