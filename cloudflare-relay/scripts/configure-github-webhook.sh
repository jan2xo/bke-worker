#!/usr/bin/env bash
set -euo pipefail

REPO="${BKE_WORKER_CONTROL_REPO:-jan2xo/bke-worker}"
WEBHOOK_URL="${BKE_WORKER_CLOUDFLARE_WEBHOOK_URL:-}"
SECRET="${BKE_WORKER_GITHUB_WEBHOOK_SECRET:-}"
APPLY=false

if [[ "${1:-}" == "--apply" ]]; then
  APPLY=true
elif [[ -n "${1:-}" ]]; then
  echo "usage: $0 [--apply]" >&2
  exit 2
fi

command -v gh >/dev/null 2>&1 || {
  echo "ERROR: gh is required." >&2
  exit 1
}
command -v python3 >/dev/null 2>&1 || {
  echo "ERROR: python3 is required." >&2
  exit 1
}

if [[ ! "$WEBHOOK_URL" =~ ^https://.+/webhooks/github$ ]]; then
  echo "ERROR: set BKE_WORKER_CLOUDFLARE_WEBHOOK_URL to the exact HTTPS /webhooks/github endpoint." >&2
  exit 1
fi

if [[ "$APPLY" != "true" ]]; then
  cat <<EOF
GITHUB WEBHOOK PLAN — NO MUTATION
repo: $REPO
url: $WEBHOOK_URL
events: pull_request
content-type: application/json
TLS verification: enabled

Re-run with --apply only after the PREPRODUCTION relay is certified and the owner authorizes webhook mutation.
EOF
  exit 0
fi

if [[ -z "$SECRET" ]]; then
  echo "ERROR: BKE_WORKER_GITHUB_WEBHOOK_SECRET is required for --apply." >&2
  exit 1
fi

HOOK_ID="$(
  gh api "repos/$REPO/hooks" --paginate     | python3 -c '
import json, sys
url = sys.argv[1]
rows = json.load(sys.stdin)
matches = [
    str(row.get("id", ""))
    for row in rows
    if (row.get("config") or {}).get("url") == url
]
print(matches[0] if matches else "")
' "$WEBHOOK_URL"
)"

payload() {
  python3 -c '
import json, os, sys
url = sys.argv[1]
print(json.dumps({
    "active": True,
    "events": ["pull_request"],
    "config": {
        "url": url,
        "content_type": "json",
        "secret": os.environ["BKE_WORKER_GITHUB_WEBHOOK_SECRET"],
        "insecure_ssl": "0",
    },
}))
' "$WEBHOOK_URL"
}

if [[ -n "$HOOK_ID" ]]; then
  payload | gh api     --method PATCH     "repos/$REPO/hooks/$HOOK_ID"     --input -     >/dev/null
  echo "Updated GitHub webhook id $HOOK_ID for $WEBHOOK_URL"
else
  payload | gh api     --method POST     "repos/$REPO/hooks"     --input -     >/dev/null
  echo "Created GitHub pull_request webhook for $WEBHOOK_URL"
fi

echo "Secret value was provided over stdin and was not printed."
