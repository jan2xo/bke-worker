#!/usr/bin/env bash
set -euo pipefail

FIXTURE=http://127.0.0.1:5094
WORKER=http://127.0.0.1:5084
SECRET=github-native-ci-secret
ROOT="${RUNNER_TEMP:-/tmp}/bke-worker-github-native"
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
export BKE_WORKER_ID="worker-a"
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
export BKE_WORKER_HEARTBEAT_SECONDS=1800
export BKE_WORKER_MIN_DISPATCH_SECONDS=1

dotnet "$PUBLISHED_DIR/BKE.Worker.Server.dll" > "$WORKER_LOG" 2>&1 &
WORKER_PID=$!

for attempt in $(seq 1 40); do
  if curl --fail --silent "$WORKER/health/ready" >/dev/null; then
    break
  fi
  if ! kill -0 "$WORKER_PID" 2>/dev/null; then
    cat "$WORKER_LOG"
    exit 1
  fi
  sleep 1
done
curl --fail --silent "$WORKER/health/ready" >/dev/null

prompt_count() {
  curl --fail --silent "$FIXTURE/admin/state" |
    python3 -c 'import json,sys; print(len(json.load(sys.stdin)["prompts"]))'
}

wait_prompt_count() {
  expected="$1"
  for attempt in $(seq 1 40); do
    if [[ "$(prompt_count)" == "$expected" ]]; then
      return 0
    fi
    sleep 1
  done
  echo "expected prompt count $expected; got $(prompt_count)" >&2
  cat "$WORKER_LOG" >&2
  cat "$FIXTURE_LOG" >&2
  return 1
}

send_webhook() {
  event="$1"
  delivery="$2"
  body="$3"
  signature_mode="${4:-valid}"
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
  if [[ "$signature_mode" == "invalid" ]]; then
    signature="sha256=00"
  fi

  curl --silent \
    --output "$ROOT/webhook.json" \
    --write-out '%{http_code}' \
    -X POST "$WORKER/webhooks/github" \
    -H 'Content-Type: application/json' \
    -H "X-GitHub-Event: $event" \
    -H "X-GitHub-Delivery: $delivery" \
    -H "X-Hub-Signature-256: $signature" \
    --data "$body"
}

