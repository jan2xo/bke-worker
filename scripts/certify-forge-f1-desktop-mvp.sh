#!/usr/bin/env bash
# FORGE F1-06: Desktop MVP acceptance verification & owner-supervised live boundary.
set -Eeuo pipefail
umask 077

REPOSITORY_CANONICAL="jan2xo/bke-worker"
OPERATOR_TEMP_FILES=()

cleanup_operator_temp_files() {
  local rc=$?
  trap - EXIT
  local path
  for path in "${OPERATOR_TEMP_FILES[@]-}"; do
    [[ -n "$path" && -e "$path" ]] && rm -rf -- "$path" || true
  done
  exit "$rc"
}
trap cleanup_operator_temp_files EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

fail() {
  printf 'BKE_F1_MVP_CERTIFICATION=BLOCKED reason=%s\n' "$1" >&2
  exit 2
}

usage() {
  cat <<'EOF'
Usage: bash scripts/certify-forge-f1-desktop-mvp.sh [--dry-run] [--help]

Verifies FORGE F1 Desktop MVP (F1-01 through F1-06) deterministic build,
security/input-only lint, native bridge, GitHub F1-02 ledger, DesktopController
HMAC/journal crash-recovery, and synthetic 2-turn zero-duplicate acceptance gates.

Options:
  --dry-run   Run all deterministic local acceptance checks without launching Chrome.
  --help      Show this help message and exit.

Human-only boundary:
  Chrome login, ChatGPT authentication, profile isolation attestation, native
  host registration, and live-send consent remain strictly owner-controlled.
EOF
}

DRY_RUN=0
while [[ $# -gt 0 ]]; do
  case "$1" in
    --help|-h)
      usage
      exit 0
      ;;
    --dry-run)
      DRY_RUN=1
      shift
      ;;
    *)
      fail "UNKNOWN_ARGUMENT"
      ;;
  esac
done

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)" || fail "ENTRYPOINT_PATH_UNSAFE"
SCRIPT_PATH="$SCRIPT_DIR/$(basename -- "$0")"
ROOT_DIR="$(git -C "$SCRIPT_DIR/.." rev-parse --show-toplevel 2>/dev/null)" || fail "NOT_IN_GIT_REPOSITORY"
ROOT_DIR="$(cd -- "$ROOT_DIR" && pwd -P)" || fail "REPOSITORY_PATH_UNSAFE"
[[ ! -L "$SCRIPT_PATH" && "$SCRIPT_PATH" == "$ROOT_DIR/scripts/certify-forge-f1-desktop-mvp.sh" ]] || fail "ENTRYPOINT_PATH_UNSAFE"

if [[ "$DRY_RUN" -eq 0 && "$(id -u)" == "0" ]]; then
  fail "DO_NOT_RUN_AS_ROOT"
fi
ORIGIN_URL="$(git -C "$ROOT_DIR" remote get-url origin 2>/dev/null)" || fail "ORIGIN_REMOTE_MISSING"
case "$ORIGIN_URL" in
  "https://github.com/$REPOSITORY_CANONICAL"|"https://github.com/$REPOSITORY_CANONICAL.git"|"git@github.com:$REPOSITORY_CANONICAL.git"|"ssh://git@github.com/$REPOSITORY_CANONICAL.git") ;;
  *) fail "ORIGIN_REPOSITORY_UNTRUSTED" ;;
esac

for tool in git node npm python3; do
  command -v "$tool" >/dev/null 2>&1 || fail "REQUIRED_TOOL_MISSING_${tool^^}"
done
NODE_MAJOR="$(node -p 'Number(process.versions.node.split(".")[0])' 2>/dev/null)" || fail "NODE_VERSION_UNAVAILABLE"
[[ "$NODE_MAJOR" =~ ^[0-9]+$ && "$NODE_MAJOR" -ge 22 ]] || fail "NODE_22_OR_NEWER_REQUIRED"

[[ -d "$ROOT_DIR/browser-extension/node_modules" ]] || fail "EXTENSION_DEPENDENCIES_MISSING"

# Verify default human-only live-send gates remain locked false in canonical source
node --input-type=module - "$ROOT_DIR" <<'NODE'
import { readFileSync } from "node:fs";
import { join } from "node:path";

const root = process.argv[2];
const firstActuator = readFileSync(join(root, "browser-extension/src/first-message-actuator.ts"), "utf8");
const contRuntime = readFileSync(join(root, "browser-extension/src/continuation-runtime.ts"), "utf8");
if (!firstActuator.includes("export const FIRST_MESSAGE_LIVE_SEND_ENABLED = false as const;")) {
  console.error("FIRST_MESSAGE_LIVE_SEND_GATE_MODIFIED");
  process.exit(2);
}
if (!contRuntime.includes("export const CONVERSATION_CONTINUATION_LIVE_SEND_ENABLED = false as const;")) {
  console.error("CONVERSATION_CONTINUATION_LIVE_SEND_GATE_MODIFIED");
  process.exit(2);
}
NODE

SMOKE_REPORT_DIR="$(mktemp -d "${TMPDIR:-/tmp}/bke-f1-mvp-cert.XXXXXX")" || fail "TEMP_DIR_FAILED"
OPERATOR_TEMP_FILES+=("$SMOKE_REPORT_DIR")
SMOKE_REPORT_FILE="$SMOKE_REPORT_DIR/native-smoke.json"

printf '[1/5] Running browser-extension build, manifest validation, unit/native/host-claim/2-turn E2E suites...\n'
npm --prefix "$ROOT_DIR/browser-extension" run check

printf '[2/5] Running input-only security lint and tests...\n'
node "$ROOT_DIR/scripts/input-only-lint.mjs"
node --test "$ROOT_DIR/scripts/input-only-lint.test.mjs"

printf '[3/5] Running desktop native integration handshake smoke...\n'
npm --prefix "$ROOT_DIR/browser-extension" run smoke:native -- --report "$SMOKE_REPORT_FILE"

printf '[4/5] Running native host installer contract verification...\n'
python3 "$ROOT_DIR/tests/chrome_native_host_installer_contract.py"

printf '[5/5] Summary & real-Chrome live acceptance boundary...\n'
printf 'BKE_F1_MVP_SOURCE_ACCEPTANCE=PASS\n'
printf 'BKE_F1_NATIVE_SMOKE=PASS\n'
printf 'BKE_F1_LIVE_SEND_DEFAULTS=LOCKED_FALSE\n'

if [[ "$DRY_RUN" -eq 1 ]]; then
  printf 'BKE_REAL_CHROME_ACCEPTANCE=NOT_RUN reason=DRY_RUN_MODE\n'
  exit 0
fi

cat <<'EOF'
Real Chrome + live GitHub 2-turn acceptance requires human-supervised execution:
  1. Establish isolated Chrome readiness and manual ChatGPT login:
       bash scripts/forge-f1-desktop-readiness.sh
  2. Register native host policy for your loaded unpacked extension ID:
       bash scripts/prepare-chrome-native-host.sh install
  3. On an isolated assigned PR under explicit human-only consent, run
     1 worker -> 1 PR -> 2 genuine turns -> verify refs/bke/turns/* == 2 and zero duplicates.
EOF
printf 'BKE_REAL_CHROME_ACCEPTANCE=NOT_RUN reason=OWNER_SUPERVISED_CHROME_SESSION_REQUIRED\n'
exit 0
