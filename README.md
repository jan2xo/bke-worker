# BKE Worker

BKE Worker is an event-driven engineering orchestrator. Notion is the canonical checklist, ChatGPT Projects hold engineering context, Playwright is the browser automation layer, and GitHub push webhooks wake the worker so it can reconcile Notion.

## Runtime contract

```text
NOTION TASK
    ↓
BKE WORKER SERVER
    ↓
PLAYWRIGHT + PERSISTENT CHROMIUM
    ↓
CHATGPT PROJECT / CONVERSATION
    ↓
ENGINEERING + GITHUB PUSH
    ↓
SIGNED GITHUB WEBHOOK
    ↓
BKE WORKER WAKE
    ↓
NOTION RECONCILIATION

[ ] → CONTINUE SAME ENGINEERING LOOP
[x] → NEXT UNCHECKED GATE
all checked → COMPLETE
```

A GitHub event **never means a task is complete**. It means only: wake up and reconcile the canonical Notion checkbox state.

## Android V0 is frozen

Android Accessibility was the original autonomous runtime prototype. Its exact baseline is preserved at:

```text
branch: legacy/android-runtime-v0
sha:    a748435caecc41fb4a65f543efcb5a2b409fca61
```

`src/BKE.Worker.Platform.Android` remains in history as prototype evidence. It is no longer the primary execution backend and is not part of the canonical VPS runtime CI gate.

Future Android work belongs in a remote-control client that talks to the server.

## Projects

```text
src/
  BKE.Worker.Core/       orchestration contracts, event-driven WorkerLoop, worker state
  BKE.Worker.Server/     ASP.NET Core host, wake queue, recovery timer, durable local state
  BKE.Worker.ChatGPT/    Playwright persistent Chromium and deterministic ChatGPT navigation
  BKE.Worker.Notion/     Notion checklist client and canonical reconciliation
  BKE.Worker.GitHub/     signed push webhook verification and wake endpoint
  BKE.Worker.Platform.Android/  frozen legacy prototype

tests/
  BKE.Worker.Core.Tests/
  BKE.Worker.Notion.Tests/
  BKE.Worker.GitHub.Tests/
  BKE.Worker.ChatGPT.Tests/  real Chromium runtime + controlled semantic UI certification
```

## Worker states

```text
IDLE
DISPATCHING
WAITING_FOR_ENGINEERING_EVENT
RECONCILING
CONTINUING
COMPLETE
BLOCKED
FAILED
```

The worker persists only orchestration state: target project/conversation, Notion page, current checklist block, timestamps, last GitHub delivery ID, and failure state. It does **not** copy the full Notion checklist into another task database.

## Event behavior

Initial start:

1. Fetch the Notion checklist.
2. Find the first unchecked gate.
3. Ensure persistent Chromium exists and ChatGPT is authenticated.
4. Open **Projects**.
5. Select the exact project.
6. Select the exact conversation.
7. Send `CONTINUE FROM THE NOTION CHECKLIST.`
8. Enter `WAITING_FOR_ENGINEERING_EVENT`.

GitHub push:

1. Verify `X-Hub-Signature-256`.
2. Require and persist `X-GitHub-Delivery` for idempotency.
3. Acknowledge the webhook and enqueue a wake.
4. Debounce before reconciliation.
5. Fetch Notion.
6. If all gates are checked, complete.
7. Otherwise wait until the ChatGPT turn is idle, then send `CONTINUE FROM THE NOTION CHECKLIST.` to the same exact project/conversation.

A recovery reconciliation runs every 5 minutes only while an engineering loop is active. It exists for missed deliveries, worker restarts, network interruption, and Notion updates that land after the last webhook.

## Race guard

The webhook endpoint never sends a prompt directly. It queues a wake and returns `202`.

The hosted worker then applies:

- webhook debounce (default 10 seconds),
- Notion reconciliation,
- minimum dispatch spacing (default 30 seconds),
- composer idle check.

