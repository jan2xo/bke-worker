# BKE Worker

BKE Worker is a deterministic Notion-checkbox watchdog that executes one exact ChatGPT conversation through a dedicated persistent Chromium profile.

```text
BKE Worker UI
        ↓
Start ChatGPT / Login / Clear account
        ↓
persistent Chromium profile
        ↓
exact ChatGPT conversation URL
memory only
        ↓
Notion secret
memory only
        ↓
ENGINEERING: page discovery
        ↓
exact selected Notion page ID
        ↓
exact selected TODO block ID
        ↓
watchdog execution
```

Core rule:

```text
CHROMIUM PROFILE = CHATGPT ACCOUNT.
URL = EXACT CHATGPT CONVERSATION.
NAMES DISCOVER.
IDS EXECUTE.
```

The Worker has no ChatGPT conversation API. Determinism comes from the exact browser URL supplied by the operator, including project conversation forms such as `https://chatgpt.com/g/.../c/<conversation-id>` and normal `https://chatgpt.com/c/<conversation-id>` URLs. A valid target must be HTTPS on `chatgpt.com` and contain `/c/<conversation-id>`.

## ChatGPT account lifecycle

Normal operation does not require a separate Chromium CLI command. Start only the Worker, then use the operator UI.

```text
Browser stopped / auth unknown
        ↓
Start ChatGPT
        ↓
existing session valid? ── YES → AUTHORIZED
        │
        NO
        ↓
LOGIN REQUIRED
        ↓
Login to ChatGPT
        ↓
human completes login/MFA/CAPTCHA in visible Chromium
        ↓
I've logged in
        ↓
Worker verifies authorization
        ↓
AUTHORIZED
```

`Clear / Logout` closes the dedicated Chromium browser through loopback CDP, deletes the dedicated Worker browser profile, clears the exact ChatGPT URL, and returns the Worker to a fresh-account state. It is the deterministic account-switch operation; Worker does not automate ChatGPT credentials or manipulate the account logout UI.

When Chromium is stopped, Worker does not claim that a saved profile is authorized. Authorization is proven only after Chromium starts and ChatGPT is checked.

Account-changing actions are rejected while the watchdog is active.

## Runtime authority

```text
Chromium persistent profile
= which ChatGPT account/session

exact ChatGPT /c/<id> URL
= exact browser execution target

Notion secret
= which Notion universe Worker can see

ENGINEERING: prefix
= project discovery only

selected Notion page ID
= exact project authority

selected TODO block ID
= exact task authority
```

The Notion secret and exact ChatGPT conversation URL are UI/session-owned. They are kept only in process memory and discarded on disconnect/clear or Worker restart. They are not loaded from `.env` and are not written to Worker state JSON, logs, GitHub, Notion, or build artifacts.

The Chromium profile is intentionally persistent because it is the ChatGPT account/session store. Treat it as credential material.

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
ChatGPT account / browser
[ Start ChatGPT ] [ Login to ChatGPT ] [ I've logged in ] [ Clear / Logout ]

Exact ChatGPT conversation URL
[ https://chatgpt.com/.../c/<conversation-id> ] [ Use URL ] [ Clear URL ]

Notion integration secret
[ ••••••••••••••••• ] [ Connect ] [ Disconnect ]

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

CDP must remain loopback-only. Never commit, upload, or expose the Chromium profile. The UI may be reachable on the trusted host network; CDP must not be.

## Server endpoints

```text
GET  /health
GET  /health/live
GET  /health/ready

GET  /control/chatgpt/browser/status
POST /control/chatgpt/browser/start
POST /control/chatgpt/browser/login
POST /control/chatgpt/browser/verify-login
POST /control/chatgpt/browser/clear

POST /control/chatgpt/connect
POST /control/chatgpt/disconnect
POST /control/chatgpt/probe

POST /control/notion/connect
POST /control/notion/disconnect
GET  /control/projects
GET  /control/options?pageId=<exact-notion-page-id>
GET  /control/summary
POST /control/start
POST /control/stop
POST /control/check-now
```

## Deployment progression

The intended host progression is:

```text
UTM Linux VM
-> Raspberry Pi when available
-> persistent VPS
```

The Worker runtime model stays the same on each host: persistent filesystem, dedicated Chromium profile, loopback CDP, long-running ASP.NET Worker, and an operator UI.

Do not expose the raw operator UI publicly without HTTPS and authentication. Remote-control deployment should put the UI behind an authenticated HTTPS boundary while keeping Chromium CDP loopback-only.

## Legacy preservation

```text
legacy/phase6-webhook-loop-certification
sha df3a586f397487429ded3853e220de3a98e8f22c

legacy/android-runtime-v0
sha a748435caecc41fb4a65f543efcb5a2b409fca61
```
