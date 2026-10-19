#!/usr/bin/env bash
set -Eeuo pipefail
ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd -P)"
SCRIPT="$ROOT/scripts/prepare-chrome-native-host.sh"
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT
mkdir -p "$tmp/repo/scripts" "$tmp/repo/browser-extension/native-host" "$tmp/home" "$tmp/sandbox"
cp "$SCRIPT" "$tmp/repo/scripts/"
for f in entry.mjs host.mjs framing.mjs; do cp "$ROOT/browser-extension/native-host/$f" "$tmp/repo/browser-extension/native-host/$f"; done
export HOME="$tmp/home"
# Inspect needs no origin when the manifest is absent and must never create registration.
BKE_NATIVE_HOST_TEST_ROOT="$tmp/sandbox" bash "$SCRIPT" inspect </dev/null
test ! -e "$tmp/sandbox/chrome/NativeMessagingHosts/com.bke.worker.native_host.json"
if BKE_NATIVE_HOST_TEST_ROOT="$tmp/sandbox" bash "$SCRIPT" bogus </dev/null 2>/dev/null; then
  echo "unsupported mode unexpectedly passed" >&2; exit 1
fi
if BKE_NATIVE_HOST_TEST_ROOT="$tmp/sandbox" BKE_NATIVE_HOST_EXTENSION_ORIGIN='https://example.invalid/' bash "$SCRIPT" inspect </dev/null 2>/dev/null; then
  echo "invalid origin unexpectedly passed" >&2; exit 1
fi
if BKE_NATIVE_HOST_TEST_ROOT="$tmp/sandbox" BKE_NATIVE_HOST_EXTENSION_ORIGIN="chrome-extension://$(printf 'a%.0s' {1..32})/" bash "$SCRIPT" verify </dev/null 2>/dev/null; then
  echo "verify unexpectedly passed without manifest/policy" >&2; exit 1
fi
# Invalid test root is rejected before any creation.
if BKE_NATIVE_HOST_TEST_ROOT="$tmp/not-created" bash "$SCRIPT" inspect </dev/null 2>/dev/null; then
  echo "missing test root unexpectedly passed" >&2; exit 1
fi
test ! -e "$tmp/not-created"
# Explicitly preserve nativeMessaging permission lock and no production activation.
! grep -Eq 'nativeMessaging' "$ROOT/browser-extension/manifest.json"
! grep -Eq 'wrangler deploy|gh workflow run|cloudflare|production' "$SCRIPT"
bash -n "$SCRIPT"
echo "BKE Chrome native host installer contract: PASS"
