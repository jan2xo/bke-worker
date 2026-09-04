# BKE Worker

BKE Worker is a deterministic Notion-checkbox watchdog that executes one exact ChatGPT conversation through persistent Chromium.

```text
Notion integration secret
entered in operator UI
memory only
        ↓
ENGINEERING: page discovery
        ↓
exact selected Notion page ID
        ↓
exact selected TODO block ID
        ↓
exact ChatGPT conversation URL
entered in operator UI
memory only
        ↓
Playwright + persistent Chromium
```

Core rule:

```text
NAMES DISCOVER.
IDS EXECUTE.
URLS TARGET EXACTLY.
```

The Worker has no ChatGPT conversation API. Determinism comes from the exact browser URL supplied by the operator, including project conversation forms such as `https://chatgpt.com/g/.../c/<conversation-id>` and normal `https://chatgpt.com/c/<conversation-id>` URLs. A valid target must be HTTPS on `chatgpt.com` and contain `/c/<conversation-id>`.

## Runtime authority

```text
Notion secret
= which Notion universe Worker can see

ENGINEERING: prefix
= project discovery only

selected Notion page ID
= exact project authority

selected TODO block ID
= exact task authority

exact ChatGPT /c/<id> URL
= exact browser execution target
```

Both the Notion secret and ChatGPT conversation URL are UI/session-owned. They are kept only in process memory and discarded on disconnect/clear or Worker restart. They are not loaded from `.env` and are not written to Worker state JSON, browser storage, logs, GitHub, Notion, or build artifacts.

While the watchdog is active, replacing/disconnecting either runtime identity is rejected.

## Watchdog rule

```text
unchecked + ChatGPT busy
-> wait

unchecked + ChatGPT idle
-> continue the SAME TODO

checked
-> select first verified unchecked TODO from the LOCKED page
-> dispatch next

no unchecked TODOs on the locked page
-> COMPLETE
```

GitHub push is not orchestration authority on the active branch.

## Operator UI

```text
Notion integration secret
[ ••••••••••••••••• ] [ Connect ] [ Disconnect ]

Exact ChatGPT conversation URL
[ https://chatgpt.com/.../c/<conversation-id> ] [ Use URL ] [ Clear ]

Engineering project
[ ENGINEERING: ... ▼ ]

Notion task / TODO
[ ... ▼ ]

Durable instruction
[ ... ▼ ]

[ Start watchdog ] [ Stop ] [ Check now ]

Refresh Notion lists
```

Normal refresh behavior:

```text
watchdog summary        -> every 1.5 seconds
selected page options   -> every 8 seconds while idle
ENGINEERING page list   -> every 30 seconds while idle
```

The manual `Refresh Notion lists` button remains available.

## Engineering page contract

Each `ENGINEERING:` page may contain normal Notion `to_do` blocks and same-page tables with the exact header:

| KEY | NAME | INSTRUCTION |
| --- | --- | --- |
| engineering | Engineering Canonical | Establish canonical reality first. Work only on the selected TODO. Run relevant tests. Mark the exact TODO checked only when complete and verified. |
| audit | Audit / Read Only | Inspect only. Do not mutate systems unless explicitly authorized. |
| surgical | Surgical Fix | Make the smallest correct change required by the selected TODO. |

At START, Worker revalidates that the selected page still starts with `ENGINEERING:`, the selected TODO is unchecked and belongs to that exact page, and the selected durable instruction exists on that exact page.

## Host configuration

Only machine/runtime configuration belongs in `.env`:

```text
BKE_WORKER_NOTION_BASE_URL=https://api.notion.com/
BKE_WORKER_CHATGPT_BASE_URL=https://chatgpt.com/
BKE_WORKER_BROWSER_CDP_ENDPOINT=http://127.0.0.1:9222
BKE_WORKER_CHATGPT_PROFILE=$HOME/snap/chromium/common/bke-worker-chatgpt-profile
BKE_WORKER_STATE_FILE=$HOME/.local/share/bke-worker/state/notion-watchdog.json
BKE_WORKER_WATCHDOG_SECONDS=2
BKE_WORKER_IDLE_RETRY_SECONDS=5
BKE_WORKER_HEADLESS=false
```

The Chromium profile is a credential store. Keep CDP loopback-only and never commit or upload the profile.

## Server endpoints

```text
GET  /health
GET  /health/live
GET  /health/ready
POST /control/notion/connect
POST /control/notion/disconnect
POST /control/chatgpt/connect
POST /control/chatgpt/disconnect
POST /control/chatgpt/probe
GET  /control/projects
GET  /control/options?pageId=<exact-notion-page-id>
GET  /control/summary
POST /control/start
POST /control/stop
POST /control/check-now
```

## Legacy preservation

```text
legacy/phase6-webhook-loop-certification
sha df3a586f397487429ded3853e220de3a98e8f22c

legacy/android-runtime-v0
sha a748435caecc41fb4a65f543efcb5a2b409fca61
```
