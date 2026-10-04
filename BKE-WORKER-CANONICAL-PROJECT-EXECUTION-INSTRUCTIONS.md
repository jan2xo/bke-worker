# BKE WORKER — CANONICAL PROJECT EXECUTION INSTRUCTIONS

## 0. PURPOSE AND AUTHORITY

This repository file is the canonical operating and architecture instruction set for **BKE Worker**.

Canonical control repository:

`jan2xo/bke-worker`

Every BKE Worker engineering ChatGPT must recover this file from the **current `main` branch** before substantial engineering action. A copy placed in a ChatGPT Project, prompt, memory, local note, or other workspace is only a convenience mirror and is never the durable authority.

Use this file for BKE Worker operating procedure and architecture. Use **live GitHub state in `jan2xo/bke-worker`** as canonical implementation, PR, CI, merge, release, and repository truth.

If this file conflicts with stale conversation context, follow this file. If it conflicts with live GitHub implementation state, use live GitHub for implementation truth. Explicit current user authorization governs ordinary execution unless a production/security lock below forbids it.

Do not use Notion as an execution database, task queue, checkpoint store, or canonical project truth.

## 1. CURRENT CANONICAL RUNTIME

The canonical autonomous runtime is:

`Linux/.NET -> human-authenticated persistent Chromium -> loopback Playwright/CDP -> ChatGPT Chat`

The Android Accessibility implementation remains historical prototype evidence. It is not the canonical autonomous runtime unless an intent explicitly targets it.

Active substantial CI is intentionally limited to:

- `.github/workflows/pr-guard.yml`
- `.github/workflows/certify.yml`

GitHub-native control-plane automation additionally includes:

- `.github/workflows/serial-dispatcher.yml` for deterministic single-worker Master Queue reconciliation.

The dispatcher is orchestration, not substantial certification. It must execute trusted default-branch code and must not become a second task database.

Historical Phase 3–6 workflows remain archived under `.github/legacy-workflows/2026-10-02/`.

The first GitHub-native multi-worker ownership model is implemented. Durable PR assignment uses exactly one label of the form:

`bke-worker:<worker_id>`

Zero worker labels means unassigned. More than one worker label is ambiguous and must fail closed.

## 2. ACCOUNT-INDEPENDENT WORKER BOOTSTRAP

A worker ChatGPT account may be completely different from the owner's ChatGPT account.

Therefore, a worker must not depend on:

- the owner's ChatGPT Project configuration;
- the owner's ChatGPT memory;
- prior private conversations;
- locally attached Project Sources;
- unrelated planning systems or account context.

Before acting, the worker must:

1. read this file from the **current `main` branch of `jan2xo/bke-worker`**;
2. recover live GitHub state for its assigned PR;
3. verify worker ownership;
4. verify the assigned PR exact head ref and SHA;
5. recover the PR intent and declared minimum certification graph;
6. continue only that assigned intent.

If the canonical file cannot be recovered from current `main`, or live GitHub ownership cannot be verified, stop fail-closed.

Trust split:

- **execution rules** come from this file on current `main`;
- **engineering changes** come from the assigned PR exact head.

A PR must never redefine the rules that govern its own execution merely by editing its branch copy of this file. If an intent changes this canonical instruction file, the pre-merge `main` version governs that PR until the change is certified and merged. The newly merged `main` version governs subsequent execution.

## 3. GITHUB IS THE ONLY DURABLE ENGINEERING TRUTH

GitHub is the canonical control plane for engineering work.

GitHub owns:

- source code;
- task/delegation state;
- branches;
- pull requests;
- execution checkpoints;
- CI/certification proof;
- exact-head state;
- merge state;
- releases/provenance where applicable.

BKE Worker must not create a second task database.

GitHub Projects may be used as a human-facing program dashboard or visualization, but Worker execution must not depend on GitHub Projects API availability. Issues, PRs, labels, comments, Actions, commits, and `main` remain sufficient durable execution truth.

### Serial Master Queue v1

Before parallel workers are introduced, the first executable queue is single-worker and GitHub-native:

- exactly one open Issue labeled `bke-queue:master` is the ordered human-facing checklist;
- checklist entries reference task Issues;
- an open task Issue is runnable only with `bke-task:ready` and without `bke-task:blocked`;
- queued task Issues do not own a worker;
- a materialized draft PR becomes the active execution contract;
- `bke-worker:android-worker-a` is the only dispatcher-owned worker assignment in v1;
- zero open PRs carrying that worker label means FREE;
- one means BUSY;
- two or more means ambiguous ownership and must fail closed;
- worker availability is derived across the owner's GitHub repositories, not from Android/Cloudflare liveness;
- when FREE, the dispatcher selects the first runnable task in Master Issue order, materializes/assigns exactly one PR, then stops;
- when BUSY, it assigns nothing;
- when no runnable task exists, it waits;
- task PR merge closes the task Issue via GitHub linkage, and the next reconciliation selects the next task;
- Cloudflare and Android remain wake/executor layers and do not store queue authority.

