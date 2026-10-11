# BKE Worker

BKE Worker is a GitHub-native engineering-office orchestration system with two operator-selected browser-integrated surfaces: **Android GeckoView + WebExtension** and **desktop browser WebExtension**. The existing Linux/Playwright code is preserved legacy implementation, not the target architecture.

GitHub is durable engineering truth. ChatGPT performs engineering. Worker provides liveness, deterministic PR routing, webhook dedupe, browser safety, and recovery heartbeat.

## Canonical execution contract

The authoritative BKE Worker operating and architecture instructions live in:

`BKE-WORKER-CANONICAL-PROJECT-EXECUTION-INSTRUCTIONS.md`

Every engineering Worker must recover that file from the current `main` branch of `jan2xo/bke-worker` before substantial action. A copy inside a ChatGPT Project, prompt, memory, or local workspace is only a convenience mirror and is not durable authority.

This makes Worker accounts account-independent: Worker A/B/C/etc. may use different ChatGPT accounts and do not need to share the owner's ChatGPT Project or memory.

## Multi-worker invariant

```text
one worker instance -> one active PR assignment at a time
one PR -> one active worker
```

Multiple workers may progress independent PRs asynchronously when each worker has its own browser/GeckoView session, ChatGPT target, extension/pairing identity, and state. Android and desktop WebExtension are alternative entry points to **the same office**, never independent task databases.

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
        +-- read canonical instructions from jan2xo/bke-worker current main
        +-- recover LIVE GitHub PR and worker label
        +-- verify assigned head ref + exact SHA
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
- **Canonical instruction file on current `main`**: BKE Worker operating and architecture contract.
- **ChatGPT**: engineering executor that recovers the canonical instruction file from GitHub and then operates from live GitHub state.
- **BKE Worker instance**: liveness, deterministic routing, webhook dedupe, browser safety, and heartbeat.
- **Human operator**: task delegation, ChatGPT authentication/OAuth/MFA/CAPTCHA, ambiguous-state recovery, and production/security authorization.

Worker stores no GitHub API token. ChatGPT uses its connected GitHub capability to recover repository truth.

A configured ChatGPT Project/conversation is a browser-targeting choice only. It is not BKE Worker authority. An override-link or otherwise isolated authenticated ChatGPT account is valid when the canonical GitHub contract and live PR state can be recovered.

## Program direction: pre-execution architecture + Master Command Center

> **Phased roadmap, not a claim of live certification.** **Now:** the owner and main-brain ChatGPT brainstorm, audit, and delegate through GitHub; independent workers execute assigned PRs. **Later:** a separately certified wake mechanism lets that same main office autonomously reconcile GitHub and continue already-authorized delegation. Either Android or desktop WebExtension can be the operator's entry surface.

The long-term target is to remove the need for the owner to issue every main-office continuation prompt. The owner remains the mission/security authority. A selected **Master ChatGPT** conversation researches the system, plans authorized work, delegates intents, and later (after a separately certified wake mechanism) can reconcile GitHub events and continue authorized work autonomously.

Before a large program is executed, Master should produce a **Pre-Execution Architecture Package** that covers:

- the desired finished behavior and mission boundary;
- reusable BKE capabilities and existing repository constraints;
- current technology research where freshness matters;
- viable **technology combinations**, not isolated product comparisons;
- incompatibilities and system-level tradeoffs;
- one recommended coherent architecture;
- ownership boundaries for identity, state, licensing, browser execution, deployment, and durable truth;
- API/data contracts, security model, failure model, deployment model, and scaling model;
- migration/compatibility strategy;
- the execution dependency graph;
- PR decomposition and parallelizable waves;
- the minimum complete certification graph;
- merge order, stop conditions, and production/security locks.

The intended operating model is:

```text
HUMAN OWNER
defines mission + constraints + locked boundaries
        |
        v
MASTER CHATGPT
researches combinations + locks coherent architecture
        |
        v
GITHUB CONTROL PLANE + BOUNDED WAKE DELIVERY
routes authorized PR events and durable evidence
        |
        v
N CHATGPT ENGINEERING WORKERS
        |
        +-- PR A -> worker-a -> isolated GeckoView or browser profile / ChatGPT A
        +-- PR B -> worker-b -> isolated GeckoView or browser profile / ChatGPT B
        +-- PR C -> worker-c -> isolated GeckoView or browser profile / ChatGPT C
        +-- ...
        |
        v
GITHUB PR LEDGERS + CI + EXACT-HEAD PROOF
        |
        v
MASTER reviews / corrects / certifies / merges / unlocks dependents
```

The Command Center is a routing, observation, and control surface. **It is not a second planner or task database. ChatGPT remains the reasoning brain and GitHub remains durable engineering truth.**

Engineering workers report through **GitHub PR checkpoints, commits, exact-head CI evidence, and blocking reasons**, not direct reports or transcript dumps to Master. GitHub events can wake Master in the future; Master must recover live GitHub before acting and classify that evidence against the authorized mission:

