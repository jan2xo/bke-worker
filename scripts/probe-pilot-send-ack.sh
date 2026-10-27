#!/usr/bin/env bash
set -euo pipefail

# Read-only Mac diagnostic for the ALREADY-DELIVERED first PR #148 pilot turn.
# One operator entrypoint: open only the isolated human-authenticated Chrome profile,
# ask for the dedicated conversation URL, inspect DOM predicates, and report flags.
# Never dispatches, fills a composer, presses Send, changes GitHub or edits the journal.
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
TURN1_HEAD="3c7de7d9740948c294ea3bbd8bcc5a2d515c82ef"
REPO="jan2xo/bke-worker"
BRANCH="feat/sandbox-f1-single-worker-pilot"
CDP="http://127.0.0.1:9222"
PROFILE="$HOME/Library/Application Support/BKE-Worker/pilot-f1-profile"

if [[ "$(uname -s)" != "Darwin" ]]; then
  echo "BLOCKED:MACOS_REQUIRED" >&2; exit 2
fi
for dep in git gh python3 dotnet curl open; do
  if ! command -v "$dep" >/dev/null 2>&1; then
    echo "BLOCKED:MISSING_DEPENDENCY:$dep" >&2; exit 2
  fi
done
cd "$ROOT"
if [[ "$(git branch --show-current)" != "$BRANCH" ]]; then
  echo "BLOCKED:WRONG_IMPLEMENTATION_BRANCH" >&2; exit 2
fi
LOCAL_HEAD="$(git rev-parse HEAD)"
REMOTE_HEAD="$(gh api --method GET "repos/$REPO/pulls/147" --jq '.head.sha')" || {
  echo "BLOCKED:GITHUB_READ_FAILED" >&2; exit 2;
}
if [[ "$LOCAL_HEAD" != "$REMOTE_HEAD" ]]; then
  echo "BLOCKED:IMPLEMENTATION_HEAD_NOT_EXACT" >&2; exit 2
fi

# An unknown endpoint might control somebody else's authenticated browser.
# Fail closed; do not attach to an already-running, unverified CDP instance.
if curl -fsS --max-time 2 "$CDP/json/version" >/dev/null 2>&1; then
  echo "BLOCKED:CDP_PORT_ALREADY_ACTIVE" >&2
  echo "Close only the existing isolated BKE pilot Chrome instance, then rerun." >&2
  exit 2
fi
APP="/Applications/Google Chrome.app"
if [[ ! -d "$APP" ]]; then APP="$HOME/Applications/Google Chrome.app"; fi
if [[ ! -d "$APP" ]]; then
  echo "BLOCKED:GOOGLE_CHROME_NOT_FOUND" >&2; exit 2
fi
mkdir -p "$PROFILE"
chmod 700 "$PROFILE"
export BKE_WORKER_BROWSER_CDP_ENDPOINT="$CDP"
export BKE_WORKER_CHATGPT_PROFILE="$PROFILE"

open -n -a "$APP" --args \
  "--user-data-dir=$PROFILE" \
  "--remote-debugging-address=127.0.0.1" \
  "--remote-debugging-port=9222" \
  "https://chatgpt.com/"

ready=0
for _ in {1..30}; do
  if curl -fsS --max-time 1 "$CDP/json/version" >/dev/null 2>&1; then
    ready=1; break
  fi
  sleep 0.5
done
if [[ "$ready" != 1 ]]; then
  echo "BLOCKED:DEDICATED_CHROME_CDP_UNAVAILABLE" >&2; exit 2
fi

echo "Dedicated pilot Chrome opened. Authenticate manually if needed."
echo "In that SAME Chrome tab, open the EXACT existing pilot conversation; do not open a second ChatGPT tab."
echo "DO NOT send another message."
echo "The worker process remains stopped. This script inspects only."
read -r -p "Press Enter after the original SENT turn and idle composer are visible: " _
read -r -p "Paste the dedicated chat URL (https://chatgpt.com/c/<conversation-id>): " CHAT_URL
if [[ ! "$CHAT_URL" =~ ^https://chatgpt[.]com/c/[A-Za-z0-9-]+/?$ ]]; then
  echo "BLOCKED:INVALID_DEDICATED_CHAT_URL" >&2; exit 2
fi
export BKE_WORKER_CHATGPT_OVERRIDE_URL="$CHAT_URL"
unset CHAT_URL

python3 -B -c '
import importlib.util, sys
spec = importlib.util.spec_from_file_location("p", "scripts/sandbox_single_worker.py")
p = importlib.util.module_from_spec(spec)
spec.loader.exec_module(p)
sys.stdout.write(p.prompt(p.PR_NUMBER, sys.argv[1]))
' "$TURN1_HEAD" \
  | dotnet run --project tools/BKE.Worker.ChatGPT.AckProbe/BKE.Worker.ChatGPT.AckProbe.csproj -c Release

echo "Read-only diagnostic finished. No worker was started and nothing was sent."