Serial dispatcher implementation details and recovery rules live in `docs/github-master-queue-serial-dispatcher.md`.

## 4. PR = TASK DELEGATION + EXECUTION LEDGER

For BKE Worker, a pull request is not merely a review surface. It is the durable unit of delegated engineering work.

Each independent intent uses:

`current main -> fresh branch -> new PR -> worker assignment -> implementation -> certification -> exact-head proof -> SHA-locked merge`

PR body:

- human-readable intent;
- architecture/security scope;
- minimum complete certification graph;
- required/not-required proof;
- worker assignment metadata when applicable.

PR comments:

- `BKE EXECUTION CHECKPOINT — IMPLEMENTED`
- `BKE EXECUTION CHECKPOINT — CERTIFIED`
- `BKE EXECUTION CHECKPOINT — MERGED`
- exact SHAs;
- workflow run IDs;
- artifact/provenance hashes;
- blocked/failure reason;
- reassignment/handoff evidence.

Do not use PR descriptions as chronological logs.

Do not reuse merged/old feature branches for new intents.

## 5. MULTI-WORKER OWNERSHIP REQUIREMENTS

Core rule:

`one worker instance -> one active PR assignment at a time`

And:

`one active PR -> one active worker`

Different workers may execute different PRs concurrently. Two workers must never actively own the same PR unless a separately certified handoff mechanism explicitly permits it.

The architecture requires:

- stable `worker_id` identity per worker instance;
- exclusive active PR ownership/claim semantics;
- dedicated ChatGPT target per worker;
- dedicated persistent Chromium profile per worker;
- dedicated loopback CDP endpoint per worker;
- dedicated durable worker state file per worker;
- independent heartbeat/liveness state;
- webhook dedupe safe across multiple workers;
- deterministic routing from GitHub activity to the correct worker;
- fail-closed behavior when assignment is missing, conflicting, stale, or ambiguous;
- explicit operator recovery/reassignment for crash-ambiguous states;
- no duplicate prompt delivery after uncertain dispatch.

Do not share a writable Chromium profile across concurrent workers.

Do not let multiple workers race on one PR or one ChatGPT conversation.

## 6. AUTHORITY MODEL

- **GitHub** = canonical source, task delegation, PR ledger, CI, merge, release/provenance truth.
- **This file on current `main`** = canonical BKE Worker operating and architecture contract.
- **ChatGPT engineering conversation / authorized Master** = engineering executor that reads this file from GitHub, recovers live GitHub state, and may decompose an already-authorized mission into necessary GitHub-durable dependency intents.
- **BKE Worker instance** = liveness, wake delivery, routing, webhook dedupe, browser safety, recovery heartbeat, and assigned-PR continuity. Worker runtime is not a planner.
- **Human operator** = mission authorization, ChatGPT authentication/OAuth/MFA/CAPTCHA, production/security authorization, explicitly owner-only decisions, and ambiguous-state recovery.

The engineering executor may create a fresh dependency PR only when that dependency is demonstrably necessary to complete the already-authorized mission. It must make the dependency durable in GitHub before execution. Unrelated improvements, nice-to-haves, speculative backlog items, and opportunistic refactors are not executable authority.

Worker runtime remains orchestration/liveness, not a second planner or task database.

## 7. CHATGPT / BROWSER BOUNDARY

The canonical autonomous surface remains ChatGPT Chat through a normal human-owned authenticated Chromium profile.

- Authentication is human-only.
- OAuth/MFA/CAPTCHA/security challenges are never automated.
- CDP is loopback-only.
- Browser profile contents/credentials are never committed, logged, uploaded, or returned by Worker APIs.
- Chat and Work are separate surfaces.
- Current autonomous Worker is Chat-only unless explicitly changed and certified.
- Different workers may use different ChatGPT accounts; shared account context is not an execution dependency.

## 8. STARTUP SEQUENCE FOR SUBSTANTIAL WORK

Before substantial BKE Worker engineering:

`read this file from current main -> recover live main/open PRs -> identify exact delegated PR/intent -> inspect exact head -> determine ownership -> recover minimum complete certification graph -> execute`

If there is already an active delegated PR for the worker, continue that PR rather than starting another independent intent.

If no active PR exists and the user or authorized Master explicitly authorizes a new intent, start from current main on a fresh branch and create a new PR using `.github/pull_request_template.md`.

## 9. AUTONOMOUS GATEKEEPER AND INTENT-DRIVEN EXECUTION

A substantial turn should complete one coherent certification intent whenever possible.

Continue through implementation, narrow debugging, exact-head certification, merge, and main verification when execution is already authorized and required certification is available.

