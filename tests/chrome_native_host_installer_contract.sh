#!/usr/bin/env bash
set -Eeuo pipefail
ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd -P)"
SCRIPT="$ROOT/scripts/prepare-chrome-native-host.sh"
tmp="$(mktemp -d)"; trap 'rm -rf "$tmp"' EXIT
sandbox="$tmp/sandbox"; mkdir -m 700 "$sandbox"
export HOME="$tmp/home"; mkdir -m 700 "$HOME"
origin="chrome-extension://$(printf 'a%.0s' {1..32})/"
BKE_NATIVE_HOST_TEST_ROOT="$sandbox" BKE_NATIVE_HOST_EXTENSION_ORIGIN="$origin" bash "$SCRIPT" inspect </dev/null
test ! -e "$sandbox/chrome"
if BKE_NATIVE_HOST_TEST_ROOT="$sandbox" BKE_NATIVE_HOST_EXTENSION_ORIGIN="$origin" bash "$SCRIPT" unknown </dev/null 2>/dev/null; then exit 1; fi
if BKE_NATIVE_HOST_TEST_ROOT="$sandbox" BKE_NATIVE_HOST_EXTENSION_ORIGIN='https://example.invalid/' bash "$SCRIPT" inspect </dev/null 2>/dev/null; then exit 1; fi
if BKE_NATIVE_HOST_TEST_ROOT="$tmp/not-created" BKE_NATIVE_HOST_EXTENSION_ORIGIN="$origin" bash "$SCRIPT" inspect </dev/null 2>/dev/null; then exit 1; fi
test ! -e "$tmp/not-created"
! grep -Eq 'nativeMessaging' "$ROOT/browser-extension/manifest.json"
! grep -Eq 'wrangler deploy|gh workflow run|cloudflare|PREPRODUCTION' "$SCRIPT"
bash -n "$SCRIPT"
echo "BKE Chrome native host installer contract: PASS"
