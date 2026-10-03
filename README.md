# BKE Worker

BKE Worker is a GitHub-native autonomous-engineering wake/orchestration service.

GitHub is durable engineering truth. ChatGPT performs engineering. Worker provides liveness, deterministic PR routing, webhook dedupe, browser safety, and recovery heartbeat.

## Multi-worker invariant

```text
one worker instance -> one active PR assignment at a time
one PR -> one active worker
```

Multiple worker processes may run concurrently when every worker has an isolated ChatGPT/browser/state tuple and a distinct PR assignment.

A PR is durably assigned by exactly one label:

```text
bke-worker:<worker_id>
```

Zero worker labels means unassigned. More than one worker label is ambiguous and fails closed.

## Canonical loop

```text
GITHUB pull_request event
        |
        +-- exactly one bke-worker:<worker_id> label
        |
        v
ASSIGNED BKE WORKER
        |
        +-- cache PR number / head ref / head SHA for liveness
        +-- verify exact isolated ChatGPT target
        +-- require human-owned authenticated browser
        +-- require safe-to-interrupt composer
        |
        v
CHATGPT ENGINEERING CONVERSATION
        |
        +-- read canonical Project Source
        +-- recover LIVE GitHub PR and worker label
        +-- verify this worker owns no second open PR
        +-- continue only the assigned PR
        +-- exact-head certify / SHA-lock merge when authorized
        |
        v
PR LEDGER CHECKPOINTS

assigned-branch push ----------> immediate wake
30-minute heartbeat -----------> recovery wake
assignment removal / PR close -> stop automatic continuation
```

Worker does **not** maintain another engineering task database. Cached assignment data exists only for routing/liveness and must be revalidated against live GitHub by ChatGPT before engineering action.

## Authority model

- **GitHub**: source, task delegation, PR assignment labels, PR ledger, CI proof, exact-head state, merge state, release/provenance truth.
- **ChatGPT**: engineering executor operating from the canonical Project Source and live GitHub state.
- **BKE Worker instance**: liveness, deterministic routing, webhook dedupe, browser safety, and heartbeat.
- **Human operator**: task delegation, ChatGPT authentication/OAuth/MFA/CAPTCHA, ambiguous-state recovery, and production/security authorization.

Worker stores no GitHub API token. ChatGPT uses its connected GitHub capability to recover repository truth.

## Worker identity and PR delegation

Each runtime requires a stable `BKE_WORKER_ID` matching:

```text
[a-z0-9][a-z0-9-]{0,62}
```

Its GitHub assignment label is:

```text
bke-worker:<BKE_WORKER_ID>
```

Operators create the worker labels in GitHub and configure the repository webhook to send both `pull_request` and `push` events to each worker endpoint.

The Worker accepts a PR assignment only when the open PR has exactly one worker label and it matches that runtime. A second active PR assignment for the same worker blocks instead of switching work.

## Wake behavior

### Pull request events

Signed `pull_request` events establish, update, or revoke the runtime's cached assignment.

- matching single worker label -> assign/continue;
- another worker's label -> ignore;
- multiple worker labels -> fail closed;
- own label removed -> revoke assignment;
- assigned PR closed -> revoke assignment.

### Push events

Signed `push` events are branch-filtered. A push wakes a worker only when its `refs/heads/<branch>` exactly matches that worker's currently assigned PR head ref.

A push to `main`, an unassigned branch, or another worker's branch cannot cross-dispatch that worker.

### Heartbeat

`BKE_WORKER_HEARTBEAT_SECONDS` defaults to **1800 seconds (30 minutes)**.

Heartbeat is recovery/liveness, never a task timebox. It runs only while a valid PR assignment is active.

If ChatGPT is busy, hydrating, unauthenticated, or otherwise not positively safe to interrupt, Worker sends nothing and retries on a later valid wake.

## Browser and instance isolation

Concurrent workers must not share writable runtime resources. Each worker needs a distinct:

