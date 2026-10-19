#!/usr/bin/env bash
# Source-only-safe Chrome native messaging installer preparation.
# No commands run at import time except read-only discovery. Install is explicit.
set -Eeuo pipefail
umask 077

readonly HOST_NAME="com.bke.worker.native_host"
readonly EXTENSION_ROOT_REL="browser-extension/native-host"
readonly HOST_ENTRY_REL="browser-extension/native-host/entry.mjs"
readonly STATE_DIR_NAME=".bke-native-host-installer"
readonly MAX_POLICY_BYTES=4096

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
if ! ROOT_DIR="$(git -C "$SCRIPT_DIR/.." rev-parse --show-toplevel 2>/dev/null)"; then
  printf '%s\n' 'FAIL-CLOSED: entrypoint is not inside a Git checkout.' >&2
  exit 2
fi
ROOT_DIR="$(cd -- "$ROOT_DIR" && pwd -P)"
readonly ROOT_DIR

fail() { printf 'FAIL-CLOSED: %s\n' "$1" >&2; exit 2; }
pass() { printf 'PASS: %s\n' "$1"; }
note() { printf 'INFO: %s\n' "$1"; }

OS="$(uname -s)"
case "$OS" in
  Darwin|Linux) ;;
  *) fail "unsupported operating system: $OS (only macOS/Linux are supported)" ;;
esac