A visible ChatGPT Stop control means the current turn is still active. A usable composer means a next turn can be sent.

## Persistent Chromium

Default profile:

```text
/var/lib/bke-worker/chatgpt-profile
```

This directory is a **credential**. Never commit it, upload it, log cookies from it, put it in Notion, or return its contents from an API.

One worker process owns one persistent Chromium profile. Tasks reuse it; they do not launch a new browser per gate.

Navigation is deterministic:

```text
ChatGPT
  → Projects
  → exact Project text
  → exact Conversation text
  → composer
```

No Recent-chat routing, coordinates, visual guessing, or new-chat engineering route is used.

A Project/Conversation lookup failure gets one ChatGPT UI reset and one retry. Navigation failure does not restart Chromium. The persistent profile survives browser restart.

## Configuration

Environment variables:

```text
BKE_WORKER_NOTION_TOKEN=...
BKE_WORKER_NOTION_PAGE=...
BKE_WORKER_CHATGPT_PROJECT=...
BKE_WORKER_CHATGPT_CONVERSATION=...
BKE_WORKER_GITHUB_WEBHOOK_SECRET=...

# optional
BKE_WORKER_CHATGPT_PROFILE=/var/lib/bke-worker/chatgpt-profile
BKE_WORKER_STATE_FILE=/var/lib/bke-worker/state/worker.json
BKE_WORKER_HEADLESS=true
BKE_WORKER_WEBHOOK_DEBOUNCE_SECONDS=10
BKE_WORKER_RECOVERY_SECONDS=300
BKE_WORKER_MIN_DISPATCH_SECONDS=30
```

The GitHub webhook target is:

```text
POST /webhooks/github
```

Subscribe to `push` only for V1 and configure the same webhook secret on GitHub and the worker.

Health/state endpoints:

```text
GET /health
GET /control/state
```

No browser credentials are exposed through these endpoints.

## Canonical certification — GitHub Actions

GitHub Actions is the canonical Linux certification environment for V1. No separate Lima certification gate is required.

The Ubuntu workflow certifies:

```text
.NET 10 restore/build
        ↓
Core event-loop tests
        ↓
Notion reconciliation tests
        ↓
GitHub webhook/signature tests
        ↓
install real Playwright Chromium
        ↓
launch persistent Chromium
        ↓
restart Chromium and prove profile storage survives
        ↓
controlled semantic ChatGPT surface
Projects → exact Project → exact Conversation → composer
        ↓
prove SEND and busy/idle guard
        ↓
publish BKE.Worker.Server
        ↓
boot published server on Ubuntu
        ↓
GET /health
        ↓
GREEN
```

The controlled browser surface intentionally tests the automation contract without storing a real ChatGPT account session in GitHub Actions.

GitHub Actions therefore certifies the **engine and Linux browser/runtime contract**. A live authenticated ChatGPT check on the deployed host is an adapter smoke test, not a prerequisite for proving the orchestration architecture.

## Production target

Recommended initial host:

```text
Ubuntu/Debian Linux VPS
2 CPU
4 GB RAM recommended
20–40 GB storage
.NET 10
Playwright Chromium
systemd
```

Raspberry Pi remains a supported self-hosted backend candidate.

V1 requires no PostgreSQL, Redis, Kubernetes, OpenAI API, or external ChatGPT-context reconstruction.

## Certification boundary

Canonical CI proves:

- event-driven worker behavior,
- checkbox-driven progression,
- webhook integrity and delivery dedupe,
- Linux build/runtime compatibility,
- actual Chromium launch,
- persistent profile survival across browser restart,
- deterministic semantic Project/Conversation navigation against a controlled UI contract,
- composer send and busy/idle gating,
- published server startup and health.

CI does **not** store or certify a real ChatGPT account login. After deployment, the dedicated persistent profile is authenticated on the target host and a live smoke check can validate current ChatGPT-web compatibility.

That smoke check is operational evidence, not a separate development environment gate.
