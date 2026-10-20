#!/usr/bin/env bash
# FORGE F1-01: owner-controlled desktop readiness. No message is ever submitted.
set -Eeuo pipefail
umask 077
fail_early(){ printf 'BKE_F1_READINESS=BLOCKED reason=%s\n' "$1" >&2; exit 2; }
if [[ "${1:-}" == "--help" ]]; then
  printf '%s\n' 'Usage: bash scripts/forge-f1-desktop-readiness.sh' \
    'Checks source smoke and guides owner through isolated Chrome readiness.' \
    'Authentication stays manual. No messages, CDP, cookies or local-storage reads.'
  exit 0
fi
[[ $# -eq 0 ]] || fail_early "UNKNOWN_ARGUMENT"
SCRIPT_DIR="$(cd -- "$(dirname -- "$0")" && pwd -P)"
SCRIPT_PATH="$SCRIPT_DIR/$(basename -- "$0")"
ROOT_DIR="$(git -C "$SCRIPT_DIR/.." rev-parse --show-toplevel 2>/dev/null)" || fail_early "NOT_IN_GIT_REPOSITORY"
ROOT_DIR="$(cd -- "$ROOT_DIR" && pwd -P)"
[[ ! -L "$SCRIPT_PATH" && "$SCRIPT_PATH" == "$ROOT_DIR/scripts/forge-f1-desktop-readiness.sh" ]] || fail_early "ENTRYPOINT_PATH_UNSAFE"
[[ -n "${HOME:-}" && "$HOME" == /* && -d "$HOME" ]] || fail_early "HOME_NOT_ABSOLUTE_DIRECTORY"
HOME="$(cd -- "$HOME" && pwd -P)"
[[ "$(id -u)" != "0" ]] || fail_early "DO_NOT_RUN_AS_ROOT"
ORIGIN_URL="$(git -C "$ROOT_DIR" remote get-url origin 2>/dev/null)" || fail_early "ORIGIN_REMOTE_MISSING"
case "$ORIGIN_URL" in
  https://github.com/jan2xo/bke-worker|https://github.com/jan2xo/bke-worker.git|git@github.com:jan2xo/bke-worker.git|ssh://git@github.com/jan2xo/bke-worker.git) ;;
  *) fail_early "ORIGIN_REPOSITORY_UNTRUSTED" ;;
esac
BRANCH="$(git -C "$ROOT_DIR" branch --show-current 2>/dev/null)" || fail_early "BRANCH_UNAVAILABLE"
[[ "$BRANCH" == "main" ]] || fail_early "CHECKOUT_NOT_MAIN"
[[ -z "$(git -C "$ROOT_DIR" status --porcelain --untracked-files=all)" ]] || fail_early "CHECKOUT_DIRTY"
command -v git >/dev/null 2>&1 || fail_early "GIT_NOT_FOUND"
command -v node >/dev/null 2>&1 || fail_early "NODE_NOT_FOUND"
command -v npm >/dev/null 2>&1 || fail_early "NPM_NOT_FOUND"
command -v python3 >/dev/null 2>&1 || fail_early "PYTHON3_NOT_FOUND"
case "$(uname -s)" in Darwin|Linux) OS="$(uname -s)" ;; *) fail_early "UNSUPPORTED_OPERATING_SYSTEM" ;; esac
NODE_MAJOR="$(node -p 'Number(process.versions.node.split(".")[0])' 2>/dev/null)" || fail_early "NODE_VERSION_UNAVAILABLE"
[[ "$NODE_MAJOR" =~ ^[0-9]+$ && "$NODE_MAJOR" -ge 22 ]] || fail_early "NODE_22_OR_NEWER_REQUIRED"
GIT_TERMINAL_PROMPT=0 git -C "$ROOT_DIR" fetch --quiet --no-tags origin refs/heads/main:refs/remotes/origin/main || fail_early "ORIGIN_MAIN_FETCH_FAILED"
HEAD_SHA="$(git -C "$ROOT_DIR" rev-parse --verify HEAD 2>/dev/null)" || fail_early "HEAD_SHA_UNAVAILABLE"
REMOTE_MAIN_SHA="$(git -C "$ROOT_DIR" rev-parse --verify refs/remotes/origin/main 2>/dev/null)" || fail_early "REMOTE_MAIN_SHA_UNAVAILABLE"
[[ "$HEAD_SHA" =~ ^[0-9a-f]{40}$ && "$HEAD_SHA" == "$REMOTE_MAIN_SHA" ]] || fail_early "STALE_CHECKOUT"

TMP_BASE="${TMPDIR:-/tmp}"
REPORT_DIR="$(mktemp -d "$TMP_BASE/bke-f1-readiness.XXXXXX")" || fail_early "PRIVATE_REPORT_DIRECTORY_FAILED"
chmod 700 "$REPORT_DIR" || fail_early "PRIVATE_REPORT_DIRECTORY_MODE_FAILED"
EVIDENCE_FILE="$REPORT_DIR/evidence.json"; REPORT_FILE="$REPORT_DIR/readiness-report.json"
REPORT_READY=1; REPORT_WRITTEN=0
SOURCE_SMOKE_STATUS="NOT_RUN"; SOURCE_SMOKE_SHA="UNAVAILABLE"
CHROME_INSTALLED=false; CHROME_VERSION="UNAVAILABLE"; CHROME_SHA256=""
NODE_BIN_REAL="$(node -p 'require("node:fs").realpathSync(process.execPath)')"; NODE_SHA256=""
PROFILE_DIR="$HOME/.bke-worker/f1/chrome-profile"
PROFILE_EXISTS=false; PROFILE_CANONICAL=false; PROFILE_OWNER_MATCHES=false; PROFILE_PRIVATE=false
PROFILE_DEDICATED=false; PROFILE_ACTIVE=false; PROFILE_EXCLUSIVE_ATTESTED=false
EXTENSION_ID=""; EXTENSION_VERSION="UNAVAILABLE"; EXTENSION_MATCH_COUNT=0
EXTENSION_ENABLED=false; EXTENSION_PATH_MATCHES=false; EXTENSION_VERSION_MATCHES=false
EXTENSION_MANIFEST_VERSION=0; EXTENSION_PERMISSIONS='[]'; EXTENSION_HOST_PERMISSIONS='[]'
EXTENSION_PATH="$ROOT_DIR/browser-extension"
HOST_STATUS="NOT_CHECKED"; HOST_NAME="bke.worker.desktop"; HOST_ORIGIN=""; HOST_POLICY_VERIFIED=false
CHATGPT_TARGET_COUNT=0; CHATGPT_EXCLUSIVITY_ATTESTED=false; CHATGPT_AUTH_IDLE=false
OPERATOR_BLOCKER=""; SEND_ATTEMPTED=false; PROFILE_SECRETS_READ=false
OTHER_PROFILES_TOUCHED=false; CREDENTIALS_WRITTEN=false
if command -v sha256sum >/dev/null 2>&1; then
  READINESS_SESSION_ID="$(printf '%s' "$HEAD_SHA:$(date -u +%Y%m%dT%H%M%SZ):$$:$RANDOM" | sha256sum | cut -c1-24)"
else
  READINESS_SESSION_ID="$(printf '%s' "$HEAD_SHA:$(date -u +%Y%m%dT%H%M%SZ):$$:$RANDOM" | shasum -a 256 | cut -c1-24)"
fi
[[ "$READINESS_SESSION_ID" =~ ^[0-9a-f]{24}$ ]] || fail_early "READINESS_SESSION_ID_FAILED"
sha256_file(){
  if command -v sha256sum >/dev/null 2>&1; then sha256sum "$1" | awk '{print $1}'
  elif command -v shasum >/dev/null 2>&1; then shasum -a 256 "$1" | awk '{print $1}'
  else return 1; fi
}
write_report(){
  [[ "$REPORT_WRITTEN" -eq 0 ]] || return 0
  export F1_REPO_ORIGIN="$ORIGIN_URL" F1_REPO_BRANCH="$BRANCH" F1_HEAD_SHA="$HEAD_SHA" F1_REMOTE_MAIN_SHA="$REMOTE_MAIN_SHA"
  export F1_SOURCE_SMOKE_STATUS="$SOURCE_SMOKE_STATUS" F1_SOURCE_SMOKE_SHA="$SOURCE_SMOKE_SHA"
  export F1_OS="$OS" F1_CHROME_INSTALLED="$CHROME_INSTALLED" F1_CHROME_VERSION="$CHROME_VERSION" F1_CHROME_SHA256="$CHROME_SHA256"
  export F1_NODE_VERSION="$(node -p 'process.version' 2>/dev/null || printf UNKNOWN)" F1_NODE_SHA256="$NODE_SHA256"
  export F1_PROFILE_DIR="$PROFILE_DIR" F1_PROFILE_EXISTS="$PROFILE_EXISTS" F1_PROFILE_CANONICAL="$PROFILE_CANONICAL"
  export F1_PROFILE_OWNER_MATCHES="$PROFILE_OWNER_MATCHES" F1_PROFILE_PRIVATE="$PROFILE_PRIVATE" F1_PROFILE_DEDICATED="$PROFILE_DEDICATED"
  export F1_PROFILE_ACTIVE="$PROFILE_ACTIVE" F1_PROFILE_EXCLUSIVE="$PROFILE_EXCLUSIVE_ATTESTED"
  export F1_EXTENSION_ID="$EXTENSION_ID" F1_EXTENSION_VERSION="$EXTENSION_VERSION" F1_EXTENSION_COUNT="$EXTENSION_MATCH_COUNT"
  export F1_EXTENSION_ENABLED="$EXTENSION_ENABLED" F1_EXTENSION_PATH_MATCHES="$EXTENSION_PATH_MATCHES"
  export F1_EXTENSION_VERSION_MATCHES="$EXTENSION_VERSION_MATCHES" F1_EXTENSION_MANIFEST_VERSION="$EXTENSION_MANIFEST_VERSION"
  export F1_EXTENSION_PERMISSIONS="$EXTENSION_PERMISSIONS" F1_EXTENSION_HOST_PERMISSIONS="$EXTENSION_HOST_PERMISSIONS"
  export F1_EXTENSION_PATH="$EXTENSION_PATH" F1_HOST_STATUS="$HOST_STATUS" F1_HOST_NAME="$HOST_NAME" F1_HOST_ORIGIN="$HOST_ORIGIN"
  export F1_HOST_POLICY_VERIFIED="$HOST_POLICY_VERIFIED" F1_TARGET_COUNT="$CHATGPT_TARGET_COUNT"
  export F1_CHATGPT_EXCLUSIVE="$CHATGPT_EXCLUSIVITY_ATTESTED" F1_CHATGPT_AUTH_IDLE="$CHATGPT_AUTH_IDLE"
  export F1_OPERATOR_BLOCKER="$OPERATOR_BLOCKER" F1_SESSION_ID="$READINESS_SESSION_ID"
  export F1_SEND_ATTEMPTED="$SEND_ATTEMPTED" F1_PROFILE_SECRETS_READ="$PROFILE_SECRETS_READ"
  export F1_OTHER_PROFILES_TOUCHED="$OTHER_PROFILES_TOUCHED" F1_CREDENTIALS_WRITTEN="$CREDENTIALS_WRITTEN"
  python3 - "$EVIDENCE_FILE" <<'PY'
import json, os, sys
def v(k, d=""): return os.environ.get("F1_"+k, d)
def b(k): return v(k).lower()=="true"
def a(k):
    try:
        x=json.loads(v(k,"[]"))
        return x if isinstance(x,list) else []
    except Exception: return []
data={
 "readinessSessionId":v("SESSION_ID"),
 "repository":{"origin":v("REPO_ORIGIN"),"branch":v("REPO_BRANCH"),"headSha":v("HEAD_SHA"),"remoteMainSha":v("REMOTE_MAIN_SHA"),"clean":True},
 "sourceSmoke":{"status":v("SOURCE_SMOKE_STATUS"),"sourceSha":v("SOURCE_SMOKE_SHA")},
 "browser":{"installed":b("CHROME_INSTALLED"),"platform":v("OS"),"name":"Google Chrome" if b("CHROME_INSTALLED") else "UNKNOWN","version":v("CHROME_VERSION"),"binarySha256":v("CHROME_SHA256"),"nodeVersion":v("NODE_VERSION"),"nodeBinarySha256":v("NODE_SHA256")},
 "profile":{"path":v("PROFILE_DIR"),"exists":b("PROFILE_EXISTS"),"pathCanonical":b("PROFILE_CANONICAL"),"ownerMatches":b("PROFILE_OWNER_MATCHES"),"privateMode":b("PROFILE_PRIVATE"),"dedicated":b("PROFILE_DEDICATED"),"activeProcess":b("PROFILE_ACTIVE"),"exclusiveOwnerAttested":b("PROFILE_EXCLUSIVE")},
 "extension":{"id":v("EXTENSION_ID"),"version":v("EXTENSION_VERSION"),"manifestVersion":int(v("EXTENSION_MANIFEST_VERSION","0") or 0),"matchCount":int(v("EXTENSION_COUNT","0") or 0),"enabled":b("EXTENSION_ENABLED"),"path":v("EXTENSION_PATH"),"pathMatches":b("EXTENSION_PATH_MATCHES"),"versionMatches":b("EXTENSION_VERSION_MATCHES"),"permissions":a("EXTENSION_PERMISSIONS"),"hostPermissions":a("EXTENSION_HOST_PERMISSIONS"),"nativeMessagingPermission":False},
 "nativeHost":{"status":v("HOST_STATUS"),"name":v("HOST_NAME"),"origin":v("HOST_ORIGIN"),"policyVerified":b("HOST_POLICY_VERIFIED")},
 "chatgpt":{"targetCount":int(v("TARGET_COUNT","0") or 0),"exclusivityAttested":b("CHATGPT_EXCLUSIVE"),"authenticatedAndIdle":b("CHATGPT_AUTH_IDLE")},
 "safety":{"messageSendAttempted":b("SEND_ATTEMPTED"),"profileSecretsRead":b("PROFILE_SECRETS_READ"),"otherProfilesTouched":b("OTHER_PROFILES_TOUCHED"),"credentialsWritten":b("CREDENTIALS_WRITTEN")},
 "operatorBlocker":v("OPERATOR_BLOCKER")}
with open(sys.argv[1],"w",encoding="utf-8") as f:
 json.dump(data,f,separators=(",",":")); f.write("\n")
PY
  node --input-type=module - "$EVIDENCE_FILE" "$REPORT_FILE" "$ROOT_DIR" <<'NODE'
import { readFileSync } from "node:fs";
import { rename, writeFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";
const [evidencePath,reportPath,root] = process.argv.slice(2);
const {evaluateF1DesktopReadiness} = await import(pathToFileURL(resolve(root,"browser-extension/scripts/forge-f1-readiness-policy.mjs")).href);
const report=evaluateF1DesktopReadiness(JSON.parse(readFileSync(evidencePath,"utf8")));
const tmp=reportPath+"."+process.pid+".tmp";
await writeFile(tmp,JSON.stringify(report,null,2)+"\n",{mode:0o600,flag:"wx"});
await rename(tmp,reportPath);
console.log("SOURCE_STATUS="+report.source_status);
console.log("REAL_CHROME_STATUS="+report.real_chrome_status);
console.log("BLOCKERS="+report.blocker_codes.join(","));
NODE
  REPORT_WRITTEN=1; rm -f -- "$EVIDENCE_FILE"
  printf 'BKE_F1_READINESS_REPORT=%s\n' "$REPORT_FILE"
}
on_exit(){
  rc=$?; trap - EXIT
  if [[ "$REPORT_READY" -eq 1 && "$REPORT_WRITTEN" -eq 0 ]]; then write_report || true; fi
  exit "$rc"
}
trap on_exit EXIT
prompt_exact(){
  phrase="$1"; message="$2"
  [[ -r /dev/tty && -w /dev/tty ]] || { OPERATOR_BLOCKER="INTERACTIVE_TTY_REQUIRED"; return 1; }
  printf '%s\nType exactly: %s\n> ' "$message" "$phrase" >/dev/tty
  answer=""; IFS= read -r answer </dev/tty || { OPERATOR_BLOCKER="OWNER_ACKNOWLEDGEMENT_MISSING"; return 1; }
  [[ "$answer" == "$phrase" ]] || { OPERATOR_BLOCKER="OWNER_ACKNOWLEDGEMENT_NOT_MATCHED"; return 1; }
}
wait_for_owner(){
  phrase="$1"; message="$2"
  [[ -r /dev/tty && -w /dev/tty ]] || { OPERATOR_BLOCKER="INTERACTIVE_TTY_REQUIRED"; return 1; }
  printf '%s\nWhen complete, type exactly: %s\n> ' "$message" "$phrase" >/dev/tty
  answer=""; IFS= read -r answer </dev/tty || { OPERATOR_BLOCKER="OWNER_ACTION_NOT_CONFIRMED"; return 1; }
  [[ "$answer" == "$phrase" ]] || { OPERATOR_BLOCKER="OWNER_ACTION_NOT_CONFIRMED"; return 1; }
}
block_real(){ OPERATOR_BLOCKER="$1"; printf 'BKE_F1_REAL_CHROME=BLOCKED reason=%s\n' "$1" >&2; exit 2; }

# First certify source at the exact current main SHA; no browser is touched before this.
if ! (cd "$ROOT_DIR/browser-extension" && npm install --ignore-scripts --no-audit --no-fund --package-lock=false >/dev/null 2>&1 && npm run check >/dev/null 2>&1); then
  SOURCE_SMOKE_STATUS="FAIL"; OPERATOR_BLOCKER="EXTENSION_BUILD_OR_MANIFEST_VALIDATION_FAILED"; exit 2
fi
if SMOKE_OUTPUT="$(bash "$ROOT_DIR/scripts/smoke-desktop-native-integration.sh" 2>&1)"; then
  SOURCE_SMOKE_STATUS="PASS"
  SOURCE_SMOKE_SHA="$(printf '%s\n' "$SMOKE_OUTPUT" | sed -n 's/^BKE_DESKTOP_NATIVE_SMOKE_SOURCE_SHA=//p' | tail -n 1)"
else
  SOURCE_SMOKE_STATUS="FAIL"; OPERATOR_BLOCKER="DESKTOP_NATIVE_SOURCE_SMOKE_FAILED"; exit 2
fi
[[ "$SOURCE_SMOKE_SHA" == "$HEAD_SHA" ]] || { OPERATOR_BLOCKER="SOURCE_SMOKE_SHA_MISMATCH"; exit 2; }
[[ -z "$(git -C "$ROOT_DIR" status --porcelain --untracked-files=all)" ]] || { OPERATOR_BLOCKER="SOURCE_CHECKOUT_CHANGED_DURING_SMOKE"; exit 2; }

CHROME_BIN=""
if [[ "$OS" == "Darwin" ]]; then
  if [[ -x "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" ]]; then CHROME_BIN="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
  elif [[ -x "$HOME/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" ]]; then CHROME_BIN="$HOME/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"; fi
else
  if command -v google-chrome-stable >/dev/null 2>&1; then CHROME_BIN="$(command -v google-chrome-stable)"
  elif command -v google-chrome >/dev/null 2>&1; then CHROME_BIN="$(command -v google-chrome)"; fi
fi
[[ -n "$CHROME_BIN" ]] || block_real "GOOGLE_CHROME_NOT_FOUND"
CHROME_BIN_REAL="$(python3 -c 'import os,sys; print(os.path.realpath(sys.argv[1]))' "$CHROME_BIN")"
CHROME_VERSION_RAW="$("$CHROME_BIN_REAL" --version 2>/dev/null || true)"
[[ "$CHROME_VERSION_RAW" =~ Google\ Chrome\ ([0-9]+\.[0-9]+\.[0-9]+\.[0-9]+) ]] || block_real "OFFICIAL_GOOGLE_CHROME_VERSION_NOT_VERIFIED"
CHROME_VERSION="${BASH_REMATCH[1]}"
CHROME_SHA256="$(sha256_file "$CHROME_BIN_REAL" 2>/dev/null || true)"
NODE_SHA256="$(sha256_file "$NODE_BIN_REAL" 2>/dev/null || true)"
[[ "$CHROME_SHA256" =~ ^[0-9a-f]{64}$ && "$NODE_SHA256" =~ ^[0-9a-f]{64}$ ]] || block_real "RUNTIME_SHA256_UNAVAILABLE"
CHROME_INSTALLED=true

# Use one isolated, owner-only F1 profile; never inspect the default browser profile.
case "$PROFILE_DIR" in *"/../"*|*"/.."|*"/./"*|*"/."|*"//"*) block_real "PROFILE_PATH_UNSAFE" ;; esac
for dir in "$HOME/.bke-worker" "$HOME/.bke-worker/f1" "$PROFILE_DIR"; do [[ ! -L "$dir" ]] || block_real "SYMLINKED_PROFILE_PATH_REFUSED"; done
if [[ ! -e "$PROFILE_DIR" ]]; then
  prompt_exact "CREATE_AND_LAUNCH_ISOLATED_CHROME_PROFILE" \
    "Create only $PROFILE_DIR with private permissions and open this profile at chatgpt.com? Login remains manual." || block_real "ISOLATED_PROFILE_CREATION_NOT_AUTHORIZED"
  for dir in "$HOME/.bke-worker" "$HOME/.bke-worker/f1" "$PROFILE_DIR"; do
    if [[ ! -e "$dir" ]]; then mkdir -m 700 -- "$dir" || block_real "PROFILE_DIRECTORY_CREATE_FAILED"; fi
    [[ -d "$dir" && ! -L "$dir" ]] || block_real "PROFILE_PATH_NOT_DIRECTORY"
    owner="$(stat -c '%u' "$dir" 2>/dev/null || stat -f '%u' "$dir" 2>/dev/null)" || block_real "PROFILE_OWNER_UNAVAILABLE"
    mode="$(stat -c '%a' "$dir" 2>/dev/null || stat -f '%Lp' "$dir" 2>/dev/null)" || block_real "PROFILE_MODE_UNAVAILABLE"
    [[ "$owner" == "$(id -u)" ]] || block_real "PROFILE_OWNER_MISMATCH"
    bits=$((8#$mode)); (( (bits & 0077) == 0 )) || block_real "PROFILE_DIRECTORY_NOT_PRIVATE"
  done
  "$CHROME_BIN_REAL" --user-data-dir="$PROFILE_DIR" --profile-directory=Default --new-window https://chatgpt.com/ >/dev/null 2>&1 &
  wait_for_owner "F1_PROFILE_OPENED_AND_READY" \
    "Complete authentication manually, load the canonical unpacked extension from chrome://extensions, and leave the tab idle." || block_real "PROFILE_READY_NOT_CONFIRMED"
fi
[[ -d "$PROFILE_DIR" && ! -L "$PROFILE_DIR" ]] || block_real "ISOLATED_PROFILE_MISSING_OR_SYMLINKED"
[[ "$(cd -- "$PROFILE_DIR" && pwd -P)" == "$PROFILE_DIR" ]] || block_real "PROFILE_PATH_NOT_CANONICAL"
PROFILE_CANONICAL=true; PROFILE_EXISTS=true; PROFILE_DEDICATED=true
PROFILE_OWNER="$(stat -c '%u' "$PROFILE_DIR" 2>/dev/null || stat -f '%u' "$PROFILE_DIR" 2>/dev/null)" || block_real "PROFILE_OWNER_UNAVAILABLE"
PROFILE_MODE="$(stat -c '%a' "$PROFILE_DIR" 2>/dev/null || stat -f '%Lp' "$PROFILE_DIR" 2>/dev/null)" || block_real "PROFILE_MODE_UNAVAILABLE"
[[ "$PROFILE_OWNER" == "$(id -u)" ]] || block_real "PROFILE_OWNER_MISMATCH"
PROFILE_OWNER_MATCHES=true
PROFILE_MODE_BITS=$((8#$PROFILE_MODE)); (( (PROFILE_MODE_BITS & 0077) == 0 )) || block_real "PROFILE_DIRECTORY_NOT_PRIVATE"
PROFILE_PRIVATE=true
# Validate every dedicated directory, even when it already existed before this run.
python3 "$ROOT_DIR/scripts/forge_f1_chrome_readiness.py" --check-profile-chain "$HOME" "$PROFILE_DIR" >/dev/null 2>&1 \
  || block_real "PROFILE_CHAIN_UNSAFE"

profile_is_active(){
  local digest
  digest="$(python3 "$ROOT_DIR/scripts/forge_f1_chrome_readiness.py" --check-process "$OS" "$CHROME_BIN_REAL" "$PROFILE_DIR" "$CHROME_VERSION" 2>/dev/null)" || return 1
  [[ "$digest" =~ ^[0-9a-f]{64}$ ]] || return 1
  CHROME_SHA256="$digest"
  return 0
}
if profile_is_active; then
  PROFILE_ACTIVE=true
else
  prompt_exact "LAUNCH_ISOLATED_CHROME_PROFILE" \
    "The dedicated profile is not attached to the verified Google Chrome executable. Open this profile at chatgpt.com?" || block_real "CHROME_NOT_ATTACHED_TO_SELECTED_PROFILE"
  "$CHROME_BIN_REAL" --user-data-dir="$PROFILE_DIR" --profile-directory=Default --new-window https://chatgpt.com/ >/dev/null 2>&1 &
  wait_for_owner "F1_PROFILE_OPENED_AND_READY" \
    "Authenticate manually, load the unpacked extension, then leave one idle chatgpt.com tab open." || block_real "PROFILE_READY_NOT_CONFIRMED"
  profile_is_active || block_real "CHROME_NOT_ATTACHED_TO_SELECTED_PROFILE"
  PROFILE_ACTIVE=true
fi
prompt_exact "F1_PROFILE_ISOLATED_AND_NOT_SHARED" \
  "Visually confirm this is a dedicated profile, not shared with ordinary browsing or another worker." || block_real "PROFILE_EXCLUSIVITY_NOT_ATTESTED"
PROFILE_EXCLUSIVE_ATTESTED=true

# A human reads extension identity from chrome://extensions; we do not read Chrome Preferences.
EXTENSION_META="$(node --input-type=module - "$EXTENSION_PATH/manifest.json" <<'NODE'
import {readFileSync} from "node:fs";
const p=JSON.parse(readFileSync(process.argv[2],"utf8"));
const deny=["nativeMessaging","cookies","debugger","history","identity","webRequest"];
if(p.manifest_version!==3||p.name!=="BKE Worker Browser Bridge"||typeof p.version!=="string"||
 Number(p.minimum_chrome_version)<116||JSON.stringify(p.permissions)!==JSON.stringify(["storage"])||
 JSON.stringify(p.host_permissions)!==JSON.stringify(["https://chatgpt.com/*"])||
 deny.some(v=>JSON.stringify(p).includes(v))) process.exit(2);
process.stdout.write(JSON.stringify({version:p.version,mv:p.manifest_version,permissions:p.permissions,hosts:p.host_permissions}));
NODE
)" || block_real "EXTENSION_MANIFEST_OR_PERMISSION_BOUNDARY_INVALID"
EXTENSION_VERSION="$(python3 -c 'import json,sys; print(json.loads(sys.argv[1])["version"])' "$EXTENSION_META")"
EXTENSION_MANIFEST_VERSION="$(python3 -c 'import json,sys; print(json.loads(sys.argv[1])["mv"])' "$EXTENSION_META")"
EXTENSION_PERMISSIONS="$(python3 -c 'import json,sys; print(json.dumps(json.loads(sys.argv[1])["permissions"]))' "$EXTENSION_META")"
EXTENSION_HOST_PERMISSIONS="$(python3 -c 'import json,sys; print(json.dumps(json.loads(sys.argv[1])["hosts"]))' "$EXTENSION_META")"
printf 'Read the extension ID from the loaded BKE Worker Browser Bridge entry in chrome://extensions.\nExtension ID (32 characters a-p): ' >/dev/tty
IFS= read -r EXTENSION_ID </dev/tty || block_real "EXTENSION_ID_NOT_PROVIDED"
[[ "$EXTENSION_ID" =~ ^[a-p]{32}$ ]] || block_real "EXTENSION_ID_INVALID"
printf 'Count matching BKE Worker Browser Bridge entries for this canonical source/version in chrome://extensions (include disabled/duplicate entries; must be exactly 1): ' >/dev/tty
IFS= read -r EXTENSION_COUNT_INPUT </dev/tty || block_real "EXTENSION_MATCH_COUNT_NOT_PROVIDED"
python3 "$ROOT_DIR/scripts/forge_f1_chrome_readiness.py" --validate-extension-count "$EXTENSION_COUNT_INPUT" >/dev/null 2>&1 \
  || block_real "EXTENSION_MISSING_OR_DUPLICATE"
EXTENSION_MATCH_COUNT=1
prompt_exact "CANONICAL_EXTENSION_PATH_VERSION_AND_ENABLED_CONFIRMED" \
  "Visually confirm the single counted extension has ID $EXTENSION_ID, uses exactly $EXTENSION_PATH, is enabled, and reports manifest version $EXTENSION_VERSION. Only this visual attestation is used; Chrome profile metadata is not read." || block_real "EXTENSION_IDENTITY_NOT_ATTESTED"
EXTENSION_ENABLED=true; EXTENSION_PATH_MATCHES=true; EXTENSION_VERSION_MATCHES=true
HOST_ORIGIN="chrome-extension://$EXTENSION_ID/"
HOST_STATUS="MISSING"
INSPECT_OUTPUT="$(BKE_NATIVE_HOST_EXTENSION_ORIGIN="$HOST_ORIGIN" bash "$ROOT_DIR/scripts/prepare-chrome-native-host.sh" inspect 2>&1)" || block_real "NATIVE_HOST_INSPECTION_FAILED_OR_CONFLICT"
if printf '%s' "$INSPECT_OUTPUT" | grep -Fq 'PASS: manifest matches expected contract.'; then
  BKE_NATIVE_HOST_EXTENSION_ORIGIN="$HOST_ORIGIN" bash "$ROOT_DIR/scripts/prepare-chrome-native-host.sh" verify >/dev/null 2>&1 || block_real "NATIVE_HOST_VERIFICATION_FAILED"
  HOST_STATUS="VERIFIED_REGISTRATION_ONLY"; HOST_POLICY_VERIFIED=true
elif printf '%s' "$INSPECT_OUTPUT" | grep -Fq 'not registered; inspect is read-only.'; then
  prompt_exact "PREPARE_USER_LEVEL_CHROME_NATIVE_HOST" \
    "The user-level host is absent. Run the existing transactional installer? This will not grant extension permissions or connect/send; an existing owner-pinned policy is required." || block_real "NATIVE_HOST_INSTALL_NOT_AUTHORIZED"
  BKE_NATIVE_HOST_EXTENSION_ORIGIN="$HOST_ORIGIN" bash "$ROOT_DIR/scripts/prepare-chrome-native-host.sh" install </dev/tty || block_real "NATIVE_HOST_INSTALL_FAILED_OR_OWNER_POLICY_MISSING"
  BKE_NATIVE_HOST_EXTENSION_ORIGIN="$HOST_ORIGIN" bash "$ROOT_DIR/scripts/prepare-chrome-native-host.sh" verify >/dev/null 2>&1 || block_real "NATIVE_HOST_VERIFY_AFTER_INSTALL_FAILED"
  HOST_STATUS="VERIFIED_REGISTRATION_ONLY"; HOST_POLICY_VERIFIED=true
else block_real "NATIVE_HOST_INSPECTION_CONTRACT_UNKNOWN"; fi
prompt_exact "THIS_IS_THE_ONLY_F1_EXPERIMENT_PROFILE" \
  "Visually confirm no other worker/session shares this isolated profile." || block_real "F1_PROFILE_UNIQUENESS_NOT_ATTESTED"
PROFILE_EXCLUSIVE_ATTESTED=true
printf 'Count of open chatgpt.com tabs in this isolated profile (must be exactly 1): ' >/dev/tty
IFS= read -r CHATGPT_TARGET_COUNT </dev/tty || block_real "CHATGPT_TARGET_COUNT_NOT_PROVIDED"
[[ "$CHATGPT_TARGET_COUNT" =~ ^[0-9]+$ ]] || block_real "CHATGPT_TARGET_COUNT_INVALID"
[[ "$CHATGPT_TARGET_COUNT" == "1" ]] || block_real "CHATGPT_TARGET_COUNT_NOT_ONE"
prompt_exact "CHATGPT_AUTHENTICATED_AND_IDLE" \
  "Visually confirm ChatGPT is logged in by you and idle, with no generation, challenge or modal. Nothing is read from the session." || block_real "CHATGPT_AUTHENTICATED_IDLE_NOT_ATTESTED"
CHATGPT_EXCLUSIVITY_ATTESTED=true; CHATGPT_AUTH_IDLE=true

printf 'BKE_F1_SOURCE_STATUS=SOURCE_SMOKE_PASS\n'
printf 'BKE_F1_HEAD_SHA=%s\n' "$HEAD_SHA"
printf 'BKE_F1_CHROME_VERSION=%s\n' "$CHROME_VERSION"
printf 'BKE_F1_CHROME_RUNTIME_SHA256=%s\n' "$CHROME_SHA256"
printf 'BKE_F1_EXTENSION_ID=%s\n' "$EXTENSION_ID"
printf 'BKE_F1_EXTENSION_VERSION=%s\n' "$EXTENSION_VERSION"
printf 'BKE_F1_NATIVE_HOST=VERIFIED_REGISTRATION_ONLY\n'
printf 'BKE_F1_LIVE_NATIVE_MESSAGING=NOT_TESTED_PERMISSION_ABSENT_BY_DESIGN\n'
printf 'BKE_F1_WORKER_ASSIGNMENT=UNENROLLED\n'
printf 'BKE_F1_CHATGPT_CONVERSATION_ID=NOT_CREATED_NO_SEND_OCCURRED\n'
exit 0
