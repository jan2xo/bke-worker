#!/usr/bin/env bash
set -Eeuo pipefail
ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd -P)"
SCRIPT="$ROOT/scripts/prepare-chrome-native-host.sh"
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT
mkdir -p "$tmp/repo/scripts" "$tmp/repo/browser-extension/native-host" "$tmp/home" "$tmp/policy"
cp "$SCRIPT" "$tmp/repo/scripts/prepare-chrome-native-host.sh"
cp "$ROOT/browser-extension/native-host/entry.mjs" "$tmp/repo/browser-extension/native-host/"
cp "$ROOT/browser-extension/native-host/host.mjs" "$tmp/repo/browser-extension/native-host/"
cp "$ROOT/browser-extension/native-host/framing.mjs" "$tmp/repo/browser-extension/native-host/"
# A policy fixture is tested separately by Node policy validation; never install on the host.
chmod 700 "$tmp"
export HOME="$tmp/home"
mkdir -p "$HOME"
# Read-only inspect under simulated roots must not create registration artifacts.
mkdir -p "$tmp/sandbox"
BKE_NATIVE_HOST_TEST_ROOT="$tmp/sandbox" bash "$SCRIPT" inspect </dev/null
test ! -e "$tmp/sandbox/chrome/NativeMessagingHosts/com.bke.worker.native_host.json"
if BKE_NATIVE_HOST_TEST_ROOT="$tmp/sandbox" bash "$SCRIPT" bogus </dev/null 2>/dev/null; then
  echo "unsupported mode unexpectedly passed" >&2; exit 1
fi
if BKE_NATIVE_HOST_TEST_ROOT="$tmp/sandbox" bash "$SCRIPT" inspect </dev/null 2>/dev/null; then
  echo "missing extension origin unexpectedly passed" >&2; exit 1
fi
# Origin validation rejects malformed origins without touching Chrome locations.
if BKE_NATIVE_HOST_TEST_ROOT="$tmp/sandbox" BKE_NATIVE_HOST_EXTENSION_ORIGIN='https://example.invalid/' bash "$SCRIPT" inspect >/dev/null 2>&1; then
  echo "web origin unexpectedly passed" >&2; exit 1
fi
# Source-only lock checks.
if grep -Eq 'chrome\.runtime\.connectNative|nativeMessaging' "$ROOT/browser-extension/manifest.json"; then
  echo "extension manifest unexpectedly enables native messaging" >&2; exit 1
fi
if grep -Eq 'wrangler deploy|gh workflow run|cloudflare' "$SCRIPT"; then
  echo "installer unexpectedly contains activation/deployment path" >&2; exit 1
fi
bash -n "$SCRIPT"
echo "BKE Chrome native host installer contract: PASS"
