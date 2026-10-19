#!/usr/bin/env bash
set -Eeuo pipefail
ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd -P)"
SCRIPT="$ROOT/scripts/prepare-chrome-native-host.sh"
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT
sandbox="$tmp/sandbox"; mkdir -m 700 "$sandbox"
export HOME="$tmp/home"; mkdir -m 700 "$HOME"
# Read-only inspection without a real extension ID or any registration write.
BKE_NATIVE_HOST_TEST_ROOT="$sandbox" bash "$SCRIPT" inspect </dev/null
test ! -e "$sandbox/chrome/NativeMessagingHosts/com.bke.worker.native_host.json"
if BKE_NATIVE_HOST_TEST_ROOT="$sandbox" bash "$SCRIPT" bogus </dev/null 2>/dev/null; then
  echo "unknown mode unexpectedly passed" >&2; exit 1
fi
if BKE_NATIVE_HOST_TEST_ROOT="$sandbox" BKE_NATIVE_HOST_EXTENSION_ORIGIN='https://example.invalid/' bash "$SCRIPT" inspect </dev/null 2>/dev/null; then
  echo "invalid extension origin unexpectedly passed" >&2; exit 1
fi
if BKE_NATIVE_HOST_TEST_ROOT="$tmp/not-created" bash "$SCRIPT" inspect </dev/null 2>/dev/null; then
  echo "missing test root unexpectedly passed" >&2; exit 1
fi
test ! -e "$tmp/not-created"
! grep -Eq 'nativeMessaging' "$ROOT/browser-extension/manifest.json"
! grep -Eq 'wrangler deploy|gh workflow run|cloudflare|PREPRODUCTION' "$SCRIPT"
bash -n "$SCRIPT"
echo "BKE Chrome native host installer contract: PASS"
