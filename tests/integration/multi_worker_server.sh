#!/usr/bin/env bash
set -euo pipefail

ROOT="${RUNNER_TEMP:-/tmp}/bke-worker-multi"
PUBLISHED_DIR="${PUBLISHED_DIR:-artifacts/bke-worker-server}"
SECRET=multi-worker-ci-secret
LOCK_DIR="$ROOT/locks"
FIXTURE_A=http://127.0.0.1:5194
FIXTURE_B=http://127.0.0.1:5195
WORKER_A=http://127.0.0.1:5184
WORKER_B=http://127.0.0.1:5185

rm -rf "$ROOT"
mkdir -p "$ROOT/state" "$ROOT/profiles" "$LOCK_DIR"

python3 tests/integration/phase3_fixture.py --port 5194 > "$ROOT/fixture-a.log" 2>&1 &
FIXTURE_A_PID=$!
python3 tests/integration/phase3_fixture.py --port 5195 > "$ROOT/fixture-b.log" 2>&1 &
FIXTURE_B_PID=$!
WORKER_A_PID=""
WORKER_B_PID=""

cleanup() {
  for pid in "${WORKER_A_PID:-}" "${WORKER_B_PID:-}" "$FIXTURE_A_PID" "$FIXTURE_B_PID"; do
    if [[ -n "$pid" ]]; then
      kill "$pid" 2>/dev/null || true
      wait "$pid" 2>/dev/null || true
    fi
  done
}
trap cleanup EXIT

for url in "$FIXTURE_A/fixture-health" "$FIXTURE_B/fixture-health"; do
  for attempt in $(seq 1 30); do
    curl --fail --silent "$url" >/dev/null && break
    sleep 1
  done
  curl --fail --silent "$url" >/dev/null
done

start_worker() {
  worker_id="$1"
  listen="$2"
  fixture="$3"
  state="$4"
  profile="$5"
  log="$6"

  env \
    ASPNETCORE_URLS="$listen" \
    BKE_WORKER_ID="$worker_id" \
    BKE_WORKER_CHATGPT_PROJECT="BKE Worker" \
    BKE_WORKER_CHATGPT_CONVERSATION="Worker Engineering" \
    BKE_WORKER_CHATGPT_OVERRIDE_URL="" \
    BKE_WORKER_CHATGPT_BASE_URL="$fixture/chatgpt/" \
    BKE_WORKER_GITHUB_WEBHOOK_SECRET="$SECRET" \
    BKE_WORKER_CHATGPT_PROFILE="$profile" \
    BKE_WORKER_STATE_FILE="$state" \
    BKE_WORKER_RESOURCE_LOCK_DIRECTORY="$LOCK_DIR" \
    BKE_WORKER_HEADLESS=true \
    BKE_WORKER_WEBHOOK_DEBOUNCE_SECONDS=1 \
    BKE_WORKER_HEARTBEAT_SECONDS=1800 \
    BKE_WORKER_MIN_DISPATCH_SECONDS=1 \
    dotnet "$PUBLISHED_DIR/BKE.Worker.Server.dll" > "$log" 2>&1 &
  STARTED_PID=$!
}

start_worker worker-a "$WORKER_A" "$FIXTURE_A" "$ROOT/state/a.json" "$ROOT/profiles/a" "$ROOT/worker-a.log"
WORKER_A_PID=$STARTED_PID
start_worker worker-b "$WORKER_B" "$FIXTURE_B" "$ROOT/state/b.json" "$ROOT/profiles/b" "$ROOT/worker-b.log"
WORKER_B_PID=$STARTED_PID

for pair in "$WORKER_A|$WORKER_A_PID|$ROOT/worker-a.log" "$WORKER_B|$WORKER_B_PID|$ROOT/worker-b.log"; do
  IFS='|' read -r url pid log <<< "$pair"
  for attempt in $(seq 1 40); do
    if curl --fail --silent "$url/health/ready" >/dev/null; then
      break
    fi
    if ! kill -0 "$pid" 2>/dev/null; then
      cat "$log"
      exit 1
    fi
    sleep 1
  done
  curl --fail --silent "$url/health/ready" >/dev/null
done

prompt_count() {
  fixture="$1"
  curl --fail --silent "$fixture/admin/state" |
    python3 -c 'import json,sys; print(len(json.load(sys.stdin)["prompts"]))'
}

