#!/usr/bin/env bash
set -euo pipefail

# Owner-run, NON-SENDING diagnostic for the PR #148 turn-1 acknowledgment failure.
# Connects to the already-open dedicated Mac Chrome profile over loopback CDP, opens the
# dedicated chat, and reports how each send-confirmation predicate sees the turn-1 instruction
# that ChatGPT already received. It never types, clicks, sends, wakes, or edits the journal.
# Output is counts and booleans only: no prompt text, transcript text, URLs or cookies.
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
TURN1_HEAD="3c7de7d9740948c294ea3bbd8bcc5a2d515c82ef"

: "${BKE_WORKER_CHATGPT_OVERRIDE_URL:?Set BKE_WORKER_CHATGPT_OVERRIDE_URL to the dedicated chat URL}"
export BKE_WORKER_BROWSER_CDP_ENDPOINT="${BKE_WORKER_BROWSER_CDP_ENDPOINT:-http://127.0.0.1:9222}"
export BKE_WORKER_CHATGPT_PROFILE="${BKE_WORKER_CHATGPT_PROFILE:-$HOME/Library/Application Support/BKE-Worker/pilot-f1-profile}"

case "$BKE_WORKER_BROWSER_CDP_ENDPOINT" in
  http://127.0.0.1:*|http://localhost:*) ;;
  *) echo "ERROR: LOOPBACK_CDP_REQUIRED; nothing opened or sent." >&2; exit 2 ;;
esac
if ! curl -fsS --max-time 4 "$BKE_WORKER_BROWSER_CDP_ENDPOINT/json/version" >/dev/null; then
  echo "ERROR: Dedicated Chrome CDP not available. Sign in by hand first; nothing sent." >&2
  exit 2
fi

cd "$ROOT"
python3 -B -c '
import importlib.util, sys
spec = importlib.util.spec_from_file_location("p", "scripts/sandbox_single_worker.py")
p = importlib.util.module_from_spec(spec); spec.loader.exec_module(p)
sys.stdout.write(p.prompt(p.PR_NUMBER, sys.argv[1]))
' "$TURN1_HEAD" \
  | dotnet run --project tools/BKE.Worker.ChatGPT.AckProbe/BKE.Worker.ChatGPT.AckProbe.csproj -c Release
