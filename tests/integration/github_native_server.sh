#!/usr/bin/env bash
set -euo pipefail

FIXTURE=http://127.0.0.1:5094
WORKER=http://127.0.0.1:5084
SECRET=github-native-ci-secret
STATE_FILE="${RUNNER_TEMP:-/tmp}/bke-worker-github-native/state.json"
PROFILE_DIR="${RUNNER_TEMP:-/tmp}/bke-worker-github-native/chatgpt-profile"
WORKER_LOG="${RUNNER_TEMP:-/tmp}/bke-worker-github-native.log"
FIXTURE_LOG="${RUNNER_TEMP:-/tmp}/bke-worker-github-native-fixture.log"
PUBLISHED_DIR="${PUBLISHED_DIR:-artifacts/bke-worker-server}"

mkdir -p "$(dirname "$STATE_FILE")"
rm -f "$STATE_FILE" "$STATE_FILE.tmp"

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
export BKE_WORKER_CHATGPT_PROJECT="BKE Worker"
export BKE_WORKER_CHATGPT_CONVERSATION="Worker Engineering"
export BKE_WORKER_CHATGPT_OVERRIDE_URL=""
export BKE_WORKER_CHATGPT_BASE_URL="$FIXTURE/chatgpt/"
export BKE_WORKER_GITHUB_WEBHOOK_SECRET="$SECRET"
export BKE_WORKER_CHATGPT_PROFILE="$PROFILE_DIR"
export BKE_WORKER_STATE_FILE="$STATE_FILE"
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

send_push() {
  delivery="$1"
  signature_mode="${2:-valid}"
  body='{"ref":"refs/heads/main","after":"0123456789abcdef"}'
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

  curl --silent     --output "${RUNNER_TEMP:-/tmp}/worker-webhook.json"     --write-out '%{http_code}'     -X POST "$WORKER/webhooks/github"     -H 'Content-Type: application/json'     -H 'X-GitHub-Event: push'     -H "X-GitHub-Delivery: $delivery"     -H "X-Hub-Signature-256: $signature"     --data "$body"
}

echo "GITHUB-NATIVE: initial startup dispatch"
wait_prompt_count 1
initial_prompt="$(
  curl --fail --silent "$FIXTURE/admin/state" |
    python3 -c 'import json,sys; print(json.load(sys.stdin)["prompts"][0])'
)"
[[ "$initial_prompt" == *"CONTINUE AUTONOMOUS ENGINEERING"* ]]
[[ "$initial_prompt" == *"fresh branch from current main"* ]]
[[ "$initial_prompt" == *".github/pull_request_template.md"* ]]
[[ "$initial_prompt" != *"Notion"* ]]

summary="$(curl --fail --silent "$WORKER/control/summary")"
SUMMARY="$summary" python3 - <<'PY'
import json
import os
p = json.loads(os.environ["SUMMARY"])
assert p["engineeringAuthority"] == "github", p
assert p["oneIntentPerPullRequest"] is True, p
assert p["freshBranchFromCurrentMain"] is True, p
assert p["heartbeatSeconds"] == 1800, p
assert p["pullRequestTemplate"] == ".github/pull_request_template.md", p
assert "notion" not in json.dumps(p).lower(), p
PY

echo "GITHUB-NATIVE: invalid webhook signature fails closed"
test "$(send_push bad-signature invalid)" = "401"
test "$(prompt_count)" = "1"

echo "GITHUB-NATIVE: signed push wakes exact engineering conversation"
test "$(send_push delivery-1)" = "202"
wait_prompt_count 2

echo "GITHUB-NATIVE: duplicate delivery is idempotent"
test "$(send_push delivery-1)" = "202"
sleep 3
test "$(prompt_count)" = "2"

echo "GITHUB-NATIVE: busy ChatGPT defers push without losing delivery"
curl --fail --silent -X POST "$FIXTURE/admin/busy/on" >/dev/null
test "$(send_push delivery-busy)" = "202"
sleep 6
test "$(prompt_count)" = "2"
state="$(curl --fail --silent "$WORKER/control/state")"
STATE="$state" python3 - <<'PY'
import json
import os
p = json.loads(os.environ["STATE"])
assert p["state"] == "WAITING_FOR_ENGINEERING_EVENT", p
assert p["lastGitHubDeliveryId"] == "delivery-busy", p
PY

echo "GITHUB-NATIVE: explicit manual continue recovers after safe idle"
curl --fail --silent -X POST "$FIXTURE/admin/busy/off" >/dev/null
code="$(curl --silent --output "${RUNNER_TEMP:-/tmp}/manual-continue.json" --write-out '%{http_code}' -X POST "$WORKER/control/continue")"
test "$code" = "202"
wait_prompt_count 3

echo "GITHUB-NATIVE SERVER HARNESS: GREEN"
