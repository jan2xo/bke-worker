#!/usr/bin/env bash
set -euo pipefail

SIDECAR_PACKAGE="com.bke.worker.gecko.recoverycert"
SIGNING_ENV_FILE="${BKE_ANDROID_PREPRODUCTION_ENV_FILE:-$HOME/.bke-secrets/bke-worker-android-preproduction.env}"
OUTPUT_ROOT="${BKE_ANDROID_RECOVERY_LOCAL_OUTPUT_ROOT:-}"
EXPECTED_SHA="${BKE_ANDROID_RECOVERY_EXPECTED_SHA:-}"
OFFLINE="${BKE_ANDROID_GRADLE_OFFLINE:-1}"
TEMP_KEYSTORE=""

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
ROOT_DIR="$(git -C "$SCRIPT_DIR/.." rev-parse --show-toplevel 2>/dev/null || true)"

fail() {
  echo "BKE ANDROID LOCAL RECOVERY BUILD: FAIL-CLOSED — $*" >&2
  exit 1
}

cleanup() {
  if [[ -n "$TEMP_KEYSTORE" ]]; then
    rm -f -- "$TEMP_KEYSTORE"
  fi
}
trap cleanup EXIT

sha256_file() {
  if command -v shasum >/dev/null 2>&1; then
    shasum -a 256 "$1" | awk '{print $1}'
  elif command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$1" | awk '{print $1}'
  else
    fail "shasum or sha256sum is required"
  fi
}

resolve_android_tool() {
  local tool="$1"
  if command -v "$tool" >/dev/null 2>&1; then
    command -v "$tool"
    return
  fi

  local sdk_root candidate
  for sdk_root in "${ANDROID_SDK_ROOT:-}" "${ANDROID_HOME:-}" "$HOME/Library/Android/sdk"; do
    [[ -n "$sdk_root" && -d "$sdk_root" ]] || continue
    if [[ "$tool" == "apksigner" ]]; then
      candidate="$(find "$sdk_root/build-tools" -type f -name apksigner 2>/dev/null | sort | tail -n 1)"
    else
      candidate="$(find "$sdk_root/cmdline-tools" -type f -path '*/bin/apkanalyzer' 2>/dev/null | sort | tail -n 1)"
    fi
    if [[ -n "$candidate" ]]; then
      printf '%s\n' "$candidate"
      return
    fi
  done

  fail "Android SDK tool not found: $tool"
}

require_clean_tracked_source() {
  git -C "$ROOT_DIR" diff --quiet --ignore-submodules -- ||
    fail "tracked source has unstaged changes; commit/pull before building"
  git -C "$ROOT_DIR" diff --cached --quiet --ignore-submodules -- ||
    fail "tracked source has staged changes; commit/pull before building"
}

load_signing_environment() {
  if [[ -f "$SIGNING_ENV_FILE" ]]; then
    chmod 600 "$SIGNING_ENV_FILE" 2>/dev/null || true
    set -a
    # shellcheck disable=SC1090
    source "$SIGNING_ENV_FILE"
    set +a
  fi

  [[ -n "${BKE_ANDROID_PREPRODUCTION_STORE_PASSWORD:-}" ]] ||
    fail "missing BKE_ANDROID_PREPRODUCTION_STORE_PASSWORD"
  [[ -n "${BKE_ANDROID_PREPRODUCTION_KEY_ALIAS:-}" ]] ||
    fail "missing BKE_ANDROID_PREPRODUCTION_KEY_ALIAS"
  [[ -n "${BKE_ANDROID_PREPRODUCTION_KEY_PASSWORD:-}" ]] ||
    fail "missing BKE_ANDROID_PREPRODUCTION_KEY_PASSWORD"
  if [[ -n "${BKE_ANDROID_PREPRODUCTION_KEYSTORE_PATH:-}" ]]; then
    [[ -f "$BKE_ANDROID_PREPRODUCTION_KEYSTORE_PATH" ]] ||
      fail "BKE_ANDROID_PREPRODUCTION_KEYSTORE_PATH does not exist"
    return
  fi

  [[ -n "${BKE_ANDROID_PREPRODUCTION_KEYSTORE_B64:-}" ]] ||
    fail "provide BKE_ANDROID_PREPRODUCTION_KEYSTORE_PATH or BKE_ANDROID_PREPRODUCTION_KEYSTORE_B64"

  umask 077
  TEMP_KEYSTORE="$(mktemp "${TMPDIR:-/tmp}/bke-recovery-preproduction.XXXXXX.jks")"
  if base64 --decode </dev/null >/dev/null 2>&1; then
    printf '%s' "$BKE_ANDROID_PREPRODUCTION_KEYSTORE_B64" | base64 --decode >"$TEMP_KEYSTORE"
  else
    printf '%s' "$BKE_ANDROID_PREPRODUCTION_KEYSTORE_B64" | base64 -D >"$TEMP_KEYSTORE"
  fi
  export BKE_ANDROID_PREPRODUCTION_KEYSTORE_PATH="$TEMP_KEYSTORE"
}

