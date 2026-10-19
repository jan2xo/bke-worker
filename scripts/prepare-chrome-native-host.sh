#!/usr/bin/env bash
# BKE Worker Chrome native host registration preparation. Source-only until a human runs install.
set -Eeuo pipefail
umask 077
readonly HOST_NAME="com.bke.worker.native_host"
readonly ENTRY_REL="browser-extension/native-host/entry.mjs"
readonly HOST_MODULE_REL="browser-extension/native-host/host.mjs"
readonly FRAMING_REL="browser-extension/native-host/framing.mjs"
readonly POLICY_MAX=4096
SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
ROOT_DIR="$(git -C "$SCRIPT_DIR/.." rev-parse --show-toplevel 2>/dev/null)" || { echo "FAIL-CLOSED: repository root not found." >&2; exit 2; }
ROOT_DIR="$(cd -- "$ROOT_DIR" && pwd -P)"
fail(){ printf 'FAIL-CLOSED: %s\n' "$1" >&2; exit 2; }
pass(){ printf 'PASS: %s\n' "$1"; }
note(){ printf 'INFO: %s\n' "$1"; }
OS="$(uname -s)"
if [[ -n "${BKE_NATIVE_HOST_TEST_OS:-}" ]]; then
 [[ -n "${BKE_NATIVE_HOST_TEST_ROOT:-}" ]] || fail "OS override requires an isolated test root."
 OS="$BKE_NATIVE_HOST_TEST_OS"