command -v node >/dev/null 2>&1 || fail "Node.js is required."
NODE_BIN="$(command -v node)"
[[ "$NODE_BIN" = /* && -f "$NODE_BIN" && ! -L "$NODE_BIN" ]] || fail "Node executable must resolve to a non-symlink absolute file."
NODE_VERSION="$("$NODE_BIN" -p 'Number(process.versions.node.split(".")[0])' 2>/dev/null)" || fail "unable to inspect Node.js runtime."
[[ "$NODE_VERSION" =~ ^[0-9]+$ && "$NODE_VERSION" -ge 22 ]] || fail "Node.js 22 or newer is required."

HOST_ENTRY="$ROOT_DIR/$HOST_ENTRY_REL"
[[ -f "$HOST_ENTRY" && ! -L "$HOST_ENTRY" ]] || fail "native host entry is missing or symlinked."
HOST_DIR="$(cd -- "$(dirname -- "$HOST_ENTRY")" && pwd -P)"
[[ "$HOST_DIR" = "$ROOT_DIR/$EXTENSION_ROOT_REL" ]] || fail "native host directory canonical path mismatch."
[[ -f "$HOST_DIR/entry.mjs" && -f "$HOST_DIR/host.mjs" && -f "$HOST_DIR/framing.mjs" ]] || fail "native host source set is incomplete."

# Chrome user-level native host registry locations.
case "$OS" in
  Darwin)
    CHROME_HOST_DIR="${HOME%/}/Library/Application Support/Google/Chrome/NativeMessagingHosts"
    ;;
  Linux)
    CHROME_HOST_DIR="${XDG_CONFIG_HOME:-${HOME%/}/.config}/google-chrome/NativeMessagingHosts"
    ;;
esac
CHROME_HOST_MANIFEST="$CHROME_HOST_DIR/$HOST_NAME.json"
LAUNCHER_HOME="${HOME%/}/.local/lib/bke-worker/native-host"
LAUNCHER_PATH="$LAUNCHER_HOME/launch-native-host.sh"
POLICY_HOME="${HOME%/}/.config/bke-worker/native-host"
POLICY_PATH="$POLICY_HOME/owner-policy.json"
STATE_HOME="${HOME%/}/$STATE_DIR_NAME"
STATE_PATH="$STATE_HOME/transaction.json"

# Tests may redirect every user-state path into a disposable home. Production
# paths remain the default; this variable is not interpreted as authorization.
if [[ "${BKE_NATIVE_HOST_TEST_ROOT:-}" != "" ]]; then
  [[ "${BKE_NATIVE_HOST_TEST_ROOT}" = /* ]] || fail "test root must be absolute."
  TEST_ROOT="$(cd -- "${BKE_NATIVE_HOST_TEST_ROOT}" 2>/dev/null && pwd -P)" || fail "test root must already exist."
  CHROME_HOST_DIR="$TEST_ROOT/chrome/NativeMessagingHosts"
  CHROME_HOST_MANIFEST="$CHROME_HOST_DIR/$HOST_NAME.json"
  LAUNCHER_HOME="$TEST_ROOT/launcher"
  LAUNCHER_PATH="$LAUNCHER_HOME/launch-native-host.sh"
  POLICY_HOME="$TEST_ROOT/policy"
  POLICY_PATH="$POLICY_HOME/owner-policy.json"
  STATE_HOME="$TEST_ROOT/state"
  STATE_PATH="$STATE_HOME/transaction.json"
fi

valid_origin() {
  [[ "$1" =~ ^chrome-extension://[a-p]{32}/$ ]]
}

secure_file() {
  local path="$1" max_bytes="$2"
  [[ -f "$path" && ! -L "$path" ]] || return 1
  [[ "$(cd -- "$(dirname -- "$path")" && pwd -P)/$(basename -- "$path")" = "$path" ]] || return 1
  local mode owner size self
  mode="$(stat -c '%a' "$path" 2>/dev/null || stat -f '%Lp' "$path" 2>/dev/null)" || return 1
  owner="$(stat -c '%u' "$path" 2>/dev/null || stat -f '%u' "$path" 2>/dev/null)" || return 1
  self="$(id -u)"
  size="$(wc -c < "$path" | tr -d '[:space:]')"
  [[ "$owner" = "$self" && "$size" -le "$max_bytes" ]] || return 1
  # Strip leading zeros for numeric comparisons and require no group/world writes.
  mode="$((8#$mode))"
  (( (mode & 0022) == 0 )) || return 1
}

safe_dir() {
  local path="$1"
  if [[ -e "$path" || -L "$path" ]]; then
    [[ -d "$path" && ! -L "$path" ]] || return 1
    local owner mode
    owner="$(stat -c '%u' "$path" 2>/dev/null || stat -f '%u' "$path" 2>/dev/null)" || return 1
    mode="$(stat -c '%a' "$path" 2>/dev/null || stat -f '%Lp' "$path" 2>/dev/null)" || return 1
    [[ "$owner" = "$(id -u)" ]] || return 1
    mode="$((8#$mode))"
    (( (mode & 0022) == 0 )) || return 1
  fi
}

ensure_dir() {
  local path="$1"
  safe_dir "$path" || fail "unsafe directory: $path"
  if [[ ! -d "$path" ]]; then
    mkdir -p -- "$path" || fail "cannot create directory: $path"
    chmod 700 "$path"
  fi
  safe_dir "$path" || fail "directory ownership/mode validation failed."
}

discover_origin() {
  local found="${BKE_NATIVE_HOST_EXTENSION_ORIGIN:-}"
  if [[ -z "$found" && -f "$ROOT_DIR/browser-extension/manifest.json" ]]; then
    # Chrome unpacked extensions require a generated 32-letter extension ID;
    # manifest source does not reliably determine it. Never guess one.
    found=""
  fi
  if [[ -z "$found" ]]; then
    if [[ ! -t 0 ]]; then fail "extension origin is not discoverable; provide it interactively or set for an audited call."; fi
    printf '%s' 'Chrome extension origin (chrome-extension:// followed by 32 letters a-p): ' >&2
    IFS= read -r found || fail "no origin provided."
  fi
  valid_origin "$found" || fail "extension origin is malformed; expected chrome-extension://[a-p]{32}/"
  printf '%s' "$found"
}

json_string() {
  "$NODE_BIN" -e 'process.stdout.write(JSON.stringify(process.argv[1]))' "$1"
}

# Parse the current owner-pinned policy without printing its values.
check_policy() {
  local policy="$1" origin="$2"
  [[ "$policy" = /* && -f "$policy" && ! -L "$policy" ]] || fail "owner policy must be an existing absolute, non-symlink file."
  secure_file "$policy" "$MAX_POLICY_BYTES" || fail "owner policy is not owned by this user or has unsafe mode/size."
  "$NODE_BIN" --input-type=module - "$HOST_DIR/host.mjs" "$policy" "$origin" <<'NODE' || fail "owner policy does not satisfy the existing native host contract."
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
const [hostPath, policyPath, origin] = process.argv.slice(2);
const { validNativeHostPolicy } = await import(pathToFileURL(hostPath).href);
const raw = readFileSync(policyPath, "utf8");
if (Buffer.byteLength(raw) > 4096) process.exit(1);
const policy = JSON.parse(raw);
if (!validNativeHostPolicy(policy) || policy.allowed_origin !== origin) process.exit(1);
process.stdout.write("policy-valid\n");
NODE
}

origin=""
mode="${1:-inspect}"
[[ $# -le 1 ]] || fail "usage: bash scripts/prepare-chrome-native-host.sh [inspect|install|verify|rollback]"
case "$mode" in inspect|install|verify|rollback) ;; *) fail "unknown mode: $mode" ;; esac

if [[ "$mode" != "rollback" ]]; then
  origin="$(discover_origin)"
  if [[ -n "${BKE_NATIVE_HOST_POLICY_PATH:-}" ]]; then POLICY_PATH="$BKE_NATIVE_HOST_POLICY_PATH"; fi
  if [[ "$mode" = "install" || "$mode" = "verify" ]]; then check_policy "$POLICY_PATH" "$origin"; fi
fi

render_launcher() {
  cat <<'LAUNCHER'
#!/usr/bin/env bash
set -Eeuo pipefail
# Chrome passes origin in argv[1]; the installer supplies the absolute pinned policy path.
HERE="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
POLICY="$HERE/owner-policy.json"
ENTRY="$HERE/entry.mjs"
NODE="__BKE_NODE__"
[[ "$#" -eq 1 && "$1" =~ ^chrome-extension://[a-p]{32}/$ ]] || exit 2
[[ -f "$POLICY" && ! -L "$POLICY" && -f "$ENTRY" && ! -L "$ENTRY" ]] || exit 2
exec "$NODE" "$ENTRY" "$POLICY" "$1"
LAUNCHER
}

manifest_matches() {
  [[ -f "$CHROME_HOST_MANIFEST" && ! -L "$CHROME_HOST_MANIFEST" ]] || return 1
  "$NODE_BIN" - "$CHROME_HOST_MANIFEST" "$LAUNCHER_PATH" "$origin" <<'NODE'
import { readFileSync } from "node:fs";
const [manifestPath, path, origin] = process.argv.slice(2);
let x;
try { x = JSON.parse(readFileSync(manifestPath, "utf8")); } catch { process.exit(1); }
const keys = ["allowed_origins","description","name","path","type"].sort().join(",");
if (!x || typeof x !== "object" || Array.isArray(x) ||
    Object.keys(x).sort().join(",") !== keys ||
    x.name !== "com.bke.worker.native_host" ||
    x.type !== "stdio" || x.path !== path ||
    x.description !== "BKE Worker local native host (source-only preparation)" ||
    !Array.isArray(x.allowed_origins) || x.allowed_origins.length !== 1 ||
    x.allowed_origins[0] !== origin) process.exit(1);
NODE
}

inspect() {
  note "OS=$OS; Node major=$NODE_VERSION"
  note "Chrome user-level manifest target: $CHROME_HOST_MANIFEST"
  note "Launcher target: $LAUNCHER_PATH"
  note "Owner-policy target: $POLICY_PATH"
  if [[ -e "$CHROME_HOST_MANIFEST" || -L "$CHROME_HOST_MANIFEST" ]]; then
    if manifest_matches; then pass "existing registration matches this intent"; else fail "existing registration is unknown/conflicting; no overwrite permitted."; fi
  else note "registration not present; inspect made no changes."; fi
}

verify() {
  manifest_matches || fail "native host manifest is absent, unsafe or does not exactly match."
  secure_file "$CHROME_HOST_MANIFEST" 16384 || fail "native host manifest ownership/mode check failed."
  secure_file "$LAUNCHER_PATH" 16384 || fail "launcher ownership/mode check failed."
  secure_file "$POLICY_PATH" "$MAX_POLICY_BYTES" || fail "policy ownership/mode check failed."
  [[ -x "$LAUNCHER_PATH" ]] || fail "launcher is not executable."
  pass "registration manifest, launcher and policy match expected contract."
}

install_host() {
  [[ -n "${BKE_NATIVE_HOST_TEST_ROOT:-}" || "${BKE_NATIVE_HOST_ALLOW_MUTATION:-}" = "YES" ]] || {
    printf '%s\n' 'This command prepares user-level Chrome registration. It does not grant extension permissions or enroll a device.' >&2
    [[ -t 0 ]] || fail "non-interactive install denied; rerun interactively after reviewing the plan."
    printf '%s' 'Type INSTALL USER-LEVEL CHROME HOST to continue: ' >&2
    local answer; IFS= read -r answer || fail "no acknowledgement received."
    [[ "$answer" = "INSTALL USER-LEVEL CHROME HOST" ]] || fail "installation not acknowledged."
  }
  for d in "$CHROME_HOST_DIR" "$LAUNCHER_HOME" "$POLICY_HOME" "$STATE_HOME"; do ensure_dir "$d"; done
  [[ -f "$POLICY_PATH" && ! -L "$POLICY_PATH" ]] || fail "owner policy must already exist at $POLICY_PATH; this installer will not invent trust pins."
  check_policy "$POLICY_PATH" "$origin"
  if [[ -e "$CHROME_HOST_MANIFEST" || -L "$CHROME_HOST_MANIFEST" ||
        -e "$LAUNCHER_PATH" || -L "$LAUNCHER_PATH" ||
        -e "$LAUNCHER_HOME/entry.mjs" || -L "$LAUNCHER_HOME/entry.mjs" ||
        -e "$STATE_PATH" || -L "$STATE_PATH" ]]; then
    if manifest_matches && verify; then pass "registration already matches; idempotent no-op."; return; fi
    fail "refusing to overwrite unknown registration, launcher, or transaction state."
  fi

  # Stage only in directories just created/validated, then atomically rename.
  local tmp_manifest tmp_launcher tmp_entry tmp_policy nodeq
  tmp_manifest="$(mktemp "$CHROME_HOST_DIR/.bke-manifest.XXXXXX")"
  tmp_launcher="$(mktemp "$LAUNCHER_HOME/.bke-launcher.XXXXXX")"
  tmp_entry="$(mktemp "$LAUNCHER_HOME/.bke-entry.XXXXXX")"
  tmp_policy="$(mktemp "$LAUNCHER_HOME/.bke-policy.XXXXXX")"
  local committed=0
  cleanup_staged() {
    if [[ "$committed" -eq 0 ]]; then rm -f -- "$tmp_manifest" "$tmp_launcher" "$tmp_entry" "$tmp_policy"; fi
  }
  trap cleanup_staged RETURN
  sed "s|__BKE_NODE__|$(printf '%s' "$NODE_BIN" | sed 's/[&|]/\\&/g')|" < <(render_launcher) > "$tmp_launcher"
  cp -- "$HOST_ENTRY" "$tmp_entry"
  cp -- "$POLICY_PATH" "$tmp_policy"
  chmod 700 "$tmp_launcher"
  chmod 600 "$tmp_entry" "$tmp_policy"
  local node_path; node_path="$(json_string "$LAUNCHER_PATH")"
  local origin_json; origin_json="$(json_string "$origin")"
  "$NODE_BIN" - "$tmp_manifest" "$LAUNCHER_PATH" "$origin" <<'NODE'
import { writeFileSync } from "node:fs";
const [out, path, origin] = process.argv.slice(2);
writeFileSync(out, JSON.stringify({
  name:"com.bke.worker.native_host",
  description:"BKE Worker local native host (source-only preparation)",
  path,
  type:"stdio",
  allowed_origins:[origin],
}) + "\n", {mode:0o600, flag:"wx"});
NODE
  chmod 600 "$tmp_manifest"
  # Save previous file bytes/mode is unnecessary because unknown entries were refused;
  # transaction record describes only files this transaction creates.
  "$NODE_BIN" - "$STATE_PATH" "$CHROME_HOST_MANIFEST" "$LAUNCHER_PATH" "$LAUNCHER_HOME/entry.mjs" "$LAUNCHER_HOME/owner-policy.json" "$origin" <<'NODE'
import { writeFileSync } from "node:fs";
const [out, manifest, launcher, entry, policy, origin] = process.argv.slice(2);
writeFileSync(out, JSON.stringify({version:1,host:"com.bke.worker.native_host",manifest,launcher,entry,policy,origin,created_by:"prepare-chrome-native-host.sh"})+"\n", {mode:0o600,flag:"wx"});
NODE
  mv -- "$tmp_launcher" "$LAUNCHER_PATH"
  mv -- "$tmp_entry" "$LAUNCHER_HOME/entry.mjs"
  mv -- "$tmp_policy" "$LAUNCHER_HOME/owner-policy.json"
  mv -- "$tmp_manifest" "$CHROME_HOST_MANIFEST"
  committed=1
  trap - RETURN
  verify
  pass "registration prepared. No browser was launched and no extension permission was granted."
}

rollback() {
  [[ -f "$STATE_PATH" && ! -L "$STATE_PATH" ]] || fail "no transaction record; rollback will not guess."
  secure_file "$STATE_PATH" 8192 || fail "transaction record unsafe."
  "$NODE_BIN" - "$STATE_PATH" "$CHROME_HOST_MANIFEST" "$LAUNCHER_PATH" "$LAUNCHER_HOME/entry.mjs" "$LAUNCHER_HOME/owner-policy.json" <<'NODE' || fail "transaction record or created artifacts differ; preserve state for manual review."
import { readFileSync, lstatSync } from "node:fs";
const [statePath, manifest, launcher, entry, policy] = process.argv.slice(2);
const s = JSON.parse(readFileSync(statePath,"utf8"));
if (s.version !== 1 || s.host !== "com.bke.worker.native_host" ||
    s.manifest !== manifest || s.launcher !== launcher || s.entry !== entry || s.policy !== policy ||
    s.created_by !== "prepare-chrome-native-host.sh") process.exit(1);
for (const p of [manifest,launcher,entry,policy]) { const st=lstatSync(p); if(!st.isFile()||st.isSymbolicLink())process.exit(1); }
NODE
  manifest_matches || fail "manifest has changed since install; rollback refused."
  rm -- "$CHROME_HOST_MANIFEST" "$LAUNCHER_PATH" "$LAUNCHER_HOME/entry.mjs" "$LAUNCHER_HOME/owner-policy.json" "$STATE_PATH"
  pass "removed only the exact installer-owned registration artifacts."
}

case "$mode" in
  inspect) inspect ;;
  install) install_host ;;
  verify) verify ;;
  rollback) rollback ;;
esac
