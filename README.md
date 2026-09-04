# BKE Worker

BKE Worker is a deterministic Notion-checkbox watchdog for one fixed ChatGPT engineering conversation.

The active architecture is intentionally small:

```text
NOTION WORKSPACE
    │
    ├── ENGINEERING: BKE Worker
    ├── ENGINEERING: Air Stack
    ├── ENGINEERING: Digital Solutions
    └── other pages are ignored
             │
             ▼
      PROJECT DROPDOWN
      title = discovery/display
      page ID = identity
             │
             ▼
       SELECTED PAGE
       ├── normal to_do blocks
       │      = executable tasks / completion truth
       └── normal tables
              KEY | NAME | INSTRUCTION
              = reusable durable instructions
                       ↓
                  BKE WORKER
                       ↓
           FIXED CHATGPT CONVERSATION URL
                       ↓
               PLAYWRIGHT + CHROMIUM
                       ↓
                 WATCH EXACT TODO
```

Core rule:

```text
NAMES DISCOVER.
IDS EXECUTE.
```

A page title beginning with `ENGINEERING:` only makes the page discoverable in the operator UI. When START is pressed, Worker locks the exact selected Notion page ID and exact selected TODO block ID. Runtime never re-selects a project by title.

Runtime rule:

```text
unchecked + ChatGPT busy
-> wait

unchecked + ChatGPT idle
-> continue the SAME TODO

checked
-> select first unchecked TODO from the LOCKED page
-> dispatch next

no unchecked TODOs on the locked page
-> COMPLETE
-> stop
```

GitHub push is **not orchestration authority** on the active branch.

## Legacy preservation

The previous GitHub-webhook-driven Phase 6 loop is frozen at:

```text
branch: legacy/phase6-webhook-loop-certification
sha:    df3a586f397487429ded3853e220de3a98e8f22c
```

That branch preserves the signed GitHub webhook wake queue, debounce/reconciliation loop, Phase 3–6 certification workflows, and the exact implementation that was live-tested before this pivot.

Android Accessibility was the original autonomous runtime prototype and remains frozen separately at:

```text
branch: legacy/android-runtime-v0
sha:    a748435caecc41fb4a65f543efcb5a2b409fca61
```

## Why the active design changed

The worker does not need an indirect engineering event to guess when to continue.

The canonical state transition already exists in Notion:

```text
CURRENT TODO
checked=false
      ↓
checked=true
```

A GitHub push, elapsed timer, or completed ChatGPT response cannot declare a task complete. Only the exact selected Notion `to_do` block can do that.

Therefore:

```text
Notion = project discovery + task queue + completion truth
Worker = watchdog + deterministic browser executor
ChatGPT = engineering executor
GitHub = engineering/code reality, not orchestration control
```

## Engineering project discovery

Worker calls the Notion search API through the configured integration and displays only shared pages whose title starts with:

```text
ENGINEERING:
```

Examples:

```text
ENGINEERING: BKE Worker
ENGINEERING: Air Stack
ENGINEERING: Digital Solutions V2
```

The title is never runtime identity. Duplicate titles and page renames cannot redirect an active run because the selected page is normalized to its exact Notion page ID at START.

Pages without the prefix are not offered by the project dropdown.

## Selected-page contract

Each engineering page may contain normal Notion TODO blocks:

```text
☐ Add exact current-TODO watching
☐ Certify unchecked + busy waits
☐ Certify checked advances exactly once
```

and normal Notion tables whose header is exactly:

| KEY | NAME | INSTRUCTION |
| --- | --- | --- |
| engineering | Engineering Canonical | Establish canonical project/repository reality first. Work only on the selected TODO. Preserve architecture unless the TODO explicitly changes it. Do not merge without owner authorization. Run relevant tests. Mark the exact selected TODO checked only when complete and verified. If blocked, leave it unchecked and report why. |
| audit | Audit / Read Only | Inspect canonical reality only. Do not mutate systems unless explicitly authorized by the selected TODO. |
| surgical | Surgical Fix | Make the smallest correct change required by the selected TODO. Do not perform unrelated redesign. |

Worker deliberately does **not** traverse child pages or child databases for task or instruction control data.

At START, Worker revalidates that:

```text
selected page title starts with ENGINEERING:
selected TODO is currently unchecked
selected TODO belongs to that exact page
selected instruction key exists on that exact page
```

Only then is the run armed.

## Operator UI

The normal control surface is intentionally minimal:

```text
Engineering project
[ ENGINEERING: BKE Worker ▼ ]

Task
[ Notion TODO ▼ ]

Durable instruction
[ Engineering Canonical ▼ ]

[ Start watchdog ] [ Stop ] [ Check now ]
```

