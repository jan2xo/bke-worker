#!/usr/bin/env bash
set -euo pipefail

REPOSITORY="jan2xo/bke-worker"
PARENT_PR=52

fail() {
  echo "BKE ANDROID RECOVERY RUNNER: FAIL-CLOSED — $*" >&2
  exit 1
}

for command_name in git gh python3 bash; do
  command -v "$command_name" >/dev/null 2>&1 || fail "required command missing: $command_name"
done

gh auth status --hostname github.com >/dev/null 2>&1 ||
  fail "GitHub CLI authentication is required"

ROOT_DIR="$(git rev-parse --show-toplevel 2>/dev/null || true)"
[[ -n "$ROOT_DIR" ]] || fail "run this script from a BKE Worker checkout"

HEAD_REF="$(gh pr view "$PARENT_PR" --repo "$REPOSITORY" --json headRefName --jq .headRefName)"
PARENT_HEAD="$(gh pr view "$PARENT_PR" --repo "$REPOSITORY" --json headRefOid --jq .headRefOid)"
[[ -n "$HEAD_REF" ]] || fail "unable to resolve PR branch"
[[ "$PARENT_HEAD" =~ ^[0-9a-f]{40}$ ]] || fail "unable to resolve exact PR head"

CURRENT_BRANCH="$(git -C "$ROOT_DIR" branch --show-current)"
[[ "$CURRENT_BRANCH" == "$HEAD_REF" ]] || fail "checkout PR branch $HEAD_REF first"
[[ -z "$(git -C "$ROOT_DIR" status --porcelain --untracked-files=no)" ]] ||
  fail "tracked local changes exist; refusing automatic sync"

START_HEAD="$(git -C "$ROOT_DIR" rev-parse HEAD)"
git -C "$ROOT_DIR" pull --ff-only origin "$HEAD_REF"
SYNCED_HEAD="$(git -C "$ROOT_DIR" rev-parse HEAD)"
[[ "$SYNCED_HEAD" == "$PARENT_HEAD" ]] || fail "local branch did not converge to exact PR head"

if [[ "$START_HEAD" != "$SYNCED_HEAD" && "${BKE_ANDROID_RECOVERY_RUNNER_SYNCED:-0}" != "1" ]]; then
  echo "BKE RUNNER: synced to new exact head; reloading the exact-head runner."
  BKE_ANDROID_RECOVERY_RUNNER_SYNCED=1 exec bash "$ROOT_DIR/scripts/run-android-recovery-certification.sh"
fi

verify_recovery_run() {
  local run_id="$1"
  local run_json
  run_json="$(gh run view "$run_id" --repo "$REPOSITORY" --json headSha,conclusion,event,jobs)"
  RUN_JSON="$run_json" python3 - "$PARENT_HEAD" <<'PY'
import json
import os
import sys

head = sys.argv[1]
run = json.loads(os.environ["RUN_JSON"])
if run.get("headSha") != head or run.get("conclusion") != "success" or run.get("event") != "workflow_dispatch":
    raise SystemExit(1)
jobs = {job.get("name"): job.get("conclusion") for job in run.get("jobs", [])}
for name in ("Android recovery local contract", "Required certification"):
    if jobs.get(name) != "success":
        raise SystemExit(1)
PY
}

resolve_successful_run() {
  local runs_json candidate_id
  runs_json="$(gh run list --repo "$REPOSITORY" --workflow certify.yml --branch "$HEAD_REF" --event workflow_dispatch --limit 50 --json databaseId,headSha,conclusion,createdAt)"
  while IFS= read -r candidate_id; do
    [[ "$candidate_id" =~ ^[0-9]+$ ]] || continue
    if verify_recovery_run "$candidate_id" >/dev/null 2>&1; then
      printf '%s\n' "$candidate_id"
      return 0
    fi
  done < <(
    RUNS_JSON="$runs_json" python3 - "$PARENT_HEAD" <<'PY'
import json
import os
import sys

head = sys.argv[1]
runs = json.loads(os.environ["RUNS_JSON"])
for run in sorted(runs, key=lambda item: item.get("createdAt", ""), reverse=True):
    if run.get("headSha") == head and run.get("conclusion") == "success":
        print(run["databaseId"])
PY
  )
  return 1
}