select_gradle() {
  if command -v gradle >/dev/null 2>&1; then
    GRADLE=(gradle)
    return
  fi
  if [[ -f "$ROOT_DIR/android-gecko/gradlew" ]]; then
    GRADLE=(bash "$ROOT_DIR/android-gecko/gradlew")
    return
  fi
  fail "Gradle is unavailable; install Gradle or provide android-gecko/gradlew locally"
}

main() {
  [[ -n "$ROOT_DIR" ]] || fail "run from a BKE Worker checkout"
  require_clean_tracked_source

  local source_sha
  source_sha="$(git -C "$ROOT_DIR" rev-parse HEAD)"
  [[ "$source_sha" =~ ^[0-9a-f]{40}$ ]] || fail "unable to resolve source SHA"

  if [[ -n "$EXPECTED_SHA" ]]; then
    [[ "$source_sha" == "$EXPECTED_SHA" ]] ||
      fail "local source is not expected exact head: expected $EXPECTED_SHA, got $source_sha"
  fi

  if [[ -z "$OUTPUT_ROOT" ]]; then
    OUTPUT_ROOT="$ROOT_DIR/artifacts/android-recovery-local"
  fi

  load_signing_environment
  select_gradle

  local gradle_args
  gradle_args=(-p "$ROOT_DIR/android-gecko" :app:assembleRecovery --stacktrace)
  if [[ "$OFFLINE" == "1" ]]; then
    gradle_args+=(--offline)
  elif [[ "$OFFLINE" != "0" ]]; then
    fail "BKE_ANDROID_GRADLE_OFFLINE must be 0 or 1"
  fi

  echo "BKE LOCAL BUILD: source=$source_sha"
  if [[ "$OFFLINE" == "1" ]]; then
    echo "BKE LOCAL BUILD: Gradle offline mode enabled; cached dependencies only."
  fi

  if ! "${GRADLE[@]}" "${gradle_args[@]}"; then
    if [[ "$OFFLINE" == "1" ]]; then
      fail "offline Gradle build failed; when cheap connectivity is available rerun with BKE_ANDROID_GRADLE_OFFLINE=0"
    fi
    fail "Gradle recovery APK build failed"
  fi

  local apk apksigner apkanalyzer signer_sha expected_signer debuggable package_name version_name version_code
  apk="$ROOT_DIR/android-gecko/app/build/outputs/apk/recovery/app-recovery.apk"
  [[ -f "$apk" ]] || fail "Gradle completed without recovery APK"

  apksigner="$(resolve_android_tool apksigner)"
  apkanalyzer="$(resolve_android_tool apkanalyzer)"

  local signer_report
  signer_report="$(mktemp "${TMPDIR:-/tmp}/bke-recovery-signer.XXXXXX.txt")"
  trap 'rm -f -- "$signer_report"; cleanup' EXIT

  "$apksigner" verify --verbose --print-certs "$apk" >"$signer_report"
  signer_sha="$(
    sed -n 's/^Signer #1 certificate SHA-256 digest: //p' "$signer_report" |
      head -n 1 |
      tr '[:upper:]' '[:lower:]' |
      tr -d ':[:space:]'
  )"
  expected_signer="$(
    tr '[:upper:]' '[:lower:]' < "$ROOT_DIR/android-gecko/preproduction-signing-cert.sha256" |
      tr -d ':[:space:]'
  )"
  [[ "$expected_signer" =~ ^[0-9a-f]{64}$ ]] || fail "repo-pinned PREPRODUCTION signer fingerprint is invalid"
  [[ "$signer_sha" =~ ^[0-9a-f]{64}$ ]] || fail "unable to verify recovery APK signer"
  [[ "$signer_sha" == "$expected_signer" ]] || fail "recovery APK signer is not repo-pinned PREPRODUCTION authority"

  if [[ -n "${BKE_ANDROID_PREPRODUCTION_CERT_SHA256:-}" ]]; then
    local environment_signer
    environment_signer="$(
      printf '%s' "$BKE_ANDROID_PREPRODUCTION_CERT_SHA256" |
        tr '[:upper:]' '[:lower:]' |
        tr -d ':[:space:]'
    )"
    [[ "$environment_signer" == "$expected_signer" ]] ||
      fail "local PREPRODUCTION signer metadata conflicts with repo-pinned fingerprint"
  fi

  debuggable="$("$apkanalyzer" manifest debuggable "$apk" | tr '[:upper:]' '[:lower:]' | tr -d '[:space:]')"
  package_name="$("$apkanalyzer" manifest application-id "$apk" | tr -d '[:space:]')"
  version_name="$("$apkanalyzer" manifest version-name "$apk" | tr -d '[:space:]')"
  version_code="$("$apkanalyzer" manifest version-code "$apk" | tr -d '[:space:]')"

  [[ "$debuggable" == "true" ]] || fail "recovery APK must remain debuggable"
  [[ "$package_name" == "$SIDECAR_PACKAGE" ]] || fail "unexpected recovery package: $package_name"
  [[ "$version_name" == *"-recoverycert" ]] || fail "unexpected recovery version name: $version_name"
  [[ "$version_code" == "1" ]] || fail "unexpected recovery version code: $version_code"

  local output_dir output_apk apk_sha manifest
  output_dir="$OUTPUT_ROOT/$source_sha"
  mkdir -p "$output_dir"
  output_apk="$output_dir/BKE.Worker.Android.RECOVERY-CERT.arm64-v${version_name}.apk"
  cp "$apk" "$output_apk"
  apk_sha="$(sha256_file "$output_apk")"
  manifest="$output_dir/manifest.json"

  SOURCE_SHA="$source_sha" \
  APK_SHA256="$apk_sha" \
  SIGNER_SHA256="$signer_sha" \
  VERSION_NAME="$version_name" \
  VERSION_CODE="$version_code" \
  OUTPUT_APK="$output_apk" \
  python3 - "$manifest" <<'PY'
import json
import os
import sys
from pathlib import Path

manifest = {
    "source_sha": os.environ["SOURCE_SHA"],
    "build_origin": "local-exact-head",
    "component": "BKE Worker Android Recovery Cert",
    "package_name": "com.bke.worker.gecko.recoverycert",
    "architecture": "arm64-v8a",
    "version_name": os.environ["VERSION_NAME"],
    "version_code": int(os.environ["VERSION_CODE"]),
    "sha256": os.environ["APK_SHA256"],
    "signer_certificate_sha256": os.environ["SIGNER_SHA256"],
    "signing_authority": "PREPRODUCTION",
    "certification_state": "recovery-cert-local-build",
    "apk_file": Path(os.environ["OUTPUT_APK"]).name,
}
Path(sys.argv[1]).write_text(json.dumps(manifest, indent=2) + "\n", encoding="utf-8")
PY

  rm -f -- "$signer_report"
  trap cleanup EXIT

  echo "BKE ANDROID LOCAL RECOVERY BUILD: PASS"
  echo "Source: $source_sha"
  echo "APK: $output_apk"
  echo "APK SHA-256: $apk_sha"
  echo "Signer: PREPRODUCTION / $signer_sha"
  echo "Network artifact download: NONE"
}

main "$@"
