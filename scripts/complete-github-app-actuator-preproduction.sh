#!/usr/bin/env bash
set -euo pipefail

REPOSITORY="jan2xo/bke-worker"
WORKFLOW="serial-dispatcher.yml"
CLOUDFLARE_ENV="preproduction"
WRANGLER_VERSION="4.147.0"
BROKER_VARIABLE="BKE_WORKER_GITHUB_APP_BROKER_URL"
CERTIFICATION_ISSUE=55
FROZEN_PR=48
FROZEN_TASKS=(44 45 46)

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

fail() {
  echo "BKE OPERATOR FAIL-CLOSED: $*" >&2
  exit 3
}

require_command() {
  command -v "$1" >/dev/null 2>&1 || fail "required command missing: $1"
}

wrangler() {
  npx --yes "wrangler@${WRANGLER_VERSION}" "$@"
}

ensure_human_auth() {
  if ! gh auth status --hostname github.com >/dev/null 2>&1; then
    echo "GitHub human authentication is required."
    gh auth login --hostname github.com --web
  fi
  gh auth status --hostname github.com >/dev/null 2>&1 ||
    fail "GitHub authentication did not complete"

  if ! wrangler whoami >/dev/null 2>&1; then
    echo "Cloudflare human authentication is required."
    wrangler login
  fi
  wrangler whoami >/dev/null 2>&1 ||
    fail "Cloudflare authentication did not complete"
}

ensure_clean_trusted_main() {
  local top origin local_sha remote_sha

  top="$(git rev-parse --show-toplevel 2>/dev/null || true)"
  [[ "$top" == "$ROOT_DIR" ]] || fail "run this script from the jan2xo/bke-worker checkout"

  origin="$(git remote get-url origin 2>/dev/null || true)"
  [[ "$origin" == *"github.com"* && "$origin" == *"jan2xo/bke-worker"* ]] ||
    fail "origin is not jan2xo/bke-worker"

  [[ -z "$(git status --porcelain)" ]] ||
    fail "working tree is not clean; refusing to change branches or deploy"

  git fetch origin main
  git switch main
  git merge --ff-only origin/main

  local_sha="$(git rev-parse HEAD)"
  remote_sha="$(gh api "repos/$REPOSITORY/commits/main" --jq .sha)"
  [[ "$local_sha" == "$remote_sha" ]] ||
    fail "local main is not exact remote main"

  echo "Trusted main: $local_sha"
}

secret_names() {
  wrangler secret list --env "$CLOUDFLARE_ENV" 2>/dev/null || true
}

ensure_actuator_secrets() {
  local listed app_id pem_path

  listed="$(secret_names)"

  if ! grep -q "BKE_WORKER_GITHUB_APP_ID" <<<"$listed"; then
    read -r -p "GitHub App ID: " app_id
    [[ "$app_id" =~ ^[0-9]+$ ]] || fail "GitHub App ID must be numeric"
    printf '%s' "$app_id" |
      wrangler secret put BKE_WORKER_GITHUB_APP_ID --env "$CLOUDFLARE_ENV" >/dev/null
  fi

  listed="$(secret_names)"
  if ! grep -q "BKE_WORKER_GITHUB_APP_PRIVATE_KEY_PEM" <<<"$listed"; then
    read -r -p "GitHub App private-key PEM path: " pem_path
    pem_path="${pem_path/#\~/$HOME}"
    [[ -f "$pem_path" ]] || fail "private-key PEM file not found"
    chmod 600 "$pem_path"
    cat "$pem_path" |
      wrangler secret put BKE_WORKER_GITHUB_APP_PRIVATE_KEY_PEM --env "$CLOUDFLARE_ENV" >/dev/null
  fi
}

assert_frozen_queue() {
  local number blocked worker_labels

  for number in "${FROZEN_TASKS[@]}"; do
    blocked="$(
      gh issue view "$number" --repo "$REPOSITORY" --json state,labels \
        --jq '(.state == "OPEN") and ([.labels[].name] | index("bke-task:blocked") != null)'
    )"
    [[ "$blocked" == "true" ]] ||
      fail "task #$number is not open+blocked; frozen proof is unsafe"
  done

  worker_labels="$(
    gh pr view "$FROZEN_PR" --repo "$REPOSITORY" --json state,labels \
      --jq 'if .state != "OPEN" then -1 else [.labels[].name | select(startswith("bke-worker:"))] | length end'
  )"
  [[ "$worker_labels" == "0" ]] ||
    fail "PR #$FROZEN_PR is not open+unassigned; frozen proof is unsafe"
}

snapshot_open_prs() {
  gh pr list --repo "$REPOSITORY" --state open --limit 500 \
    --json number,headRefName,labels \
    --jq '.[] | "\(.number)\t\(.headRefName)\t\([.labels[].name] | sort | join(","))"' |
    LC_ALL=C sort
}