wait_counts() {
  expected_a="$1"
  expected_b="$2"
  for attempt in $(seq 1 40); do
    if [[ "$(prompt_count "$FIXTURE_A")" == "$expected_a" &&
          "$(prompt_count "$FIXTURE_B")" == "$expected_b" ]]; then
      return 0
    fi
    sleep 1
  done
  echo "expected prompts A=$expected_a B=$expected_b; got A=$(prompt_count "$FIXTURE_A") B=$(prompt_count "$FIXTURE_B")" >&2
  cat "$ROOT/worker-a.log" >&2
  cat "$ROOT/worker-b.log" >&2
  return 1
}

send_webhook() {
  worker="$1"
  event="$2"
  delivery="$3"
  body="$4"
  outfile="$5"
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

  curl --silent \
    --output "$outfile" \
    --write-out '%{http_code}' \
    -X POST "$worker/webhooks/github" \
    -H 'Content-Type: application/json' \
    -H "X-GitHub-Event: $event" \
    -H "X-GitHub-Delivery: $delivery" \
    -H "X-Hub-Signature-256: $signature" \
    --data "$body"
}

test "$(prompt_count "$FIXTURE_A")" = "0"
test "$(prompt_count "$FIXTURE_B")" = "0"

pr_a='{"action":"labeled","number":101,"label":{"name":"bke-worker:worker-a"},"pull_request":{"number":101,"state":"open","head":{"ref":"feat/pr-a","sha":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"},"labels":[{"name":"bke-worker:worker-a"}]}}'
pr_b='{"action":"labeled","number":202,"label":{"name":"bke-worker:worker-b"},"pull_request":{"number":202,"state":"open","head":{"ref":"feat/pr-b","sha":"bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"},"labels":[{"name":"bke-worker:worker-b"}]}}'

echo "MULTI-WORKER: PR A routes only to worker A"
test "$(send_webhook "$WORKER_A" pull_request a-assign "$pr_a" "$ROOT/a-assign-a.json")" = "202"
test "$(send_webhook "$WORKER_B" pull_request a-assign "$pr_a" "$ROOT/a-assign-b.json")" = "202"
wait_counts 1 0

echo "MULTI-WORKER: PR B routes only to worker B"
test "$(send_webhook "$WORKER_A" pull_request b-assign "$pr_b" "$ROOT/b-assign-a.json")" = "202"
test "$(send_webhook "$WORKER_B" pull_request b-assign "$pr_b" "$ROOT/b-assign-b.json")" = "202"
wait_counts 1 1

prompt_a="$(
  curl --fail --silent "$FIXTURE_A/admin/state" |
    python3 -c 'import json,sys; print(json.load(sys.stdin)["prompts"][0])'
)"
prompt_b="$(
  curl --fail --silent "$FIXTURE_B/admin/state" |
    python3 -c 'import json,sys; print(json.load(sys.stdin)["prompts"][0])'
)"
[[ "$prompt_a" == *"worker_id=worker-a"* ]]
[[ "$prompt_a" == *"assigned PR #101"* ]]
[[ "$prompt_b" == *"worker_id=worker-b"* ]]
[[ "$prompt_b" == *"assigned PR #202"* ]]

echo "MULTI-WORKER: concurrent branch wakes do not cross-talk"
push_a='{"ref":"refs/heads/feat/pr-a","after":"cccccccccccccccccccccccccccccccccccccccc"}'
push_b='{"ref":"refs/heads/feat/pr-b","after":"dddddddddddddddddddddddddddddddddddddddd"}'
send_webhook "$WORKER_A" push a-push "$push_a" "$ROOT/a-push-a.json" > "$ROOT/a-push-a.code" &
p1=$!
send_webhook "$WORKER_B" push a-push "$push_a" "$ROOT/a-push-b.json" > "$ROOT/a-push-b.code" &
p2=$!
send_webhook "$WORKER_A" push b-push "$push_b" "$ROOT/b-push-a.json" > "$ROOT/b-push-a.code" &
p3=$!
send_webhook "$WORKER_B" push b-push "$push_b" "$ROOT/b-push-b.json" > "$ROOT/b-push-b.code" &
p4=$!
wait "$p1" "$p2" "$p3" "$p4"
test "$(cat "$ROOT/a-push-a.code")" = "202"
test "$(cat "$ROOT/a-push-b.code")" = "202"
test "$(cat "$ROOT/b-push-a.code")" = "202"
test "$(cat "$ROOT/b-push-b.code")" = "202"
wait_counts 2 2