A wake message is routing context only. Before engineering action, recover this current-main contract and live GitHub truth. Cloudflare, VPS, WebSocket, Android, Chromium, or other wake transports must not become task authority or a parallel planning database.

Within an already-authorized mission, use this durable decision rule:

1. if the assigned PR is runnable, continue it;
2. if it has an ordinary implementation/test failure, diagnose, fix, rerun, and continue;
3. if a discovered need is same-intent remediation, keep it in the current PR;
4. if a discovered need is a necessary independent dependency, checkpoint the parent as blocked by that dependency, release the parent's active worker assignment, create one fresh dependency PR from current main, make the dependency durable in GitHub, then execute/certify/merge it under the normal one-intent/one-PR rule;
5. after the dependency merges, re-evaluate and resume the parent when it is runnable;
6. if the current lane requires an owner-only action, checkpoint it as owner-blocked, release the active assignment, and continue another authorized runnable intent if one exists;
7. if nothing authorized is runnable, wait for the owner or a new authorized GitHub event.

An owner-blocked lane must not freeze unrelated authorized runnable work.

A necessary spawned dependency is not "invented work" when it is required by the authorized mission and is first made explicit/durable in GitHub. Nice-to-haves, speculative improvements, unrelated work, and opportunistic backlog creation remain forbidden.

Do not let one worker actively own both a blocked parent PR and its dependency PR simultaneously.

Detailed rules and failure semantics are documented in `docs/autonomous-gatekeeper.md`.

## 10. CI IS INTENTIONAL

PRs are ledgers, not heavy-CI triggers.

Automatic PR activity should remain cheap. Substantial certification is explicitly invoked only when the current certification plan requires it.

The certification plan, not path filters or PR existence, determines the proof graph.

## 11. EXACT-HEAD CERTIFICATION

Before merge:

1. record exact PR head;
2. verify the declared required certification graph;
3. verify all required proof ran against that exact head;
4. verify no relevant unresolved red remains;
5. review architecture/security boundaries;
6. SHA-lock merge when supported;
7. verify resulting main SHA;
8. write durable merged checkpoint.

Any head change makes older certification stale.

## 12. CURRENT EXPECTED CERTIFICATION MODULES

For the current GitHub-native runtime, the normal modules are:

- `core` for orchestration/contracts/state/webhook logic;
- `server` for published server/runtime behavior;
- `chatgpt` for controlled Playwright/ChatGPT adapter behavior;
- `relay` for Cloudflare webhook verification, per-worker Durable Object routing, WSS delivery semantics, and the declared Android relay protocol boundary.

Only run the minimum complete graph required by the actual change.

Android APK certification is not part of the canonical Linux/Playwright runtime unless the intent explicitly touches the Android path. A relay-only change should prove Android compatibility through the relay-owned cross-boundary contract and does not automatically require rebuilding the Android APK.

Notion certification is not valid or required because Notion is not part of canonical runtime authority.

Real human-authenticated Chromium/ChatGPT behavior is a separate live-host certification boundary and cannot be replaced by controlled CI browser tests.

## 13. PRODUCTION LOCKS

Unless explicitly authorized:

- no production deployment;
- no production credential cutover;
- no production browser-profile migration;
- no force push;
- no weakening of human-auth boundaries;
- no secret material in GitHub, logs, PR comments, artifacts, or ChatGPT prompts.

Preproduction certification must not be represented as production deployment.

## 14. PROGRAM DIRECTION

The program direction is autonomous multi-worker engineering with a Master Command Center and account-independent ChatGPT workers.

The human defines the mission and locked production/security boundaries. Pre-execution architecture should research and select one coherent technology combination, record dependencies, decompose independent intents, and define their certification graph before broad parallel execution.

The Master may route explicitly authorized work and may create necessary dependency intents inside the authorized mission envelope, but each independent dependency must first become durable GitHub work and then follow the normal fresh-PR/certification rules.

A blocked owner-only lane does not block the whole mission. The Master may continue other authorized runnable intents while preserving the blocked lane and its exact evidence.

Worker instances remain liveness/routing components and do not maintain a parallel planning database.

The active work queue, dependency relationships, blocked-owner state, and next executable intent are determined from live GitHub state, not hard-coded into this instruction file or stored as canonical state in Notion/Cloudflare/VPS.

## 15. CANONICAL MAXIMS

`GitHub is truth. PR is delegation + ledger. Worker is liveness, not planner.`

`One worker -> one active PR. One PR -> one active worker.`

`One intent -> one fresh PR -> minimum complete certification -> exact-head proof -> SHA-locked merge.`

`Canonical rules come from current main. Assigned work comes from the exact PR head.`

`Necessary dependency -> make it durable in GitHub -> fresh PR -> certify -> merge -> resume parent.`

`Blocked lane != blocked mission. Continue other authorized runnable work; wait only when nothing authorized is runnable.`
