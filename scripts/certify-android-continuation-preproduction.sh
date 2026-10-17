#!/usr/bin/env bash
set -euo pipefail

# One bounded owner gate for the existing Android worker. No production.
REPO="jan2xo/bke-worker"
WORKER="android-worker-a"
LABEL="bke-worker:android-worker-a"
MARKER="BKE ANDROID CONTINUATION CERTIFICATION"

fail() { echo "BKE LIVE ANDROID: FAIL-CLOSED — $*" >&2; exit 3; }
for command_name in git gh python3; do
  command -v "$command_name" >/dev/null 2>&1 || fail "missing $command_name"
done

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd -P)"
ROOT="$(git -C "$SCRIPT_DIR/.." rev-parse --show-toplevel 2>/dev/null || true)"
[[ -n "$ROOT" ]] || fail "script is not running inside its repository"
ROOT="$(cd "$ROOT" && pwd -P)"
cd "$ROOT"
origin="$(git remote get-url origin 2>/dev/null || true)"
[[ "$origin" =~ ^(https://github\.com/|git@github\.com:|ssh://git@github\.com/)jan2xo/bke-worker(\.git)?/?$ ]] ||
  fail "origin does not match jan2xo/bke-worker"

if ! gh auth status --hostname github.com >/dev/null 2>&1; then
  echo "Human authentication required. Opening the official GitHub CLI browser flow."
  gh auth login --hostname github.com --web
fi
gh auth status --hostname github.com >/dev/null 2>&1 || fail "GitHub authentication unavailable"

git fetch origin main >/dev/null
main_sha="$(git rev-parse refs/remotes/origin/main)"
api_sha="$(gh api "repos/$REPO/commits/main" --jq .sha)"
[[ "$main_sha" == "$api_sha" ]] || fail "GitHub main/fetched main mismatch"
[[ "$(git rev-parse HEAD)" == "$main_sha" ]] ||
  fail "use a trusted exact-main checkout; local branch is not current main"
[[ -z "$(git status --porcelain)" ]] ||
  fail "checkout is dirty; use a clean isolated worktree of current main"

# One explicitly created, unassigned, draft certification PR only.
target="$(gh pr list --repo "$REPO" --state open --limit 500 \
  --json number,title,body,isDraft,baseRefName,headRefOid,labels |
  CERT_MARKER="$MARKER" python3 -c '
import json,os,sys
items=json.load(sys.stdin)
matches=[p for p in items if os.environ["CERT_MARKER"] in (p.get("body") or "")]
if len(items)>=500 or len(matches)!=1: sys.exit("CERTIFICATION_TARGET_AMBIGUOUS")
p=matches[0]
if p["title"]!="certify: Android single-worker live 30-minute continuation": sys.exit("CERTIFICATION_TITLE_MISMATCH")
if not p["isDraft"] or p["baseRefName"]!="main": sys.exit("CERTIFICATION_PR_NOT_DRAFT_MAIN")
if any(l["name"].startswith("bke-worker:") for l in p["labels"]): sys.exit("CERTIFICATION_PR_ALREADY_OWNED")
print(str(p["number"])+" "+p["headRefOid"])
')" || fail "no unique, safe certification PR is available"
read -r number head_sha <<< "$target"
[[ "$number" =~ ^[0-9]+$ && "$head_sha" =~ ^[0-9a-f]{40}$ ]] ||
  fail "invalid certification PR identity"

# It is unsafe to awaken a worker on a PR containing runtime/code changes.
files="$(gh pr view "$number" --repo "$REPO" --json files --jq '[.files[].path] | join(",")')"
[[ "$files" == "docs/live-certification/android-single-worker-continuation-acceptance.md" ]] ||
  fail "certification PR has unexpected changed files"

ownership_query="user:jan2xo is:pr is:open label:$LABEL"
count="$(gh api -X GET search/issues -f q="$ownership_query" --jq .total_count)"
[[ "$count" == "0" ]] || fail "worker is already assigned somewhere (count=$count)"

[[ -t 0 ]] || fail "owner must personally verify Android readiness"
echo
echo "Single-worker PREPRODUCTION certification: PR #$number / $head_sha"
echo "On the existing Android app, personally verify:"
echo "  BROWSER: ATTACHED"
echo "  CHAT: READY, human-authenticated"
echo "  RELAY: CONNECTED"
echo "  Worker ID: $WORKER; no second active session with this identity"
echo "Do not uninstall/reinstall, disclose tokens, or automate login."
read -r -p "Type ARM-android-worker-a to issue ONE GitHub label/wake: " answer
[[ "$answer" == "ARM-android-worker-a" ]] ||
  fail "human/device gate not satisfied"

[[ "$(gh pr view "$number" --repo "$REPO" --json headRefOid --jq .headRefOid)" == "$head_sha" ]] ||
  fail "PR head moved"
[[ "$(gh api -X GET search/issues -f q="$ownership_query" --jq .total_count)" == "0" ]] ||
  fail "worker assignment changed"

gh issue comment "$number" --repo "$REPO" --body "BKE LIVE CERTIFICATION — HUMAN PREFLIGHT ONLY
PR head: $head_sha
main: $main_sha
worker: $WORKER
Operator personally observed BROWSER ATTACHED / CHAT READY / RELAY CONNECTED and no duplicate identity. This is an operator assertion, NOT independent device telemetry.
Next: one metadata-only assignment wake, followed by real 30-minute continuation evidence.
No LIVE PASS claimed. Production locked."

gh pr edit "$number" --repo "$REPO" --add-label "$LABEL" ||
  fail "label outcome unknown — inspect GitHub before retry"
# A single-owner result is necessary but not sufficient to prove a live delivery.
owned="$(gh api -X GET search/issues -f q="$ownership_query" \
  --jq '[.items[] | select(.repository_url=="https://api.github.com/repos/jan2xo/bke-worker")] | .[].number')"
[[ "$owned" == "$number" ]] ||
  fail "post-label worker ownership ambiguous — do not retry"
echo "ARMED / NOT CERTIFIED. Wait for actual PR progress and lease evidence on GitHub."
echo "https://github.com/$REPO/pull/$number"