echo "MULTI-WORKER: same ChatGPT target resource cannot be shared"
env \
  ASPNETCORE_URLS=http://127.0.0.1:5186 \
  BKE_WORKER_ID=worker-c \
  BKE_WORKER_CHATGPT_PROJECT="BKE Worker" \
  BKE_WORKER_CHATGPT_CONVERSATION="Worker Engineering" \
  BKE_WORKER_CHATGPT_OVERRIDE_URL="" \
  BKE_WORKER_CHATGPT_BASE_URL="$FIXTURE_A/chatgpt/" \
  BKE_WORKER_GITHUB_WEBHOOK_SECRET="$SECRET" \
  BKE_WORKER_CHATGPT_PROFILE="$ROOT/profiles/c" \
  BKE_WORKER_STATE_FILE="$ROOT/state/c.json" \
  BKE_WORKER_RESOURCE_LOCK_DIRECTORY="$LOCK_DIR" \
  BKE_WORKER_HEADLESS=true \
  BKE_WORKER_HEARTBEAT_SECONDS=1800 \
  dotnet "$PUBLISHED_DIR/BKE.Worker.Server.dll" > "$ROOT/worker-c.log" 2>&1 &
WORKER_C_PID=$!
for attempt in $(seq 1 20); do
  if ! kill -0 "$WORKER_C_PID" 2>/dev/null; then
    break
  fi
  sleep 1
done
if kill -0 "$WORKER_C_PID" 2>/dev/null; then
  echo "worker-c unexpectedly stayed alive with shared ChatGPT target" >&2
  kill "$WORKER_C_PID" 2>/dev/null || true
  wait "$WORKER_C_PID" 2>/dev/null || true
  exit 1
fi
wait "$WORKER_C_PID" 2>/dev/null || true
grep -q 'WORKER_RESOURCE_IN_USE:chatgpt-target' "$ROOT/worker-c.log"

echo "MULTI-WORKER: duplicate active PR ownership blocks worker A"
pr_a_second='{"action":"labeled","number":303,"label":{"name":"bke-worker:worker-a"},"pull_request":{"number":303,"state":"open","head":{"ref":"feat/pr-c","sha":"eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee"},"labels":[{"name":"bke-worker:worker-a"}]}}'
test "$(send_webhook "$WORKER_A" pull_request a-second "$pr_a_second" "$ROOT/a-second.json")" = "202"
for attempt in $(seq 1 30); do
  state="$(curl --fail --silent "$WORKER_A/control/state")"
  if STATE="$state" python3 - <<'PY'
import json
import os
p = json.loads(os.environ["STATE"])
raise SystemExit(0 if p["state"] == "BLOCKED" and p["failure"] == "WORKER_ALREADY_ASSIGNED_TO_DIFFERENT_PR" else 1)
PY
  then
    break
  fi
  sleep 1
done
test "$(prompt_count "$FIXTURE_A")" = "2"

echo "MULTI-WORKER: ambiguous PR labels block every claimed worker"
ambiguous='{"action":"labeled","number":404,"label":{"name":"bke-worker:worker-b"},"pull_request":{"number":404,"state":"open","head":{"ref":"feat/pr-d","sha":"ffffffffffffffffffffffffffffffffffffffff"},"labels":[{"name":"bke-worker:worker-a"},{"name":"bke-worker:worker-b"}]}}'
test "$(send_webhook "$WORKER_A" pull_request ambiguous-a "$ambiguous" "$ROOT/ambiguous-a.json")" = "409"
test "$(send_webhook "$WORKER_B" pull_request ambiguous-b "$ambiguous" "$ROOT/ambiguous-b.json")" = "409"
for worker in "$WORKER_A" "$WORKER_B"; do
  for attempt in $(seq 1 30); do
    state="$(curl --fail --silent "$worker/control/state")"
    if STATE="$state" python3 - <<'PY'
import json
import os
p = json.loads(os.environ["STATE"])
raise SystemExit(0 if p["state"] == "BLOCKED" and p["failure"] == "AMBIGUOUS_PR_ASSIGNMENT" else 1)
PY
    then
      break
    fi
    sleep 1
  done
done
wait_counts 2 2

echo "MULTI-WORKER SERVER HARNESS: GREEN"