ensure_broker_variable() {
  local broker_url="${1:-}"
  if [[ -z "$broker_url" ]]; then
    broker_url="$(gh variable get "$BROKER_VARIABLE" --repo "$REPOSITORY" 2>/dev/null || true)"
  fi

  if [[ -z "$broker_url" ]]; then
    read -r -p "PREPRODUCTION Worker origin (https://...workers.dev): " broker_url
    [[ "$broker_url" =~ ^https://[^/]+$ ]] ||
      fail "broker origin must be HTTPS origin only"
    gh variable set "$BROKER_VARIABLE" --repo "$REPOSITORY" --body "$broker_url"
  fi

  [[ "$broker_url" =~ ^https://[^/]+$ ]] ||
    fail "configured broker URL is invalid"

  printf '%s' "$broker_url"
}

main() {
  local deploy_log broker_url endpoint_status before_run_id run_id candidate
  local proof_log before_heads after_heads before_prs after_prs main_sha

  for cmd in git gh npx curl grep cmp mktemp tee; do
    require_command "$cmd"
  done

  echo "BKE WORKER — GITHUB APP ACTUATOR PREPRODUCTION"
  echo "One command owns discovery, execution, verification, and checkpointing."
  echo

  ensure_human_auth
  ensure_clean_trusted_main
  ensure_actuator_secrets
  assert_frozen_queue

  before_heads="$(mktemp)"
  after_heads="$(mktemp)"
  before_prs="$(mktemp)"
  after_prs="$(mktemp)"
  deploy_log="$(mktemp)"
  proof_log="$(mktemp)"
  trap 'rm -f "$before_heads" "$after_heads" "$before_prs" "$after_prs" "$deploy_log" "$proof_log"' EXIT

  git ls-remote --heads origin | LC_ALL=C sort >"$before_heads"
  snapshot_open_prs >"$before_prs"

  echo
  echo "Deploying Cloudflare PREPRODUCTION..."
  wrangler deploy --env "$CLOUDFLARE_ENV" 2>&1 | tee "$deploy_log"

  broker_url="$(ensure_broker_variable)"
  endpoint_status="$(
    curl --silent --show-error --output /dev/null --write-out '%{http_code}' \
      "${broker_url%/}/github/app/install-token" || true
  )"
  [[ "$endpoint_status" == "405" ]] ||
    fail "broker endpoint did not return expected GET=405 (got $endpoint_status)"

  assert_frozen_queue

  before_run_id="$(
    gh run list --repo "$REPOSITORY" --workflow "$WORKFLOW" --event workflow_dispatch \
      --limit 1 --json databaseId --jq '.[0].databaseId // 0'
  )"

  echo
  echo "Triggering remote frozen-queue certification..."
  gh workflow run "$WORKFLOW" --repo "$REPOSITORY" --ref main

  run_id=""
  for _ in {1..30}; do
    candidate="$(
      gh run list --repo "$REPOSITORY" --workflow "$WORKFLOW" --event workflow_dispatch \
        --limit 1 --json databaseId --jq '.[0].databaseId // 0'
    )"
    if [[ "$candidate" != "0" && "$candidate" != "$before_run_id" ]]; then
      run_id="$candidate"
      break
    fi
    sleep 2
  done
  [[ -n "$run_id" ]] || fail "could not identify the new workflow_dispatch run"

  if ! gh run watch "$run_id" --repo "$REPOSITORY" --exit-status; then
    gh run view "$run_id" --repo "$REPOSITORY" --log-failed || true
    fail "remote dispatcher proof failed (run $run_id)"
  fi

  gh run view "$run_id" --repo "$REPOSITORY" --log >"$proof_log"

  grep -Fq "BKE GitHub App installation token minted;" "$proof_log" ||
    fail "run passed without visible App-token mint evidence"
  grep -Fq '{"reason": "NO_RUNNABLE_TASK", "state": "WAITING"}' "$proof_log" ||
    fail "run did not prove WAITING / NO_RUNNABLE_TASK"

  git ls-remote --heads origin | LC_ALL=C sort >"$after_heads"
  snapshot_open_prs >"$after_prs"

  cmp -s "$before_heads" "$after_heads" ||
    fail "branch refs changed during frozen proof"
  cmp -s "$before_prs" "$after_prs" ||
    fail "open PR/label state changed during frozen proof"

  assert_frozen_queue

  main_sha="$(gh api "repos/$REPOSITORY/commits/main" --jq .sha)"
  gh issue comment "$CERTIFICATION_ISSUE" --repo "$REPOSITORY" --body "$(
    cat <<EOF
BKE LOCAL CERTIFICATION F — ONE-COMMAND OPERATOR PROOF PASS

- current main: \`$main_sha\`
- Serial Master Queue Dispatcher run: \`$run_id\`
- GitHub Actions OIDC -> Cloudflare PREPRODUCTION broker: PASS
- BKE GitHub App installation token mint: PASS
- dispatcher: \`WAITING / NO_RUNNABLE_TASK\`
- frozen queue preserved: #44/#45/#46 remain blocked
- PR #48 remains unassigned
- branch refs unchanged
- open PR/worker-label snapshot unchanged
- production remains LOCKED

No secret material is recorded in this checkpoint.
EOF
  )"

  echo
  echo "BKE GITHUB APP ACTUATOR CERTIFICATION: PASS"
  echo "Run ID: $run_id"
  echo "State: WAITING / NO_RUNNABLE_TASK"
  echo "Mutation check: NO branch / PR / worker-assignment change"
  echo "Production: LOCKED"
}

main "$@"