- ChatGPT conversation/target;
- persistent Chromium profile;
- loopback CDP endpoint;
- durable state file;
- Worker HTTP listen address/port;
- heartbeat/runtime process.

Workers on the same host share `BKE_WORKER_RESOURCE_LOCK_DIRECTORY`. The process acquires exclusive leases for worker ID, ChatGPT target, profile, state file, and CDP endpoint. A collision fails closed.

The host-local lease protects workers sharing that lock directory. Durable PR ownership still lives in GitHub; ChatGPT must revalidate the PR label and open-PR ownership before acting.

Live `chatgpt.com` uses a normal human-owned Chromium session.

- authentication is human-only;
- OAuth/MFA/CAPTCHA/security challenges are never automated;
- CDP is loopback-only;
- browser credentials/profile contents are never committed, logged, uploaded, or returned by Worker APIs;
- current autonomous Worker is Chat-only and fails closed if configured for Work.

## Runtime state

```text
IDLE
WAITING_FOR_ASSIGNMENT
DISPATCHING
WAITING_FOR_ENGINEERING_EVENT
CONTINUING
BLOCKED
FAILED
```

Persisted state contains only liveness/routing data: configured ChatGPT target, active PR assignment cache, last dispatch, last GitHub delivery, last wake, and failure state.

If the process restarts after persisting `DISPATCHING` or `CONTINUING`, Worker cannot prove whether the prior prompt was sent. It enters `BLOCKED` rather than risk duplicate delivery. Operator recovery is explicit.

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

Manual continuation returns a conflict when no active PR is assigned.

## Per-worker configuration

Example worker A:

```text
BKE_WORKER_ID=worker-a
ASPNETCORE_URLS=http://127.0.0.1:5084

BKE_WORKER_CHATGPT_PROJECT="BKE Worker"
BKE_WORKER_CHATGPT_CONVERSATION="Worker Engineering A"
BKE_WORKER_CHATGPT_OVERRIDE_URL=""
BKE_WORKER_CHATGPT_BASE_URL=https://chatgpt.com/

BKE_WORKER_BROWSER_CDP_ENDPOINT=http://127.0.0.1:9222
BKE_WORKER_CHATGPT_PROFILE=/var/lib/bke-worker/profiles/worker-a
BKE_WORKER_HEADLESS=false

BKE_WORKER_GITHUB_WEBHOOK_SECRET=...
BKE_WORKER_STATE_FILE=/var/lib/bke-worker/state/worker-a.json
BKE_WORKER_RESOURCE_LOCK_DIRECTORY=/var/lib/bke-worker/locks

BKE_WORKER_WEBHOOK_DEBOUNCE_SECONDS=10
BKE_WORKER_HEARTBEAT_SECONDS=1800
BKE_WORKER_MIN_DISPATCH_SECONDS=30
```

Worker B needs its own ID, ChatGPT target, CDP port, profile, state file, and HTTP listen port.

For systemd multi-instance hosting use:

```text
deploy/systemd/bke-worker@.service
/etc/bke-worker/<worker_id>.env
```

## PR execution contract

One independent engineering intent belongs in one fresh PR:

```text
current main
-> fresh branch
-> new PR
-> bke-worker:<worker_id> assignment
-> implementation
-> minimum complete certification
-> exact-head proof
-> SHA-locked merge
```

PR descriptions remain human-readable. PR comments hold implementation, certification, blocked/reassignment, and merge checkpoints.

## CI policy

PRs are ledgers, not heavy-CI triggers.

Active CI is intentionally limited to:

- cheap automatic PR Guard; and
- explicit intent certification invoked only when the PR certification plan requires it.

For multi-worker runtime changes, the server certification includes a two-worker isolation/routing harness.

## Legacy Android prototype

Android Accessibility remains historical prototype evidence. Linux/.NET + persistent Chromium + loopback Playwright/CDP is the canonical autonomous runtime.

## Production boundary

This repository may certify PREPRODUCTION behavior remotely. Production deployment, credential cutover, browser-profile migration, or other production actions require separate explicit authorization.