fi
case "$OS" in Darwin|Linux) ;; *) fail "unsupported OS: $OS";; esac
command -v node >/dev/null 2>&1 || fail "Node.js required."
NODE_BIN="$(node -p 'require("node:fs").realpathSync(process.execPath)' 2>/dev/null)" || fail "could not resolve Node executable."
[[ "$NODE_BIN" = /* && -f "$NODE_BIN" ]] || fail "Node executable must resolve to an absolute file."
[[ "$(cd -- "$(dirname -- "$NODE_BIN")" && pwd -P)/$(basename -- "$NODE_BIN")" = "$NODE_BIN" ]] || fail "Node executable path is not canonical."
NODE_VERSION="$("$NODE_BIN" -p 'Number(process.versions.node.split(".")[0])')" || fail "could not inspect Node."
[[ "$NODE_VERSION" =~ ^[0-9]+$ && "$NODE_VERSION" -ge 22 ]] || fail "Node.js 22+ required."
HOST_DIR="$ROOT_DIR/browser-extension/native-host"
HOST_ENTRY="$ROOT_DIR/$ENTRY_REL"
[[ -d "$HOST_DIR" && ! -L "$HOST_DIR" && -f "$HOST_ENTRY" && ! -L "$HOST_ENTRY" ]] || fail "native host source path unsafe or missing."
for f in "$HOST_DIR/entry.mjs" "$HOST_DIR/host.mjs" "$HOST_DIR/framing.mjs"; do [[ -f "$f" && ! -L "$f" ]] || fail "native host source set incomplete or symlinked."; done
case "$OS" in Darwin) DEFAULT_CONFIG="${HOME%/}/Library/Application Support/Google/Chrome";; Linux) DEFAULT_CONFIG="${XDG_CONFIG_HOME:-${HOME%/}/.config}/google-chrome";; esac
CHROME_HOST_DIR="$DEFAULT_CONFIG/NativeMessagingHosts"
MANIFEST="$CHROME_HOST_DIR/$HOST_NAME.json"
INSTALL_DIR="${HOME%/}/.local/lib/bke-worker/native-host"
LAUNCHER="$INSTALL_DIR/launch-native-host.sh"
INSTALLED_ENTRY="$INSTALL_DIR/entry.mjs"
INSTALLED_HOST="$INSTALL_DIR/host.mjs"
INSTALLED_FRAMING="$INSTALL_DIR/framing.mjs"
INSTALLED_POLICY="$INSTALL_DIR/owner-policy.json"
POLICY="${BKE_NATIVE_HOST_POLICY_PATH:-${HOME%/}/.config/bke-worker/native-host/owner-policy.json}"
STATE_DIR="${HOME%/}/.local/state/bke-worker/native-host-installer"
STATE="$STATE_DIR/transaction.json"
TESTING=0
if [[ -n "${BKE_NATIVE_HOST_TEST_ROOT:-}" ]]; then
 [[ "$BKE_NATIVE_HOST_TEST_ROOT" = /* && -d "$BKE_NATIVE_HOST_TEST_ROOT" && ! -L "$BKE_NATIVE_HOST_TEST_ROOT" ]] || fail "test root must be existing absolute non-symlink directory."
 TEST_ROOT="$(cd -- "$BKE_NATIVE_HOST_TEST_ROOT" && pwd -P)"
 case "$OS" in
  Darwin) CHROME_HOST_DIR="$TEST_ROOT/home/Library/Application Support/Google/Chrome/NativeMessagingHosts";;
  Linux) CHROME_HOST_DIR="$TEST_ROOT/xdg/google-chrome/NativeMessagingHosts";;
 esac
 MANIFEST="$CHROME_HOST_DIR/$HOST_NAME.json"
 INSTALL_DIR="$TEST_ROOT/install"; LAUNCHER="$INSTALL_DIR/launch-native-host.sh"; INSTALLED_ENTRY="$INSTALL_DIR/entry.mjs"; INSTALLED_HOST="$INSTALL_DIR/host.mjs"; INSTALLED_FRAMING="$INSTALL_DIR/framing.mjs"; INSTALLED_POLICY="$INSTALL_DIR/owner-policy.json"
 POLICY="${BKE_NATIVE_HOST_POLICY_PATH:-$TEST_ROOT/policy/owner-policy.json}"
 STATE_DIR="$TEST_ROOT/state"; STATE="$STATE_DIR/transaction.json"; TESTING=1
fi
valid_origin(){ [[ "$1" =~ ^chrome-extension://[a-p]{32}/$ ]]; }
origin="${BKE_NATIVE_HOST_EXTENSION_ORIGIN:-}"
mode="${1:-inspect}"
[[ $# -le 1 ]] || fail "usage: bash scripts/prepare-chrome-native-host.sh [inspect|install|verify|rollback]"
case "$mode" in inspect|install|verify|rollback) ;; *) fail "unsupported mode: $mode";; esac
discover_origin(){
 local v="$origin"
 if [[ -z "$v" ]]; then [[ -t 0 ]] || fail "extension ID cannot be inferred from source; supply it interactively."; printf '%s' 'Chrome extension origin (chrome-extension:// plus exactly 32 letters a-p): ' >&2; IFS= read -r v || fail "no origin supplied."; fi
 valid_origin "$v" || fail "invalid Chrome extension origin."
 printf '%s' "$v"
}
if [[ "$mode" != rollback ]]; then origin="$(discover_origin)"; fi
file_identity(){ stat -c '%d:%i' "$1" 2>/dev/null || stat -f '%d:%i' "$1" 2>/dev/null; }
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
ensure_dir(){ local p="$1"; safe_dir "$p" || fail "unsafe directory or owner: $p"; if [[ ! -d "$p" ]]; then mkdir -p -- "$p" || fail "cannot create directory"; chmod 700 "$p"; fi; safe_dir "$p" || fail "directory validation failed"; }
SAFE_RUNTIME_REASON="unknown"
safe_runtime(){
 local mode owner uid canonical
 if [[ "$NODE_BIN" != /* || ! -f "$NODE_BIN" || ! -x "$NODE_BIN" || -L "$NODE_BIN" ]]; then SAFE_RUNTIME_REASON="file-type-or-executable"; return 1; fi
 canonical="$(cd -- "$(dirname -- "$NODE_BIN")" 2>/dev/null && pwd -P)/$(basename -- "$NODE_BIN")"
 if [[ "$canonical" != "$NODE_BIN" ]]; then SAFE_RUNTIME_REASON="noncanonical-path"; return 1; fi
 mode="$(stat -c '%a' "$NODE_BIN" 2>/dev/null || stat -f '%Lp' "$NODE_BIN" 2>/dev/null)" || { SAFE_RUNTIME_REASON="mode-stat"; return 1; }
 owner="$(stat -c '%u' "$NODE_BIN" 2>/dev/null || stat -f '%u' "$NODE_BIN" 2>/dev/null)" || { SAFE_RUNTIME_REASON="owner-stat"; return 1; }
 uid="$(id -u)"
 if [[ "$owner" != "$uid" && "$owner" != "0" ]]; then SAFE_RUNTIME_REASON="unexpected-owner"; return 1; fi
 mode="$((8#$mode))"
 if (( (mode & 0022) != 0 )); then SAFE_RUNTIME_REASON="group-or-world-writable"; return 1; fi
 SAFE_RUNTIME_REASON="ok"
 return 0
}
safe_parent(){
 local p="$1" mode owner bits uid
 [[ -d "$p" && ! -L "$p" ]] || return 1
 mode="$(stat -c '%a' "$p" 2>/dev/null || stat -f '%Lp' "$p" 2>/dev/null)" || return 1
 owner="$(stat -c '%u' "$p" 2>/dev/null || stat -f '%u' "$p" 2>/dev/null)" || return 1
 bits="$((8#$mode))"; uid="$(id -u)"
 if [[ "$owner" = "$uid" ]]; then
   (( (bits & 0022) == 0 ))
 elif [[ "$owner" = "0" ]] && (( (bits & 01000) != 0 )); then
   # System sticky directories such as /tmp may be shared; private child paths are validated separately.
   (( (bits & 0002) != 0 ))
 elif [[ "$owner" = "0" ]]; then
   (( (bits & 0022) == 0 ))
 else
   return 1
 fi
}
check_policy(){
 local policy="${1:-$POLICY}" host_path="${2:-$HOST_DIR/host.mjs}"
 [[ "$policy" = /* && -f "$policy" && ! -L "$policy" ]] || fail "owner-pinned policy must be existing absolute non-symlink file."
 secure_file "$policy" "$POLICY_MAX" || fail "owner policy ownership/mode/size invalid."
 "$NODE_BIN" --input-type=module - "$host_path" "$policy" "$origin" <<'NODE' || fail "policy does not match existing native-host contract."
import {readFileSync} from "node:fs";import{pathToFileURL}from"node:url";
const [hostPath,policyPath,origin]=process.argv.slice(2);const{validNativeHostPolicy}=await import(pathToFileURL(hostPath).href);
const raw=readFileSync(policyPath,"utf8");if(Buffer.byteLength(raw)>4096)process.exit(1);
const p=JSON.parse(raw);if(!validNativeHostPolicy(p)||p.allowed_origin!==origin)process.exit(1);
NODE
}
safe_runtime || fail "Node executable validation failed ($SAFE_RUNTIME_REASON)."
for source in "$HOST_ENTRY" "$HOST_DIR/host.mjs" "$HOST_DIR/framing.mjs"; do
 secure_file "$source" 16384 || fail "native host source ownership, permissions or path invalid."
done
manifest_matches(){
 [[ -f "$MANIFEST" && ! -L "$MANIFEST" ]] || return 1
 secure_file "$MANIFEST" 16384 || return 1
 "$NODE_BIN" - "$MANIFEST" "$LAUNCHER" "$origin" <<'NODE'
import {readFileSync} from "node:fs";
const [p,path,origin]=process.argv.slice(2);let m;try{m=JSON.parse(readFileSync(p,"utf8"))}catch{process.exit(1)}
const keys=["allowed_origins","description","name","path","type"].sort().join(",");
if(!m||typeof m!=="object"||Array.isArray(m)||Object.keys(m).sort().join(",")!==keys||m.name!=="com.bke.worker.native_host"||m.type!=="stdio"||m.description!=="BKE Worker local native host (source-only preparation)"||m.path!==path||!Array.isArray(m.allowed_origins)||m.allowed_origins.length!==1||m.allowed_origins[0]!==origin)process.exit(1)
NODE
}
inspect(){
 note "Platform: $OS; Node major: $NODE_VERSION";note "Chrome manifest: $MANIFEST";note "Launcher: $LAUNCHER";note "Owner policy: $POLICY"
 if [[ -e "$MANIFEST" || -L "$MANIFEST" ]];then manifest_matches||fail "existing manifest conflicts; no overwrite attempted.";pass "manifest matches expected contract.";else note "not registered; inspect is read-only.";fi
}
verify(){
 manifest_matches||fail "manifest absent, unsafe, or mismatched."
 secure_file "$LAUNCHER" 16384||fail "launcher ownership/mode invalid."
 secure_file "$INSTALLED_ENTRY" 16384||fail "installed entry invalid."
 secure_file "$INSTALLED_HOST" 16384||fail "installed host module invalid."
 secure_file "$INSTALLED_FRAMING" 16384||fail "installed framing module invalid."
 secure_file "$INSTALLED_POLICY" "$POLICY_MAX"||fail "installed policy invalid."
 [[ -x "$LAUNCHER" ]]||fail "launcher is not executable."
 check_policy "$INSTALLED_POLICY" "$INSTALLED_HOST"
 pass "registration and launcher files verified."
}
install_host(){
 if ((TESTING==0));then
  [[ -t 0 ]]||fail "non-interactive install refused."
  printf '%s\n' 'This writes only user-level Chrome native-host files; it does not grant permissions or enroll a device.' >&2
  printf '%s' 'Type INSTALL USER-LEVEL CHROME HOST to continue: ' >&2
  local answer;IFS= read -r answer||fail "missing acknowledgement."
  [[ "$answer" == "INSTALL USER-LEVEL CHROME HOST" ]]||fail "installation not acknowledged."
 fi
 local p
 # Reject a symlinked or unsafe ancestor anywhere under the chosen user-state roots.
 for p in "$(dirname -- "$CHROME_HOST_DIR")" "$INSTALL_DIR" "$STATE_DIR"; do
   local walk="$p"
   while [[ "$walk" != "/" ]]; do
     [[ ! -L "$walk" ]] || fail "symlinked installation parent refused."
     walk="$(dirname -- "$walk")"
   done
 done
 for p in "$CHROME_HOST_DIR" "$INSTALL_DIR" "$STATE_DIR";do ensure_dir "$p";done
 [[ -f "$POLICY" && ! -L "$POLICY" ]]||fail "owner-pinned policy must exist at $POLICY; no pins are invented."
 check_policy
 if [[ -e "$MANIFEST" || -L "$MANIFEST" || -e "$LAUNCHER" || -L "$LAUNCHER" || -e "$INSTALLED_ENTRY" || -L "$INSTALLED_ENTRY" || -e "$INSTALLED_HOST" || -L "$INSTALLED_HOST" || -e "$INSTALLED_FRAMING" || -L "$INSTALLED_FRAMING" || -e "$INSTALLED_POLICY" || -L "$INSTALLED_POLICY" || -e "$STATE" || -L "$STATE" ]];then
  if manifest_matches&&verify;then pass "matching registration already exists; idempotent no-op.";return;fi
  fail "refusing to overwrite conflicting registration, launcher, policy, or transaction."
 fi
 local stage_manifest stage_launcher stage_entry stage_host stage_framing stage_policy stage_state
 TX_COMMITTED=0
 TX_CREATED_PATHS=()
 TX_CREATED_IDS=()
 TX_STAGE_MANIFEST="" TX_STAGE_LAUNCHER="" TX_STAGE_ENTRY="" TX_STAGE_HOST="" TX_STAGE_FRAMING="" TX_STAGE_POLICY="" TX_STAGE_STATE=""
 cleanup_install(){
  local rc=$? idx path identity
  if ((rc!=0 && TX_COMMITTED==0));then
   for staged in "$TX_STAGE_MANIFEST" "$TX_STAGE_LAUNCHER" "$TX_STAGE_ENTRY" "$TX_STAGE_HOST" "$TX_STAGE_FRAMING" "$TX_STAGE_POLICY" "$TX_STAGE_STATE"; do
    [[ -n "$staged" ]] && rm -f -- "$staged"
   done
   # Delete only targets whose device/inode still matches the no-clobber link created by this transaction.
   for ((idx=0; idx<${#TX_CREATED_PATHS[@]}; idx++)); do
    path="${TX_CREATED_PATHS[$idx]}"
    [[ -f "$path" && ! -L "$path" ]] || continue
    identity="$(file_identity "$path" 2>/dev/null || true)"
    if [[ -n "$identity" && "$identity" == "${TX_CREATED_IDS[$idx]}" ]];then rm -f -- "$path";fi
   done
  fi
 }
 trap cleanup_install EXIT
 stage_manifest="$(mktemp "$CHROME_HOST_DIR/.bke-host.XXXXXX")"; TX_STAGE_MANIFEST="$stage_manifest"
 stage_launcher="$(mktemp "$INSTALL_DIR/.bke-launcher.XXXXXX")"; TX_STAGE_LAUNCHER="$stage_launcher"
 stage_entry="$(mktemp "$INSTALL_DIR/.bke-entry.XXXXXX")"; TX_STAGE_ENTRY="$stage_entry"
 stage_host="$(mktemp "$INSTALL_DIR/.bke-host-module.XXXXXX")"; TX_STAGE_HOST="$stage_host"
 stage_framing="$(mktemp "$INSTALL_DIR/.bke-framing-module.XXXXXX")"; TX_STAGE_FRAMING="$stage_framing"
 stage_policy="$(mktemp "$INSTALL_DIR/.bke-policy.XXXXXX")"; TX_STAGE_POLICY="$stage_policy"
 stage_state="$(mktemp "$STATE_DIR/.bke-state.XXXXXX")"; TX_STAGE_STATE="$stage_state"
 "$NODE_BIN" - "$stage_launcher" "$NODE_BIN" <<'NODE'
import {writeFileSync} from"node:fs";
const[p,node]=process.argv.slice(2),q=JSON.stringify(node);
writeFileSync(p,`#!/usr/bin/env bash\nset -Eeuo pipefail\nHERE="$(cd -- "$(dirname -- "\${BASH_SOURCE[0]}")" && pwd -P)"\nPOLICY="$HERE/owner-policy.json"\nENTRY="$HERE/entry.mjs"\nNODE_BIN=${q}\n[[ "$#" -eq 1 && "$1" =~ ^chrome-extension://[a-p]{32}/$ ]]||exit 2\n[[ -f "$POLICY" && ! -L "$POLICY" && -f "$ENTRY" && ! -L "$ENTRY" ]]||exit 2\nexec "$NODE_BIN" "$ENTRY" "$POLICY" "$1"\n`,{mode:0o700,flag:"w"});
NODE
 cp -- "$HOST_ENTRY" "$stage_entry"; cp -- "$HOST_DIR/host.mjs" "$stage_host"; cp -- "$HOST_DIR/framing.mjs" "$stage_framing"; cp -- "$POLICY" "$stage_policy"; chmod 700 "$stage_launcher"; chmod 600 "$stage_entry" "$stage_host" "$stage_framing" "$stage_policy"
 "$NODE_BIN" - "$stage_manifest" "$LAUNCHER" "$origin" <<'NODE'
import{writeFileSync}from"node:fs";const[p,path,origin]=process.argv.slice(2);
writeFileSync(p,JSON.stringify({name:"com.bke.worker.native_host",description:"BKE Worker local native host (source-only preparation)",path,type:"stdio",allowed_origins:[origin]})+"\n",{mode:0o600,flag:"w"});
NODE
 # Transaction records exact hashes of source-staged bytes before any installation path appears.
 STAGE_MANIFEST="$stage_manifest" STAGE_LAUNCHER="$stage_launcher" STAGE_ENTRY="$stage_entry" STAGE_HOST="$stage_host" STAGE_FRAMING="$stage_framing" STAGE_POLICY="$stage_policy" "$NODE_BIN" - "$stage_state" "$MANIFEST" "$LAUNCHER" "$INSTALLED_ENTRY" "$INSTALLED_HOST" "$INSTALLED_FRAMING" "$INSTALLED_POLICY" "$origin" <<'NODE'
import{writeFileSync,readFileSync}from"node:fs";import{createHash}from"node:crypto";
const[p,manifest,launcher,entry,host,framing,policy,origin]=process.argv.slice(2);const hash=f=>createHash("sha256").update(readFileSync(f)).digest("hex");
const s={version:1,host:"com.bke.worker.native_host",manifest,launcher,entry,host_module:host,framing_module:framing,policy,origin,created_by:"prepare-chrome-native-host.sh",
sha256:{manifest:hash(process.env.STAGE_MANIFEST),launcher:hash(process.env.STAGE_LAUNCHER),entry:hash(process.env.STAGE_ENTRY),host:hash(process.env.STAGE_HOST),framing:hash(process.env.STAGE_FRAMING),policy:hash(process.env.STAGE_POLICY)}};
writeFileSync(p,JSON.stringify(s)+"\n",{mode:0o600,flag:"w"});
NODE
 # Install all payload files by no-clobber hard link; register the manifest last.
 for spec in "$stage_launcher:$LAUNCHER" "$stage_entry:$INSTALLED_ENTRY" "$stage_host:$INSTALLED_HOST" "$stage_framing:$INSTALLED_FRAMING" "$stage_policy:$INSTALLED_POLICY" "$stage_state:$STATE";do
  src="${spec%%:*}";dst="${spec#*:}"
  ln -- "$src" "$dst"||fail "destination appeared during install; refusing overwrite."
  TX_CREATED_PATHS+=("$dst"); TX_CREATED_IDS+=("$(file_identity "$dst")")
  rm -- "$src"
  link_index=$((link_index + 1))
  if [[ "$TESTING" -eq 1 && "${BKE_NATIVE_HOST_TEST_FAIL_AFTER_LINK:-}" = "$link_index" ]]; then
    fail "test-only injected installation interruption."
  fi
 done
 ln -- "$stage_manifest" "$MANIFEST"||fail "manifest destination appeared during install; refusing overwrite."
 TX_CREATED_PATHS+=("$MANIFEST"); TX_CREATED_IDS+=("$(file_identity "$MANIFEST")")
 rm -- "$stage_manifest"
 verify
 TX_COMMITTED=1;trap - EXIT
 pass "registration prepared; no browser launched and no extension permission granted."
}
rollback(){
 [[ -f "$STATE"&&! -L "$STATE" ]]||fail "transaction record absent; refusing speculative rollback."
 secure_file "$STATE" 8192||fail "transaction record owner/mode invalid."
 origin="$("$NODE_BIN" - "$STATE" <<'NODE'
import {readFileSync} from "node:fs";
let s;try{s=JSON.parse(readFileSync(process.argv[2],"utf8"))}catch{process.exit(1)}
if(typeof s.origin!=="string"||!/^chrome-extension:\/\/[a-p]{32}\/$/.test(s.origin))process.exit(1);
process.stdout.write(s.origin);
NODE
)" || fail "transaction origin invalid; rollback refused."
 valid_origin "$origin" || fail "transaction origin invalid; rollback refused."
 "$NODE_BIN" - "$STATE" "$MANIFEST" "$LAUNCHER" "$INSTALLED_ENTRY" "$INSTALLED_HOST" "$INSTALLED_FRAMING" "$INSTALLED_POLICY" <<'NODE' || fail "transaction record mismatch; preserving all files."
import{readFileSync,lstatSync}from"node:fs";import{createHash}from"node:crypto";
const[sfile,manifest,launcher,entry,host,framing,policy]=process.argv.slice(2);let s;try{s=JSON.parse(readFileSync(sfile,"utf8"))}catch{process.exit(1)}
if(s.version!==1||s.host!=="com.bke.worker.native_host"||s.manifest!==manifest||s.launcher!==launcher||s.entry!==entry||s.host_module!==host||s.framing_module!==framing||s.policy!==policy||s.created_by!=="prepare-chrome-native-host.sh")process.exit(1);
const checks=[[manifest,s.sha256?.manifest],[launcher,s.sha256?.launcher],[entry,s.sha256?.entry],[host,s.sha256?.host],[framing,s.sha256?.framing],[policy,s.sha256?.policy]];
for(const[p,h]of checks){const st=lstatSync(p);if(!st.isFile()||st.isSymbolicLink()||createHash("sha256").update(readFileSync(p)).digest("hex")!==h)process.exit(1)}
NODE
 manifest_matches||fail "manifest modified since install; rollback refused."
 for p in "$MANIFEST" "$LAUNCHER" "$INSTALLED_ENTRY" "$INSTALLED_HOST" "$INSTALLED_FRAMING" "$INSTALLED_POLICY" "$STATE";do secure_file "$p" 16384||fail "installer artifact owner/mode invalid; rollback refused.";done
 rm -- "$MANIFEST" "$LAUNCHER" "$INSTALLED_ENTRY" "$INSTALLED_HOST" "$INSTALLED_FRAMING" "$INSTALLED_POLICY" "$STATE"
 pass "removed only byte-identical installer-owned artifacts."
}
case "$mode" in inspect)inspect;;install)install_host;;verify)verify;;rollback)rollback;;esac