resolve_new_run() {
  local before_ids="$1"
  local started runs_json run_id
  started="$(date +%s)"
  while (( $(date +%s) - started < 90 )); do
    runs_json="$(gh run list --repo "$REPOSITORY" --workflow certify.yml --branch "$HEAD_REF" --event workflow_dispatch --limit 50 --json databaseId,headSha,createdAt)"
    run_id="$(
      BEFORE_IDS="$before_ids" RUNS_JSON="$runs_json" PARENT_HEAD="$PARENT_HEAD" python3 - <<'PY'
import json
import os

before = {line.strip() for line in os.environ.get("BEFORE_IDS", "").splitlines() if line.strip()}
head = os.environ["PARENT_HEAD"]
runs = json.loads(os.environ["RUNS_JSON"])
matches = [
    run for run in runs
    if str(run.get("databaseId")) not in before and run.get("headSha") == head
]
matches.sort(key=lambda run: run.get("createdAt", ""), reverse=True)
if matches:
    print(matches[0]["databaseId"])
PY
    )"
    if [[ "$run_id" =~ ^[0-9]+$ ]]; then
      printf '%s\n' "$run_id"
      return 0
    fi
    sleep 2
  done
  return 1
}

RUN_ID=""
if RUN_ID="$(resolve_successful_run)"; then
  echo "BKE RUNNER: reusing exact-head android-recovery run $RUN_ID."
else
  BEFORE_IDS="$(gh run list --repo "$REPOSITORY" --workflow certify.yml --branch "$HEAD_REF" --event workflow_dispatch --limit 50 --json databaseId --jq '.[].databaseId')"
  echo "BKE RUNNER: dispatching exact-head android-recovery CI."
  gh workflow run certify.yml --repo "$REPOSITORY" --ref "$HEAD_REF" -f source_sha="$PARENT_HEAD" -f modules=android-recovery -f publish_preproduction=false

  RUN_ID="$(resolve_new_run "$BEFORE_IDS")" || fail "unable to resolve newly dispatched recovery run"
  gh run watch "$RUN_ID" --repo "$REPOSITORY" --exit-status || fail "android-recovery workflow failed"
  verify_recovery_run "$RUN_ID" || fail "android-recovery workflow did not satisfy exact-head authority"
fi

OUTPUT_ROOT="${BKE_ANDROID_RECOVERY_LOCAL_OUTPUT_ROOT:-$ROOT_DIR/artifacts/android-recovery-local}"
BUILD_DIR="$OUTPUT_ROOT/$PARENT_HEAD"
APK="$(find "$BUILD_DIR" -maxdepth 1 -type f -name '*.apk' -print -quit 2>/dev/null || true)"
if [[ -z "$APK" || ! -f "$BUILD_DIR/manifest.json" ]]; then
  echo "BKE RUNNER: building missing exact-head recovery APK."
  BKE_ANDROID_RECOVERY_EXPECTED_SHA="$PARENT_HEAD" BKE_ANDROID_RECOVERY_LOCAL_OUTPUT_ROOT="$OUTPUT_ROOT" bash "$ROOT_DIR/scripts/build-android-recovery-local.sh"
else
  echo "BKE RUNNER: reusing exact-head local recovery APK."
fi

echo "BKE RUNNER: starting live recovery ceremony."
BKE_ANDROID_RECOVERY_TRUSTED_WORKTREE=1 BKE_ANDROID_RECOVERY_LOCAL_OUTPUT_ROOT="$OUTPUT_ROOT" exec bash "$ROOT_DIR/scripts/certify-android-chat-target-recovery.sh"
