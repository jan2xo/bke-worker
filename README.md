# BKE Worker

BKE Worker is a persistent autonomous-engineering wake/orchestration service.

GitHub is durable engineering truth. ChatGPT performs the engineering. Worker keeps the exact authenticated ChatGPT engineering conversation moving after signed GitHub activity or a recovery heartbeat.

## Canonical loop

```text
SIGNED GITHUB PUSH
        │
        ├────────────── immediate wake
        │
30-MINUTE HEARTBEAT ── recovery wake
        │
        v
BKE WORKER
        │
        ├─ verify exact ChatGPT target
        ├─ require human-owned authenticated browser
        ├─ require safe-to-interrupt composer state
        └─ send locked continuation instruction
        │
        v
CHATGPT ENGINEERING CONVERSATION
        │
        ├─ read canonical Project Source
        ├─ recover live GitHub checkpoint
        ├─ finish current PR / exact-head certification / merge
        └─ if another queued intent exists:
             current main
               -> fresh branch
               -> NEW PR using .github/pull_request_template.md
               -> minimum complete certification graph
               -> exact-head proof
               -> SHA-locked merge
```

Worker does **not** maintain another engineering task database and does not require Notion.

## Authority model

- **GitHub**: source, issues/queued intents, PRs, CI proof, merge state, release/provenance truth.
- **ChatGPT**: engineering executor operating from the canonical Project Source + live GitHub state.
- **BKE Worker**: liveness, wake delivery, webhook dedupe, browser safety, and recovery heartbeat.
- **Human operator**: ChatGPT login/OAuth/MFA/CAPTCHA and production/security authorization.

Worker stores no GitHub API token. ChatGPT uses its own connected GitHub capability to recover repository truth.

## Autonomous continuation contract

The locked Worker instruction requires ChatGPT to:

1. read the canonical Project Source;
2. inspect live GitHub state;
3. continue the current active engineering PR if one exists;
4. complete the declared minimum certification graph;
5. exact-head verify and SHA-lock merge when good;
6. write a durable checkpoint;
7. only when that intent is complete, take the next explicitly queued intent;
8. create a **fresh branch from current main**;
9. create a **NEW PR using the repository PR template**;
10. never reuse an old/merged feature branch;
11. never invent unqueued work;
12. keep production/security locks in force.

## Wake behavior

### GitHub push

A signed `push` webhook is an immediate doorbell. The webhook:

- verifies `X-Hub-Signature-256`;
- requires `X-GitHub-Delivery`;
- deduplicates the delivery durably;
- queues a wake and returns `202`;
- never sends a ChatGPT prompt directly.

### Heartbeat

`BKE_WORKER_HEARTBEAT_SECONDS` defaults to **1800 seconds (30 minutes)**.

The heartbeat is a liveness/recovery trigger, not an engineering deadline. It never abandons an unfinished PR merely because 30 minutes elapsed.

If ChatGPT is still generating, hydrating, unauthenticated, or otherwise not positively safe to interrupt, Worker sends nothing. The next push/heartbeat can try again.

## Browser boundary

Live `chatgpt.com` uses a normal human-owned Chromium session with a dedicated persistent profile and loopback CDP.

- Authentication is human-only.
- OAuth/MFA/CAPTCHA/security challenges are never automated.
- CDP must be loopback-only.
- Browser credentials/profile contents are never committed, logged, uploaded, or returned by Worker APIs.
- Chat and Work are distinct execution surfaces. Current autonomous Worker is Chat-only and fails closed if configured for Work.

## Runtime state

Canonical states:

```text
IDLE
DISPATCHING
WAITING_FOR_ENGINEERING_EVENT
CONTINUING
BLOCKED
FAILED
```

Persisted state contains only:

- configured ChatGPT target;
- last dispatch time;
- last GitHub delivery ID;
- last wake time;
- failure state.

If the process restarts after persisting `DISPATCHING` or `CONTINUING`, Worker cannot prove whether the prior prompt was sent. It enters `BLOCKED` rather than risk a duplicate send. Only explicit operator continuation can clear a persisted blocked/failed state.

## Operator API

```text
GET  /health
GET  /health/live
GET  /health/ready
GET  /control/state
GET  /control/summary
POST /control/continue
POST /control/chatgpt/probe
POST /webhooks/github
```

`/control/chatgpt/probe` is non-mutating: it validates the configured ChatGPT context and composer state without sending a prompt.

## Configuration

```text
BKE_WORKER_CHATGPT_PROJECT="BKE Worker"
BKE_WORKER_CHATGPT_CONVERSATION="Worker Engineering"
BKE_WORKER_CHATGPT_OVERRIDE_URL=""
BKE_WORKER_CHATGPT_BASE_URL=https://chatgpt.com/

BKE_WORKER_BROWSER_CDP_ENDPOINT=http://127.0.0.1:9222
BKE_WORKER_CHATGPT_PROFILE=/var/lib/bke-worker/chatgpt-profile
BKE_WORKER_HEADLESS=false

BKE_WORKER_GITHUB_WEBHOOK_SECRET=...
BKE_WORKER_STATE_FILE=/var/lib/bke-worker/state/worker.json
BKE_WORKER_WEBHOOK_DEBOUNCE_SECONDS=10
BKE_WORKER_HEARTBEAT_SECONDS=1800
BKE_WORKER_MIN_DISPATCH_SECONDS=30
```

Environment-variable names are generation-independent.

## CI policy

PRs are ledgers, not heavy-CI triggers.

Active CI is intentionally limited to:

- a cheap automatic PR Guard; and
- explicit intent certification invoked only when the PR certification plan requires it.

The historical Phase 3–6 automatic workflows are archived under:

`.github/legacy-workflows/2026-10-02/`

## Legacy Android prototype

The Android Accessibility worker remains historical prototype evidence. The GitHub-native Linux/Playwright server is the canonical autonomous runtime for this architecture.

## Production boundary

This repository may certify PREPRODUCTION/runtime behavior remotely. Production deployment, credential cutover, or other locked production actions require explicit authorization.