There is no repository selector, GitHub webhook panel, ChatGPT Project selector, or ChatGPT Conversation selector.

The repository can be resolved by the engineering executor under the selected durable instruction. The ChatGPT execution conversation is Worker configuration, not operator task data.

## Dispatch identity

Every prompt carries the exact locked Notion authority:

```text
[NOTION AUTHORITY]
Page name: <display title>
Page ID: <exact page id>
Page URL: <exact page url>
Current TODO block ID: <exact block id>
Use ONLY this exact Notion page.
Do not use another page merely because it contains similar TODO text.

[DURABLE INSTRUCTION]
<selected reusable instruction>

[CURRENT TODO]
<selected Notion TODO text>
```

This prevents duplicate-looking checklists elsewhere in the connected workspace from becoming completion targets.

## Watchdog behavior

While active, Worker polls the exact current block frequently.

If the TODO remains unchecked:

- ChatGPT busy -> no action;
- ChatGPT idle -> send one continuation after the configured retry guard.

If the TODO becomes checked:

- scan only the locked page;
- exact-read candidate TODO blocks to verify current checked state;
- choose the first verified unchecked TODO;
- wait for ChatGPT to become safe;
- dispatch that next TODO.

If no unchecked TODO remains, Worker enters `COMPLETE` and sends no additional prompts.

## Persistent Chromium

Live ChatGPT execution attaches to a persistent Chromium profile through loopback-only CDP.

Typical host values:

```text
BKE_WORKER_BROWSER_CDP_ENDPOINT=http://127.0.0.1:9222
BKE_WORKER_CHATGPT_PROFILE=$HOME/snap/chromium/common/bke-worker-chatgpt-profile
```

The browser profile is a credential. Never commit it, upload it, put its contents in Notion, or expose browser storage through APIs.

The autonomous target is one deterministic conversation URL:

```text
BKE_WORKER_CHATGPT_OVERRIDE_URL=https://chatgpt.com/.../c/<conversation-id>
```

No New Chat fallback is used by the configured watchdog runtime.

## Configuration

```text
BKE_WORKER_NOTION_TOKEN=...
BKE_WORKER_CHATGPT_OVERRIDE_URL=https://chatgpt.com/.../c/<conversation-id>

# optional/runtime
BKE_WORKER_NOTION_BASE_URL=https://api.notion.com/
BKE_WORKER_CHATGPT_BASE_URL=https://chatgpt.com/
BKE_WORKER_BROWSER_CDP_ENDPOINT=http://127.0.0.1:9222
BKE_WORKER_CHATGPT_PROFILE=$HOME/snap/chromium/common/bke-worker-chatgpt-profile
BKE_WORKER_STATE_FILE=$HOME/.local/share/bke-worker/state/notion-watchdog.json
BKE_WORKER_WATCHDOG_SECONDS=2
BKE_WORKER_IDLE_RETRY_SECONDS=5
BKE_WORKER_HEADLESS=false
```

`BKE_WORKER_NOTION_PAGE` is no longer required for active project selection. Existing values may remain in old host env files, but the UI-selected exact page ID is the runtime authority.

GitHub webhook configuration is not required by the active watchdog server.

## Server endpoints

```text
GET  /health
GET  /health/live
GET  /health/ready

GET  /control/projects
GET  /control/options?pageId=<exact-notion-page-id>
GET  /control/summary
POST /control/start
POST /control/stop
POST /control/check-now
POST /control/chatgpt/probe
```

`/control/projects` returns discoverable `ENGINEERING:` pages.

`/control/options` returns verified unchecked TODOs and same-page durable instruction templates for one exact selected engineering page.

The legacy `/webhooks/github` route is intentionally absent on the active watchdog branch.

## Active projects

```text
src/
  BKE.Worker.Core/       shared execution/state contracts
  BKE.Worker.ChatGPT/    Playwright + persistent Chromium automation
  BKE.Worker.Notion/     page search, TODO discovery, exact block reads, instruction-table reads
  BKE.Worker.Server/     checkbox watchdog runtime + minimal operator UI

  BKE.Worker.GitHub/     retained source history; not an active server dependency
  BKE.Worker.Platform.Android/  frozen prototype source history
```

## Task-writing rule

The transport is intentionally boring. Autonomous quality depends mainly on the task and durable instruction being precise.

Durable instruction answers:

```text
how to behave
canonical project rules
what may / may not be changed
testing requirements
merge authorization
stop conditions
```

TODO answers:

```text
what bounded outcome must become true
```

Weak:

```text
☐ Fix BKE Worker
```

Strong:

```text
☐ Make BKE Worker retrieve the exact active Notion TODO by block ID and advance only after that block reports checked=true.
```

That separation is the core of deterministic autonomous execution.
