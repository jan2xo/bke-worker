#!/usr/bin/env bash
# Source-only-safe Chrome native messaging installer preparation.
set -Eeuo pipefail
umask 077
readonly HOST_NAME="com.bke.worker.native_host"
readonly HOST_ENTRY_REL="browser-extension/native-host/entry.mjs"
readonly MAX_POLICY_BYTES=4096

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
ROOT_DIR="$(git -C "$SCRIPT_DIR/.." rev-parse --show-toplevel 2>/dev/null)" || { echo "FAIL-CLOSED: entrypoint must be in the repository." >&2; exit 2; }
ROOT_DIR="$(cd -- "$ROOT_DIR" && pwd -P)"
fail(){ printf 'FAIL-CLOSED: %s\n' "$1" >&2; exit 2; }
pass(){ printf 'PASS: %s\n' "$1"; }
note(){ printf 'INFO: %s\n' "$1"; }

OS="$(uname -s)"
case "$OS" in Darwin|Linux) ;; *) fail "unsupported operating system: $OS";; esac
command -v node >/dev/null 2>&1 || fail "Node.js is required."
NODE_BIN="$(command -v node)"
[[ "$NODE_BIN" = /* && -f "$NODE_BIN" && ! -L "$NODE_BIN" ]] || fail "Node runtime must be an absolute, non-symlink file."
NODE_VERSION="$("$NODE_BIN" -p 'Number(process.versions.node.split(".")[0])' 2>/dev/null)" || fail "cannot inspect Node runtime."
[[ "$NODE_VERSION" =~ ^[0-9]+$ && "$NODE_VERSION" -ge 22 ]] || fail "Node.js 22 or newer is required."
HOST_ENTRY="$ROOT_DIR/$HOST_ENTRY_REL"
[[ -f "$HOST_ENTRY" && ! -L "$HOST_ENTRY" ]] || fail "native host entry missing or symlinked."
HOST_DIR="$(cd -- "$(dirname -- "$HOST_ENTRY")" && pwd -P)"
[[ "$HOST_DIR" = "$ROOT_DIR/browser-extension/native-host" ]] || fail "native host canonical path mismatch."
for f in "$HOST_DIR/entry.mjs" "$HOST_DIR/host.mjs" "$HOST_DIR/framing.mjs"; do [[ -f "$f" && ! -L "$f" ]] || fail "native host source set incomplete or symlinked."; done

case "$OS" in
 Darwin) CHROME_HOST_DIR="${HOME%/}/Library/Application Support/Google/Chrome/NativeMessagingHosts";;
 Linux) CHROME_HOST_DIR="${XDG_CONFIG_HOME:-${HOME%/}/.config}/google-chrome/NativeMessagingHosts";;
esac
CHROME_HOST_MANIFEST="$CHROME_HOST_DIR/$HOST_NAME.json"
LAUNCHER_HOME="${HOME%/}/.local/lib/bke-worker/native-host"
LAUNCHER_PATH="$LAUNCHER_HOME/launch-native-host.sh"
POLICY_HOME="${HOME%/}/.config/bke-worker/native-host"
POLICY_PATH="$POLICY_HOME/owner-policy.json"
STATE_HOME="${HOME%/}/.bke-native-host-installer"
STATE_PATH="$STATE_HOME/transaction.json"
TESTING=0
if [[ -n "${BKE_NATIVE_HOST_TEST_ROOT:-}" ]]; then
  [[ "$BKE_NATIVE_HOST_TEST_ROOT" = /* && -d "$BKE_NATIVE_HOST_TEST_ROOT" && ! -L "$BKE_NATIVE_HOST_TEST_ROOT" ]] || fail "test root must already exist as an absolute non-symlink directory."
  TEST_ROOT="$(cd -- "$BKE_NATIVE_HOST_TEST_ROOT" && pwd -P)"
  CHROME_HOST_DIR="$TEST_ROOT/chrome/NativeMessagingHosts"; CHROME_HOST_MANIFEST="$CHROME_HOST_DIR/$HOST_NAME.json"
  LAUNCHER_HOME="$TEST_ROOT/launcher"; LAUNCHER_PATH="$LAUNCHER_HOME/launch-native-host.sh"
  POLICY_HOME="$TEST_ROOT/policy"; POLICY_PATH="$TEST_ROOT/policy/owner-policy.json"
  STATE_HOME="$TEST_ROOT/state"; STATE_PATH="$STATE_HOME/transaction.json"
  TESTING=1
fi
valid_origin(){ [[ "$1" =~ ^chrome-extension://[a-p]{32}/$ ]]; }
secure_file(){
 local p="$1" max="$2" mode owner size
 [[ "$p" = /* && -f "$p" && ! -L "$p" ]] || return 1
 [[ "$(cd -- "$(dirname -- "$p")" && pwd -P)/$(basename -- "$p")" = "$p" ]] || return 1
 mode="$(stat -c '%a' "$p" 2>/dev/null || stat -f '%Lp' "$p" 2>/dev/null)" || return 1
 owner="$(stat -c '%u' "$p" 2>/dev/null || stat -f '%u' "$p" 2>/dev/null)" || return 1
 size="$(wc -c < "$p" | tr -d '[:space:]')"
 [[ "$owner" = "$(id -u)" && "$size" -le "$max" ]] || return 1
 mode="$((8#$mode))"; (( (mode & 0022) == 0 ))
}
safe_dir(){
 local p="$1" mode owner
 [[ ! -e "$p" && ! -L "$p" ]] && return 0
 [[ -d "$p" && ! -L "$p" ]] || return 1
 mode="$(stat -c '%a' "$p" 2>/dev/null || stat -f '%Lp' "$p" 2>/dev/null)" || return 1
 owner="$(stat -c '%u' "$p" 2>/dev/null || stat -f '%u' "$p" 2>/dev/null)" || return 1
 [[ "$owner" = "$(id -u)" ]] || return 1
 mode="$((8#$mode))"; (( (mode & 0022) == 0 ))
}
ensure_dir(){ local p="$1"; safe_dir "$p" || fail "unsafe directory path or ownership: $p"; if [[ ! -d "$p" ]]; then mkdir -p -- "$p" || fail "cannot create directory"; chmod 700 "$p"; fi; safe_dir "$p" || fail "directory mode/owner validation failed"; }
origin="${BKE_NATIVE_HOST_EXTENSION_ORIGIN:-}"
mode="${1:-inspect}"
[[ $# -le 1 ]] || fail "usage: bash scripts/prepare-chrome-native-host.sh [inspect|install|verify|rollback]"
case "$mode" in inspect|install|verify|rollback) ;; *) fail "unsupported mode: $mode";; esac
discover_origin(){
 local found="$origin"
 if [[ -z "$found" ]]; then
  [[ -t 0 ]] || fail "extension origin not discoverable in non-interactive mode."
  printf '%s' 'Chrome extension origin (chrome-extension:// plus 32 letters a-p): ' >&2
  IFS= read -r found || fail "no origin supplied."
 fi
 valid_origin "$found" || fail "malformed Chrome extension origin."
 printf '%s' "$found"
}
if [[ "$mode" != rollback ]]; then origin="$(discover_origin)"; fi
if [[ -n "${BKE_NATIVE_HOST_POLICY_PATH:-}" ]]; then POLICY_PATH="$BKE_NATIVE_HOST_POLICY_PATH"; fi
check_policy(){
 local policy="$1" expected="$2"
 [[ "$policy" = /* && -f "$policy" && ! -L "$policy" ]] || fail "owner policy must be an existing absolute, non-symlink file."
 secure_file "$policy" "$MAX_POLICY_BYTES" || fail "owner policy owner/mode/size validation failed."
 "$NODE_BIN" --input-type=module - "$HOST_DIR/host.mjs" "$policy" "$expected" <<'NODE' || fail "owner policy does not satisfy existing host contract."
import {readFileSync} from "node:fs"; import {pathToFileURL} from "node:url";
const [host, p, origin]=process.argv.slice(2);
const {validNativeHostPolicy}=await import(pathToFileURL(host).href);
const raw=readFileSync(p,"utf8"); if(Buffer.byteLength(raw)>4096)process.exit(1);
const obj=JSON.parse(raw); if(!validNativeHostPolicy(obj)||obj.allowed_origin!==origin)process.exit(1);
NODE
}
manifest_matches(){
 [[ -f "$CHROME_HOST_MANIFEST" && ! -L "$CHROME_HOST_MANIFEST" ]] || return 1
 "$NODE_BIN" - "$CHROME_HOST_MANIFEST" "$LAUNCHER_PATH" "$origin" <<'NODE'
import {readFileSync} from "node:fs";
const [p,path,origin]=process.argv.slice(2); let x;
try{x=JSON.parse(readFileSync(p,"utf8"))}catch{process.exit(1)}
const keys=["allowed_origins","description","name","path","type"].sort().join(",");
if(!x||typeof x!=="object"||Array.isArray(x)||Object.keys(x).sort().join(",")!==keys||
x.name!=="com.bke.worker.native_host"||x.type!=="stdio"||x.path!==path||
x.description!=="BKE Worker local native host (source-only preparation)"||
!Array.isArray(x.allowed_origins)||x.allowed_origins.length!==1||x.allowed_origins[0]!==origin)process.exit(1)
NODE
}
inspect(){
 note "OS=$OS; Node major=$NODE_VERSION"; note "User-level Chrome manifest target: $CHROME_HOST_MANIFEST"; note "Launcher target: $LAUNCHER_PATH"; note "Owner policy: $POLICY_PATH"
 if [[ -e "$CHROME_HOST_MANIFEST" || -L "$CHROME_HOST_MANIFEST" ]]; then manifest_matches || fail "existing manifest is unknown/conflicting; refusing overwrite."; pass "registration manifest matches."; else note "not registered; inspect made no changes."; fi
}
verify(){
 manifest_matches || fail "manifest missing/unsafe/mismatched."
 secure_file "$CHROME_HOST_MANIFEST" 16384 || fail "manifest mode/owner validation failed."
 secure_file "$LAUNCHER_PATH" 16384 || fail "launcher mode/owner validation failed."
 secure_file "$POLICY_PATH" "$MAX_POLICY_BYTES" || fail "policy mode/owner validation failed."
 [[ -x "$LAUNCHER_PATH" ]] || fail "launcher is not executable."
 [[ -f "$LAUNCHER_HOME/entry.mjs" && ! -L "$LAUNCHER_HOME/entry.mjs" ]] || fail "installed host entry missing/unsafe."
 pass "registration manifest, launcher and owner policy validate."
}
install_host(){
 if (( TESTING == 0 )); then
  [[ -t 0 ]] || fail "non-interactive installation denied."
  printf '%s\n' 'This will write only the per-user Chrome native-host registration and installer-owned files.' >&2
  printf '%s' 'Type INSTALL USER-LEVEL CHROME HOST to continue: ' >&2
  local answer; IFS= read -r answer || fail "confirmation missing."
  [[ "$answer" = "INSTALL USER-LEVEL CHROME HOST" ]] || fail "installation not acknowledged."
 fi
 for d in "$CHROME_HOST_DIR" "$LAUNCHER_HOME" "$POLICY_HOME" "$STATE_HOME"; do ensure_dir "$d"; done
 [[ -f "$POLICY_PATH" && ! -L "$POLICY_PATH" ]] || fail "owner-pinned policy must already exist at $POLICY_PATH; installer will not invent trust pins."
 check_policy "$POLICY_PATH" "$origin"
 if [[ -e "$CHROME_HOST_MANIFEST" || -L "$CHROME_HOST_MANIFEST" || -e "$LAUNCHER_PATH" || -L "$LAUNCHER_PATH" || -e "$LAUNCHER_HOME/entry.mjs" || -L "$LAUNCHER_HOME/entry.mjs" || -e "$LAUNCHER_HOME/owner-policy.json" || -L "$LAUNCHER_HOME/owner-policy.json" || -e "$STATE_PATH" || -L "$STATE_PATH" ]]; then
  if manifest_matches && verify; then pass "matching registration already exists (no-op)."; return; fi
  fail "refusing to overwrite unknown registration, launcher, policy copy, or transaction state."
 fi
 local staged_manifest staged_launcher staged_entry staged_policy staged_state node_escape
 local created=()
 cleanup(){ local rc=$?; if (( rc != 0 )); then for p in "${created[@]:-}"; do [[ -n "$p" ]] && rm -f -- "$p"; done; fi; }
 trap cleanup EXIT
 staged_manifest="$(mktemp "$CHROME_HOST_DIR/.bke-manifest.XXXXXX")"
 staged_launcher="$(mktemp "$LAUNCHER_HOME/.bke-launcher.XXXXXX")"
 staged_entry="$(mktemp "$LAUNCHER_HOME/.bke-entry.XXXXXX")"
 staged_policy="$(mktemp "$LAUNCHER_HOME/.bke-policy.XXXXXX")"
 staged_state="$(mktemp "$STATE_HOME/.bke-state.XXXXXX")"
 node_escape="$("$NODE_BIN" -p 'JSON.stringify(process.argv[1])' -- "$NODE_BIN")"
 # NODE variable is shell syntax; JSON escaping keeps paths with spaces correct.
 "$NODE_BIN" - "$staged_launcher" "$NODE_BIN" <<'NODE'
import {writeFileSync} from "node:fs";
const [p,node]=process.argv.slice(2);
const q=JSON.stringify(node);
writeFileSync(p,`#!/usr/bin/env bash\nset -Eeuo pipefail\nHERE="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"\nPOLICY="$HERE/owner-policy.json"\nENTRY="$HERE/entry.mjs"\nNODE=${q}\n[[ "$#" -eq 1 && "$1" =~ ^chrome-extension://[a-p]{32}/$ ]] || exit 2\n[[ -f "$POLICY" && ! -L "$POLICY" && -f "$ENTRY" && ! -L "$ENTRY" ]] || exit 2\nexec "$NODE" "$ENTRY" "$POLICY" "$1"\n`,{mode:0o700,flag:"w"});
NODE
 cp -- "$HOST_ENTRY" "$staged_entry"; cp -- "$POLICY_PATH" "$staged_policy"
 chmod 700 "$staged_launcher"; chmod 600 "$staged_entry" "$staged_policy"
 "$NODE_BIN" - "$staged_manifest" "$LAUNCHER_PATH" "$origin" <<'NODE'
import {writeFileSync} from "node:fs";
const [p,path,origin]=process.argv.slice(2);
writeFileSync(p,JSON.stringify({name:"com.bke.worker.native_host",description:"BKE Worker local native host (source-only preparation)",path,type:"stdio",allowed_origins:[origin]})+"\n",{mode:0o600,flag:"w"});
NODE
 "$NODE_BIN" - "$staged_state" "$CHROME_HOST_MANIFEST" "$LAUNCHER_PATH" "$LAUNCHER_HOME/entry.mjs" "$LAUNCHER_HOME/owner-policy.json" "$origin" <<'NODE'
import {writeFileSync} from "node:fs";
const [p,manifest,launcher,entry,policy,origin]=process.argv.slice(2);
writeFileSync(p,JSON.stringify({version:1,host:"com.bke.worker.native_host",manifest,launcher,entry,policy,origin,created_by:"prepare-chrome-native-host.sh"})+"\n",{mode:0o600,flag:"w"});
NODE
 # Record rollback targets before exposure. Atomic same-filesystem renames.
 created+=("$CHROME_HOST_MANIFEST" "$LAUNCHER_PATH" "$LAUNCHER_HOME/entry.mjs" "$LAUNCHER_HOME/owner-policy.json" "$STATE_PATH")
 mv -- "$staged_launcher" "$LAUNCHER_PATH"
 mv -- "$staged_entry" "$LAUNCHER_HOME/entry.mjs"
 mv -- "$staged_policy" "$LAUNCHER_HOME/owner-policy.json"
 mv -- "$staged_state" "$STATE_PATH"
 mv -- "$staged_manifest" "$CHROME_HOST_MANIFEST"
 trap - EXIT
 verify
 pass "registration prepared; no browser launched and no extension permission granted."
}
rollback(){
 [[ -f "$STATE_PATH" && ! -L "$STATE_PATH" ]] || fail "transaction record missing; rollback will not guess."
 secure_file "$STATE_PATH" 8192 || fail "transaction record unsafe."
 "$NODE_BIN" - "$STATE_PATH" "$CHROME_HOST_MANIFEST" "$LAUNCHER_PATH" "$LAUNCHER_HOME/entry.mjs" "$LAUNCHER_HOME/owner-policy.json" <<'NODE' || fail "transaction record mismatch; preserving files."
import {readFileSync,lstatSync} from "node:fs";
const [sfile,manifest,launcher,entry,policy]=process.argv.slice(2); const s=JSON.parse(readFileSync(sfile,"utf8"));
if(s.version!==1||s.host!=="com.bke.worker.native_host"||s.manifest!==manifest||s.launcher!==launcher||s.entry!==entry||s.policy!==policy||s.created_by!=="prepare-chrome-native-host.sh")process.exit(1);
for(const p of [manifest,launcher,entry,policy]){const x=lstatSync(p);if(!x.isFile()||x.isSymbolicLink())process.exit(1)}
NODE
 manifest_matches || fail "manifest changed after install; rollback refused."
 for p in "$CHROME_HOST_MANIFEST" "$LAUNCHER_PATH" "$LAUNCHER_HOME/entry.mjs" "$LAUNCHER_HOME/owner-policy.json" "$STATE_PATH"; do secure_file "$p" 16384 || fail "installer artifact owner/mode validation failed; rollback refused."; done
 rm -- "$CHROME_HOST_MANIFEST" "$LAUNCHER_PATH" "$LAUNCHER_HOME/entry.mjs" "$LAUNCHER_HOME/owner-policy.json" "$STATE_PATH"
 pass "removed only the unchanged installer-owned registration artifacts."
}
case "$mode" in inspect) inspect;; install) install_host;; verify) verify;; rollback) rollback;; esac
