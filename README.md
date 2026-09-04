# BKE Worker

BKE Worker is a deterministic Notion-checkbox watchdog for one fixed ChatGPT engineering conversation.

```text
NOTION SECRET
entered in operator UI
held in process memory only
        ↓
NOTION WORKSPACE
        ↓
ENGINEERING: page discovery
        ↓
exact selected page ID
        ↓
exact selected TODO block ID
        ↓
fixed ChatGPT conversation
        ↓
Playwright + persistent Chromium
```

Core rule:

```text
NAMES DISCOVER.
IDS EXECUTE.
```

A title beginning with `ENGINEERING:` makes a page discoverable. At START, Worker locks the exact selected Notion page ID and exact selected TODO block ID. Runtime never redirects an active run by title.

## Runtime rule

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
-> stop
```

GitHub push is not orchestration authority on the active branch.

## Notion authentication

The Notion integration secret is deliberately **not** host configuration.

The operator enters it in the UI after Worker starts. Worker validates it, keeps it only in process memory, and discards it on explicit disconnect or process restart.

Do not place the Notion secret in `.env`, Worker state JSON, GitHub, Notion pages, browser storage, logs, or build artifacts.

The Notion secret controls which Notion workspace content the Worker can see. It does not select a project. Project discovery is based on the `ENGINEERING:` title prefix, and runtime authority is the exact page ID selected at START.

## Engineering page contract

Each engineering page may contain normal Notion TODO blocks:

```text
☐ Add exact current-TODO watching
☐ Certify unchecked + busy waits
☐ Certify checked advances exactly once
```

and normal Notion tables with this exact header:

| KEY | NAME | INSTRUCTION |
| --- | --- | --- |
| engineering | Engineering Canonical | Establish canonical project/repository reality first. Work only on the selected TODO. Preserve architecture unless the TODO explicitly changes it. Do not merge without owner authorization. Run relevant tests. Mark the exact selected TODO checked only when complete and verified. If blocked, leave it unchecked and report why. |
| audit | Audit / Read Only | Inspect canonical reality only. Do not mutate systems unless explicitly authorized by the selected TODO. |
| surgical | Surgical Fix | Make the smallest correct change required by the selected TODO. Do not perform unrelated redesign. |

Worker deliberately does not traverse child pages or child databases for selected-page task or instruction control data.

At START, Worker revalidates:

```text
selected page title starts with ENGINEERING:
selected TODO is currently unchecked
selected TODO belongs to that exact page
selected instruction key exists on that exact page
```

## Operator UI

```text
Notion integration secret
[ ••••••••••••••••••• ] [ Connect ] [ Disconnect ]

Engineering project
[ ENGINEERING: BKE Worker ▼ ]

Notion task / TODO
[ ... ▼ ]

Durable instruction
[ ... ▼ ]

[ Start watchdog ] [ Stop ] [ Check now ]

Refresh Notion lists
```

Normal operation needs no manual refresh:

```text
watchdog summary        -> every 1.5 seconds
selected page options   -> every 8 seconds while idle
ENGINEERING page list   -> every 30 seconds while idle
```

The manual `Refresh Notion lists` button remains as an explicit/debug refresh.

Changing or disconnecting the Notion session is rejected while the watchdog is active.

## Dispatch identity

Every prompt carries the exact locked Notion authority:

```text
[NOTION AUTHORITY]
Page name: <display title>
Page ID: <exact page id>
Page URL: <exact page url>
Current TODO block ID: <exact block id>
Use ONLY this exact Notion page.

[DURABLE INSTRUCTION]
<selected reusable instruction>

[CURRENT TODO]
<selected Notion TODO text>
```

## Persistent Chromium

Live ChatGPT execution attaches to a persistent Chromium profile through loopback-only CDP.

Typical host configuration:

```text
BKE_WORKER_CHATGPT_OVERRIDE_URL=https://chatgpt.com/.../c/<conversation-id>
BKE_WORKER_BROWSER_CDP_ENDPOINT=http://127.0.0.1:9222
BKE_WORKER_CHATGPT_PROFILE=$HOME/snap/chromium/common/bke-worker-chatgpt-profile
BKE_WORKER_NOTION_BASE_URL=https://api.notion.com/
BKE_WORKER_STATE_FILE=$HOME/.local/share/bke-worker/state/notion-watchdog.json
BKE_WORKER_WATCHDOG_SECONDS=2
BKE_WORKER_IDLE_RETRY_SECONDS=5
BKE_WORKER_HEADLESS=false
```

The Chromium profile is itself a credential store. Never commit it, upload it, put its contents in Notion, or expose CDP outside loopback.

## Server endpoints

```text
GET  /health
GET  /health/live
GET  /health/ready

POST /control/notion/connect
POST /control/notion/disconnect
GET  /control/projects
GET  /control/options?pageId=<exact-notion-page-id>
GET  /control/summary
POST /control/start
POST /control/stop
POST /control/check-now
POST /control/chatgpt/probe
```

`/control/notion/connect` accepts the operator-provided secret and validates it before replacing the current in-memory Notion session. The secret is never returned by the API.

`/control/projects` returns discoverable `ENGINEERING:` pages. `/control/options` returns verified unchecked TODOs and same-page durable instruction templates for one exact selected page.

## Legacy preservation

The prior GitHub-webhook-driven Phase 6 loop remains frozen at:

```text
branch: legacy/phase6-webhook-loop-certification
sha:    df3a586f397487429ded3853e220de3a98e8f22c
```

Android Accessibility remains frozen at:

```text
branch: legacy/android-runtime-v0
sha:    a748435caecc41fb4a65f543efcb5a2b409fca61
```

## Task-writing rule

Durable instructions define behavior, boundaries, canonical project rules, testing requirements, merge authority, and stop conditions. TODOs define one bounded outcome.

Weak:

```text
☐ Fix BKE Worker
```

Strong:

```text
☐ Make BKE Worker retrieve the exact active Notion TODO by block ID and advance only after that block reports checked=true.
```

That separation is the core of deterministic autonomous execution.
