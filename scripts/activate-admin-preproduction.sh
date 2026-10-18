#!/usr/bin/env bash
set -euo pipefail
# Trusted-main, PREPRODUCTION-only operator entrypoint.
REPO="jan2xo/bke-worker"
COMMAND_REPO="jan2xo/bke-command-center"
ENTRY_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
for command_name in git gh node npm npx; do
  command -v "$command_name" >/dev/null 2>&1 || {
    printf 'BKE ADMIN: BLOCKED missing %s\n' "$command_name" >&2
    exit 2
  }
done
[[ "$(git -C "$ENTRY_DIR" rev-parse --show-toplevel 2>/dev/null)" == "$ENTRY_DIR" ]] ||
  { echo "BKE ADMIN: FAIL-CLOSED wrong repository root" >&2; exit 2; }
ORIGIN="$(git -C "$ENTRY_DIR" remote get-url origin)"
case "$ORIGIN" in
  "https://github.com/$REPO.git"|"https://github.com/$REPO"|"git@github.com:$REPO.git") ;;
  *) echo "BKE ADMIN: FAIL-CLOSED noncanonical origin" >&2; exit 2;;
esac
if ! gh auth status --hostname github.com >/dev/null 2>&1; then
  echo "BKE ADMIN: Official GitHub login required (human-controlled)."
  gh auth login --hostname github.com --web
fi
git -C "$ENTRY_DIR" fetch origin main --quiet
REMOTE_SHA="$(gh api "repos/$REPO/commits/main" --jq .sha)"
[[ "$REMOTE_SHA" =~ ^[a-f0-9]{40}$ ]] ||
  { echo "BKE ADMIN: BLOCKED GitHub main unavailable"; exit 2; }
[[ "$(git -C "$ENTRY_DIR" rev-parse refs/remotes/origin/main)" == "$REMOTE_SHA" ]] ||
  { echo "BKE ADMIN: FAIL-CLOSED fetched source differs from GitHub main"; exit 2; }
ROOT_TMP="$(mktemp -d "${TMPDIR:-/tmp}/bke-admin-preproduction.XXXXXX")"
WORKTREE="$ROOT_TMP/worker"
cleanup() {
  git -C "$ENTRY_DIR" worktree remove --force "$WORKTREE" >/dev/null 2>&1 || true
  if [[ -n "${ROOT_TMP:-}" && "$ROOT_TMP" == *"/bke-admin-preproduction."* ]]; then
    rm -rf -- "$ROOT_TMP"
  fi
}
trap cleanup EXIT
git -C "$ENTRY_DIR" worktree add --detach "$WORKTREE" "$REMOTE_SHA" --quiet
[[ "$(git -C "$WORKTREE" rev-parse HEAD)" == "$REMOTE_SHA" ]] ||
  { echo "BKE ADMIN: FAIL-CLOSED isolated Worker checkout wrong SHA"; exit 2; }
gh repo clone "$COMMAND_REPO" "$ROOT_TMP/command-center" -- --branch main --single-branch --quiet
COMMAND_SHA="$(gh api "repos/$COMMAND_REPO/commits/main" --jq .sha)"
[[ "$COMMAND_SHA" =~ ^[a-f0-9]{40}$ ]] ||
  { echo "BKE ADMIN: BLOCKED Command Center main unavailable"; exit 2; }
[[ "$(git -C "$ROOT_TMP/command-center" rev-parse HEAD)" == "$COMMAND_SHA" ]] ||
  { echo "BKE ADMIN: FAIL-CLOSED Command Center source is stale"; exit 2; }
[[ -z "$(git -C "$ROOT_TMP/command-center" status --porcelain)" ]] ||
  { echo "BKE ADMIN: FAIL-CLOSED Command Center checkout dirty"; exit 2; }
[[ -z "$(git -C "$WORKTREE" status --porcelain)" ]] ||
  { echo "BKE ADMIN: FAIL-CLOSED Worker checkout dirty"; exit 2; }
node "$WORKTREE/scripts/admin_preproduction_activation.mjs" \
  "$WORKTREE" "$ROOT_TMP/command-center" "$REMOTE_SHA" "$COMMAND_SHA"