assignment_body() {
  cat <<'JSON'
{"action":"labeled","number":101,"pull_request":{"number":101,"state":"open","head":{"ref":"feat/pr-a","sha":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"},"labels":[{"name":"bke-worker:worker-a"}]}}
JSON
}

echo "GITHUB-NATIVE: startup waits for durable PR assignment"
sleep 2
test "$(prompt_count)" = "0"
state="$(curl --fail --silent "$WORKER/control/state")"
STATE="$state" python3 - <<'PY'
import json
import os
p = json.loads(os.environ["STATE"])
assert p["state"] == "WAITING_FOR_ASSIGNMENT", p
assert p["assignment"] is None, p
PY

echo "GITHUB-NATIVE: signed PR label assigns worker and dispatches"
body="$(assignment_body)"
test "$(send_webhook pull_request delivery-assign "$body")" = "202"
wait_prompt_count 1

initial_prompt="$(
  curl --fail --silent "$FIXTURE/admin/state" |
    python3 -c 'import json,sys; print(json.load(sys.stdin)["prompts"][0])'
)"
[[ "$initial_prompt" == *"CONTINUE AUTONOMOUS ENGINEERING"* ]]
[[ "$initial_prompt" == *"worker_id=worker-a"* ]]
[[ "$initial_prompt" == *"assigned PR #101"* ]]
[[ "$initial_prompt" == *"bke-worker:worker-a"* ]]
[[ "$initial_prompt" != *"Notion"* ]]

summary="$(curl --fail --silent "$WORKER/control/summary")"
SUMMARY="$summary" python3 - <<'PY'
import json
import os
p = json.loads(os.environ["SUMMARY"])
assert p["engineeringAuthority"] == "github", p
assert p["assignmentAuthority"] == "github-pr-label", p
assert p["workerId"] == "worker-a", p
assert p["assignmentLabel"] == "bke-worker:worker-a", p
assert p["activeAssignment"]["number"] == 101, p
assert p["oneWorkerPerPullRequest"] is True, p
assert p["onePullRequestPerWorker"] is True, p
assert p["heartbeatSeconds"] == 1800, p
assert "notion" not in json.dumps(p).lower(), p
PY

echo "GITHUB-NATIVE: unrelated PR metadata action does not redispatch"
edited='{"action":"edited","number":101,"pull_request":{"number":101,"state":"open","head":{"ref":"feat/pr-a","sha":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"},"labels":[{"name":"bke-worker:worker-a"}]}}'
test "$(send_webhook pull_request delivery-edited "$edited")" = "202"
sleep 2
test "$(prompt_count)" = "1"

echo "GITHUB-NATIVE: invalid webhook signature fails closed"
push='{"ref":"refs/heads/feat/pr-a","after":"bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"}'
test "$(send_webhook push bad-signature "$push" invalid)" = "401"
test "$(prompt_count)" = "1"

echo "GITHUB-NATIVE: assigned branch push wakes worker"
test "$(send_webhook push delivery-push "$push")" = "202"
wait_prompt_count 2

echo "GITHUB-NATIVE: unrelated branch push does not cross-dispatch"
other='{"ref":"refs/heads/feat/pr-b","after":"cccccccccccccccccccccccccccccccccccccccc"}'
test "$(send_webhook push delivery-other "$other")" = "202"
sleep 3
test "$(prompt_count)" = "2"

echo "GITHUB-NATIVE: duplicate delivery is idempotent"
test "$(send_webhook push delivery-push "$push")" = "202"
sleep 3
test "$(prompt_count)" = "2"

echo "GITHUB-NATIVE: busy ChatGPT defers assigned push without losing delivery"
curl --fail --silent -X POST "$FIXTURE/admin/busy/on" >/dev/null
test "$(send_webhook push delivery-busy "$push")" = "202"
sleep 4
test "$(prompt_count)" = "2"
state="$(curl --fail --silent "$WORKER/control/state")"
STATE="$state" python3 - <<'PY'
import json
import os
p = json.loads(os.environ["STATE"])
assert p["state"] == "WAITING_FOR_ENGINEERING_EVENT", p
assert p["lastGitHubDeliveryId"] == "delivery-busy", p
assert p["assignment"]["number"] == 101, p
PY

echo "GITHUB-NATIVE: explicit manual continue recovers after safe idle"
curl --fail --silent -X POST "$FIXTURE/admin/busy/off" >/dev/null
code="$(curl --silent --output "$ROOT/manual-continue.json" --write-out '%{http_code}' -X POST "$WORKER/control/continue")"
test "$code" = "202"
wait_prompt_count 3

echo "GITHUB-NATIVE: assignment removal stops automatic continuation"
unlabel='{"action":"unlabeled","number":101,"label":{"name":"bke-worker:worker-a"},"pull_request":{"number":101,"state":"open","head":{"ref":"feat/pr-a","sha":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"},"labels":[]}}'
test "$(send_webhook pull_request delivery-unlabel "$unlabel")" = "202"
for attempt in $(seq 1 30); do
  state="$(curl --fail --silent "$WORKER/control/state")"
  if STATE="$state" python3 - <<'PY'
import json
import os
p = json.loads(os.environ["STATE"])
raise SystemExit(0 if p["state"] == "WAITING_FOR_ASSIGNMENT" and p["assignment"] is None else 1)
PY
  then
    break
  fi
  sleep 1
done

test "$(send_webhook push delivery-after-unlabel "$push")" = "202"
sleep 3
test "$(prompt_count)" = "3"

code="$(curl --silent --output "$ROOT/manual-no-assignment.json" --write-out '%{http_code}' -X POST "$WORKER/control/continue")"
test "$code" = "409"

echo "GITHUB-NATIVE: multi-worker routing and isolation"
bash tests/integration/multi_worker_server.sh

echo "GITHUB-NATIVE SERVER HARNESS: GREEN"