```text
same existing intent
-> update/clarify the current PR context
-> continue the assigned worker

new independent intent required by the authorized mission
-> current main
-> fresh branch
-> fresh PR
-> assign an available worker

ambiguous or outside mission
-> fail closed / surface for review
```

Removing the human from the keepalive loop does **not** authorize a self-invented backlog. Master may derive work that is necessary to complete the authorized mission, but it must not create unrelated product work.

The long-term target is **N concurrent worker identities**, limited by resource/isolation constraints rather than a fixed worker count. Every worker still preserves:

```text
one worker instance -> one active PR
one active PR -> one worker instance
```

The intended engineering intelligence layer is **normal ChatGPT Chat conversations with connected tools/capabilities**. Codex is not assumed or required as the worker brain. BKE Worker, future MCP capabilities, and future browser-extension infrastructure provide routing, liveness, browser/tool access, and bounded execution surfaces; ChatGPT performs the engineering reasoning.

The target is one engineering office that continues independent assigned work while the owner and main brain brainstorm elsewhere. The owner may return via Android tomorrow or a desktop extension the next day. GitHub is the resumable office ledger; a future autonomous Master wake is an explicit additional certification gate.

## Android GeckoView and desktop WebExtension — one office

**Selected architecture:** two browser-integrated surfaces, not Linux/Playwright as the preferred new execution model.

| Surface | Current implementation evidence | Next gate |
| --- | --- | --- |
| Android GeckoView + embedded WebExtension/native messaging | Historical live PREPRODUCTION GitHub -> Cloudflare relay -> Android -> ChatGPT "HELLO BOSS" proof (PR #38); recovery and continuation code merged later | Prove current device readiness and live continuation without losing human-authenticated app state |
| Desktop browser WebExtension | `browser-extension/` Manifest V3/TypeScript **probe-only** foundation: ChatGPT tab/composer/busy observation; no prompt dispatch yet | Certify authenticated transport, bounded dispatch, duplicate suppression, session recovery, and isolation |

Both surfaces must recover **the same authoritative GitHub PR/assignment state**. A change of device does not silently take over an active worker assignment or uncertain in-flight ChatGPT turn. Per-worker targets, sessions and bridge identities remain isolated.

The historical Linux/.NET + persistent Chromium + loopback Playwright/CDP implementation and its certification modules are preserved for evidence and intentionally scoped maintenance. They are **not part of the operator-selected Android/WebExtension target**. Do not delete or migrate them under a documentation-only PR.

See `docs/browser-extension-bridge.md` for the desktop extension's current probe contract, future transport requirements, and certification gates.

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

Concurrent workers cannot share a ChatGPT target, writable browser profile, GeckoView app session, WebExtension controller identity, or durable state. A worker must verify its unique `worker_id`, GitHub assignment, browser/session pairing, and safe composer state before delivery. Duplicate ownership, disconnected pairing, or uncertain in-flight execution fails closed.

The **preserved Linux server** separately enforces local resource leases for its legacy Chromium profile, loopback CDP port, state file, listen port, and worker process. Those ports and .NET configuration values are **not universal requirements** of Android or desktop WebExtension.

The target browser surfaces use human-authenticated ChatGPT Chat:

- authentication and OAuth/MFA/CAPTCHA/security challenges remain human-only;
- no cookies, credentials, GeckoView profiles, or extension secrets may be exported into GitHub/Worker APIs/logs;
- native-message and extension-origin commands are untrusted until worker identity, authorization, and delivery state are verified;
- legacy CDP remains loopback-only if used for legacy maintenance;
- ChatGPT Work is not part of the certified Worker execution surface.

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

## Legacy Linux server operator API (preserved)

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

## Legacy Linux/Playwright per-worker configuration (preserved)

The following environment example documents the existing server code, **not** the Android/desktop-WebExtension target. GeckoView/extension pairing and settings require their own platform contracts and certification.

Example legacy worker A:

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

Another legacy Linux worker needs its own ID, ChatGPT target, CDP port, profile, state file, and HTTP listen port. Android and desktop WebExtension workers require equivalent isolation, not these CDP variables.

The `BKE_WORKER_CHATGPT_PROJECT` / `BKE_WORKER_CHATGPT_CONVERSATION` values select a browser target when project-chat mode is used; they do not supply the canonical BKE Worker instructions. Separate worker accounts may instead use an isolated override link or another certified target mode.

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

For changes to the preserved legacy Linux server, server certification includes a two-worker isolation/routing harness. Android and WebExtension changes require their own relevant certification boundaries; doc-only changes need the cheap PR Guard and exact-head review.

## Historical implementation generations

The **older Android Accessibility controller** is historical prototype evidence and is distinct from the newer GeckoView/WebExtension Android runtime. Linux/.NET + persistent Chromium + loopback Playwright/CDP is preserved legacy implementation. The **selected target** is Android GeckoView/WebExtension plus desktop WebExtension, with separate live-certification gates for each.

## Production boundary

This repository may certify PREPRODUCTION behavior remotely. Production deployment, credential cutover, browser-profile migration, or other production actions require separate explicit authorization.
