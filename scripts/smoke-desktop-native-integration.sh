#!/usr/bin/env bash
set -euo pipefail

fail() {
  printf 'BKE desktop native smoke BLOCKED: %s\n' "$1" >&2
  exit 2
}

script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
repo_root="$(git -C "$script_dir" rev-parse --show-toplevel 2>/dev/null)" || fail "not_inside_git_repository"
origin_url="$(git -C "$repo_root" remote get-url origin 2>/dev/null)" || fail "origin_remote_missing"
case "$origin_url" in
  https://github.com/jan2xo/bke-worker|https://github.com/jan2xo/bke-worker.git|git@github.com:jan2xo/bke-worker.git|ssh://git@github.com/jan2xo/bke-worker.git) ;;
  *) fail "origin_is_not_canonical_jan2xo_bke_worker" ;;
esac

command -v git >/dev/null 2>&1 || fail "git_not_found"
command -v node >/dev/null 2>&1 || fail "node_not_found"
command -v npm >/dev/null 2>&1 || fail "npm_not_found"
node -e 'if (Number(process.versions.node.split(".")[0]) < 22) process.exit(2)' \
  || fail "node_22_or_newer_required"
case "$(uname -s)" in
  Linux|Darwin) ;;
  *) fail "native_host_contract_not_certified_on_this_operating_system" ;;
esac

git -C "$repo_root" fetch --quiet origin main || fail "unable_to_fetch_origin_main"
main_sha="$(git -C "$repo_root" rev-parse --verify FETCH_HEAD 2>/dev/null)" \
  || fail "fetched_main_sha_unavailable"
[[ "$main_sha" =~ ^[0-9a-f]{40}$ ]] || fail "fetched_main_sha_invalid"

temporary_root="$(mktemp -d "${TMPDIR:-/tmp}/bke-desktop-native-smoke.XXXXXX")" \
  || fail "temporary_worktree_creation_failed"
worktree="$temporary_root/source"
report_dir="$repo_root/artifacts/desktop-native-smoke"
report="$report_dir/$(date -u +%Y%m%dT%H%M%SZ)-${main_sha:0:12}.json"

cleanup() {
  git -C "$repo_root" worktree remove --force "$worktree" >/dev/null 2>&1 || true
  rm -rf -- "$temporary_root"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
mkdir -p -- "$report_dir"

git -C "$repo_root" worktree add --quiet --detach "$worktree" "$main_sha" \
  || fail "unable_to_create_clean_detached_main_worktree"
if (
  cd -- "$worktree/browser-extension"
  npm install --ignore-scripts --no-audit --no-fund --package-lock=false
  npm run smoke:native -- --report "$report"
); then
  status=0
else
  status=$?
fi

printf 'BKE_DESKTOP_NATIVE_SMOKE_REPORT=%s\n' "$report"
printf 'BKE_DESKTOP_NATIVE_SMOKE_SOURCE_SHA=%s\n' "$main_sha"
printf 'BKE_REAL_CHROME_ACCEPTANCE=NOT_RUN\n'
printf 'Reason: nativeMessaging remains absent and this source-only smoke does not register Chrome.\n'
exit "$status"
