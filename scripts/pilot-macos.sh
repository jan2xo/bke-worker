#!/usr/bin/env bash
set -euo pipefail

# Human-operated single-command Mac entrypoint; sends via existing .NET/CDP.
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
if [[ "$(uname -s)" != "Darwin" ]]; then
  echo "ERROR: This entrypoint requires macOS; no browser or send attempted." >&2
  exit 2
fi

missing=""
for tool in python3 gh dotnet jq curl open; do
  if ! command -v "$tool" >/dev/null 2>&1; then
    missing="$missing $tool"
  fi
done
if [[ -n "$missing" ]]; then
  printf 'ERROR: Missing Mac tools:%s\n' "$missing" >&2
  echo 'Install missing prerequisites with Homebrew: gh, jq, python, dotnet-sdk.' >&2
  exit 2
fi
if ! dotnet --list-sdks | grep -Eq '^10\.'; then
  echo "ERROR: .NET 10 SDK required (brew install --cask dotnet-sdk)." >&2
  exit 2
fi

if ! gh auth status >/dev/null 2>&1; then
  echo "GitHub CLI needs HUMAN login (interactive authentication follows)."
  gh auth login --hostname github.com --web
  gh auth status >/dev/null
fi

APP="/Applications/Google Chrome.app"
if [[ ! -d "$APP" ]]; then APP="$HOME/Applications/Google Chrome.app"; fi
if [[ ! -d "$APP" ]]; then
  echo "ERROR: Google Chrome.app not found in /Applications or ~/Applications." >&2
  exit 2
fi
PROFILE="$HOME/Library/Application Support/BKE-Worker/pilot-f1-profile"
CDP="http://127.0.0.1:9222"
if curl -fsS --max-time 2 "$CDP/json/version" >/dev/null 2>&1; then
  echo "ERROR: Port 9222 is occupied. Will not connect to an unknown profile." >&2
  exit 2
fi
mkdir -p "$PROFILE"
chmod 700 "$PROFILE"
export BKE_WORKER_ID="pilot-f1"
export BKE_WORKER_BROWSER_CDP_ENDPOINT="$CDP"
export BKE_WORKER_CHATGPT_PROFILE="$PROFILE"

echo "Opening a separate Mac Chrome profile. Normal Chrome remains untouched."
open -n -a "$APP" --args \
  "--user-data-dir=$PROFILE" \
  "--remote-debugging-address=127.0.0.1" \
  "--remote-debugging-port=9222" \
  "https://chatgpt.com/"
echo "In that browser, manually sign in to ChatGPT and open one dedicated chat."
echo "OAuth/MFA/CAPTCHA and all browser authentication remain HUMAN-ONLY."
read -r -p "Once signed in and your dedicated chat is open, press Enter: " answer

if ! curl -fsS --max-time 4 "$CDP/json/version" >/dev/null; then
  echo "ERROR: Dedicated Mac Chrome CDP is not available; nothing sent." >&2
  exit 2
fi
read -r -p "Paste the full dedicated chat URL (https://chatgpt.com/c/...): " CHAT_URL
export BKE_WORKER_CHATGPT_OVERRIDE_URL="$CHAT_URL"

cd "$ROOT"
echo "Running 10 focused tests and read-only PR #148 dry run..."
python3 tests/sandbox_single_worker_contract.py
result="$(python3 scripts/sandbox_single_worker.py --once)"
echo "$result"
case "$result" in
  DRY_RUN_READY:*:PR#148) ;;
  *)
    echo "ERROR: Pilot PR #148 not ready. No ChatGPT message sent." >&2
    exit 2
    ;;
esac

echo
echo "Pilot: only PR #148, maximum TWO messages at least 30 minutes apart."
echo "Ctrl-C stops the process; remove bke-worker:pilot-f1 to stop future wakes."
read -r -p "Type SEND to authorize actual ChatGPT pilot messages (Enter cancels): " choice
if [[ "$choice" != "SEND" ]]; then
  echo "Cancelled. No live messages sent."
  exit 0
fi
export BKE_SANDBOX_LIVE_SEND_ENABLED="YES"
exec python3 scripts/sandbox_single_worker.py --live
