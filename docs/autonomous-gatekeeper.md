# BKE Worker Autonomous Gatekeeper Protocol v1

## Purpose

BKE Worker must continue an already-authorized engineering mission without requiring the owner to remain in the middle of ordinary execution.

The design must preserve these invariants:

- GitHub is the only durable engineering truth.
- Current-main canonical instructions define execution rules.
- One worker instance owns at most one active PR at a time.
- One active PR has at most one active worker.
- A blocked lane must not freeze other authorized runnable work.
- Workers may create only work that is demonstrably necessary to complete an already-authorized mission.
- Nice-to-haves, speculative improvements, and unrelated ideas are not executable authority.
- Production/security/authentication boundaries remain owner-controlled and fail closed.
- Wake relays route events; they do not become planners, task databases, or authority sources.

## Authority layers

### 1. Owner-authorized mission

The owner defines the mission, constraints, and locked boundaries.

Example:

> Build a browser-native, multi-worker BKE Worker system that can run on Android Gecko and Chromium, route GitHub work to the correct worker, and continue ordinary implementation/certification autonomously.

That mission is the outer execution envelope.

### 2. GitHub durable gatekeeper

GitHub stores the execution graph:

- PRs;
- issues when needed;
- labels;
- exact heads;
- dependency relationships;
- execution checkpoints;
- certification evidence;
- merge state;
- owner-blocked state.

GitHub does not need a second task database beside it.

### 3. Current-main canonical contract

The current-main canonical instructions define how workers interpret GitHub state.

A PR branch may implement a future contract change, but the pre-merge main contract governs that PR until merge.

### 4. Wake relay

Cloudflare Worker, Durable Object, VPS relay, WebSocket broker, or equivalent transport may:

- verify inbound event authenticity;
- identify the intended worker;
- maintain connection/liveness state;
- deduplicate delivery IDs;
- forward bounded wake context;
- receive bounded ACK/status messages.

It must not:

- invent work;
- own the backlog;
- replace GitHub assignment truth;
- issue arbitrary code/DOM/shell execution;
- weaken ownership validation.

## Wake model

The wake packet is a hint to recover truth, not authority to execute by itself.

Example:

```json
{
  "protocol": 1,
  "type": "wake",
  "worker_id": "worker-a",
  "repo": "jan2xo/bke-worker",
  "pr_number": 24,
  "expected_head_sha": "0123456789abcdef0123456789abcdef01234567",
  "reason": "pull_request_event",
  "delivery_id": "github-delivery-id"
}
```

The worker must recover current-main canonical instructions and live GitHub state before engineering action.

The bounded ChatGPT continuation prompt may be:

```text
CONTINUE FROM PR

{
  "repo": "jan2xo/bke-worker",
  "pr_number": 24,
  "worker_id": "worker-a",
  "expected_head_sha": "0123456789abcdef0123456789abcdef01234567",
  "wake_reason": "pull_request_event"
}

Recover the canonical execution contract and live GitHub state.
Verify ownership and continue the authorized mission until no runnable authorized work remains.
```

The JSON is routing/context. GitHub + the canonical contract remain authority.

## Durable IF / ELSE decision engine

On every wake or continuation cycle:

```text
RECOVER current-main canonical contract
RECOVER live GitHub state
RECOVER authorized mission envelope
RECOVER current assignment and exact head

IF canonical contract cannot be recovered
    STOP FAIL-CLOSED

ELSE IF ownership is missing, duplicated, stale, or ambiguous
    STOP THAT LANE FAIL-CLOSED

ELSE IF assigned PR is runnable
    CONTINUE ASSIGNED PR

ELSE IF assigned PR has an ordinary implementation/test failure
    DIAGNOSE
    FIX
    RERUN
    CONTINUE

ELSE IF a discovered need is same-intent remediation
    EXECUTE INSIDE CURRENT PR
    CONTINUE

ELSE IF a discovered need is a necessary independent dependency
    RECORD PARENT BLOCKED_BY_DEPENDENCY
    RELEASE PARENT ACTIVE ASSIGNMENT
    CREATE FRESH DEPENDENCY PR FROM CURRENT MAIN
    CLAIM DEPENDENCY PR
    EXECUTE / CERTIFY / MERGE DEPENDENCY
    RE-EVALUATE PARENT
    RECLAIM PARENT WHEN RUNNABLE
    CONTINUE

ELSE IF current lane requires owner-only action
    RECORD BLOCKED_OWNER
    RELEASE ACTIVE ASSIGNMENT
    FIND ANOTHER AUTHORIZED RUNNABLE INTENT

ELSE IF another authorized runnable intent exists
    CLAIM IT
    CONTINUE

ELSE
    WAIT FOR OWNER OR NEW AUTHORIZED GITHUB EVENT
```

## Need classification

Every newly discovered need must be classified before execution.

### Same-intent remediation

Keep it in the current PR when it is required to make that PR correct and does not introduce a materially independent engineering intent.

Examples:

- missing test for the implementation already in the PR;
- parser bug exposed by the current certification;
- reconnect edge case in the transport being implemented;
- compile error caused by the current change;
- necessary documentation for the same contract.

### Necessary independent dependency

Create a fresh PR when all of these are true:

1. the dependency is necessary to complete an already-authorized mission;
2. it is a materially independent engineering intent;
3. it can be certified/merged separately;
4. it is not merely a speculative enhancement;
5. it does not cross an owner-only lock.

Examples:

- Android WSS transport discovers that a shared browser-worker protocol must exist first;
- controller routing requires a bounded registration/enrollment contract first;
- a parent PR cannot be safely certified until a reusable dedupe primitive is independently implemented.

The parent PR records the dependency and becomes non-active for that worker while the dependency PR is active.

### Invented or speculative work

Do not execute.

Examples:

- analytics because it "would be nice";
- unrelated dashboard work;
- refactors with no necessity for the mission;
- new products/features discovered opportunistically;
- performance tuning with no blocking requirement.

These may be recorded as suggestions only if useful, but they are not automatically authorized engineering work.

## Parent/dependency lifecycle

Example:

```text
PR #24 — Android WSS transport
ACTIVE worker-a
        |
        | discovers necessary shared protocol
        v
PR #24 checkpoint:
BLOCKED_BY_DEPENDENCY #26
worker-a assignment released
        |
        v
PR #26 — Worker Protocol v1
ACTIVE worker-a
        |
        | implement / certify / merge
        v
main updated
        |
        v
PR #24 re-evaluated
        |
        | if still valid and runnable
        v
worker-a reclaims #24
CONTINUE
```

A worker must never actively own the parent and dependency PR simultaneously.

## Owner-blocked lane behavior

Owner-required actions include, at minimum:

- production deployment/cutover;
- authentication, OAuth, MFA, CAPTCHA, or security challenges;
- credential provisioning or secret disclosure;
- explicit production/security authorization;
- ambiguous ownership/recovery;
- any decision explicitly marked owner-only by the mission or canonical contract.

When encountered:

```text
current PR
  -> durable BLOCKED_OWNER checkpoint
  -> preserve exact evidence
  -> release active assignment
  -> search authorized mission for another runnable intent
```

The owner being unavailable blocks that lane only.

The whole mission waits only when no authorized runnable work remains.

## Runnable-work selection

A candidate PR/intent is runnable only if:

- it is inside the authorized mission envelope;
- it is not already actively owned by another worker;
- its declared dependencies are merged/satisfied;
- it does not require an unresolved owner-only action;
- its branch/head/assignment state is unambiguous;
- its execution would not violate production/security locks.

When several runnable intents exist, deterministic ordering should be used. Initial recommendation:

1. resume previously blocked parent whose dependency just merged;
2. continue existing assigned PR;
3. highest-priority explicitly queued mission PR;
4. oldest runnable mission PR;
5. otherwise wait.

Do not use model preference as hidden scheduling authority.

## Worker state model

Recommended logical states:

```text
DISCONNECTED
CONNECTED
READY
RECOVERING_TRUTH
EXECUTING
WAITING_CERTIFICATION
BLOCKED_DEPENDENCY
BLOCKED_OWNER
WAITING_FOR_ASSIGNMENT
FAILED_CLOSED
```

A transport-level BUSY/READY signal is not itself engineering authority; it is liveness/execution state.

## Pending wake behavior

When a worker is already executing and another wake arrives:

- deduplicate by delivery ID;
- do not dispatch a second ChatGPT turn into the same target;
- keep at most a bounded "re-evaluate GitHub after current turn" flag;
- after the active turn completes, recover live GitHub truth again;
- stale wake details must never override newer GitHub state.

This avoids duplicate prompts while ensuring new GitHub activity is not lost.

## Multi-worker behavior

The same gatekeeper rules apply independently across workers.

```text
worker-a -> PR #24
worker-b -> PR #25
worker-c -> PR #26
```

Different workers may execute independent PRs concurrently.

If PR #24 spawns dependency #27:

- worker-a may release #24 and claim #27;
- another free worker may claim #27 only if GitHub assignment says so;
- no two workers may race the same dependency;
- parent #24 remains durably blocked until #27 is satisfied.

## Relay architecture

Target transport shape:

```text
GitHub
  -> signed webhook
  -> Cloudflare Worker / equivalent ingress
  -> worker-specific Durable Object / connection router
  -> outbound-established WSS
  -> Android foreground service OR Chromium extension
  -> browser adapter
  -> ChatGPT
```

The relay owns connection/liveness/dedupe only.

GitHub owns assignment and engineering state.

## Persistence model

Durable:

- GitHub PR/issue state;
- labels;
- dependency links/checkpoints;
- exact SHAs;
- certification runs/evidence;
- owner-blocked state;
- merge state.

Ephemeral/bounded:

- WebSocket connection ID;
- last delivery IDs;
- last ACK;
- current transport READY/BUSY;
- reconnect/session generation.

A Durable Object or VPS must not become a parallel backlog database.

## Failure semantics

### Ambiguous ownership

Fail closed.

### Duplicate wake

ACK/dedupe; do not send another prompt.

### Lost ACK

Re-read GitHub before retry. Never assume the previous ChatGPT dispatch did not happen.

### Worker disconnects while executing

Mark dispatch uncertain. Require recovery logic to inspect live GitHub/PR state before any replay.

### Dependency PR fails certification

Fix that dependency PR within its intent. Parent remains blocked.

### Owner-required gate encountered

Block the lane, release assignment, continue another authorized runnable lane if one exists.

### No runnable work

Wait. Do not invent work to stay busy.

## Certification expectations

A future implementation of this contract should prove:

- wake payload cannot create authority outside GitHub;
- duplicate wake does not duplicate ChatGPT prompt delivery;
- stale wake does not override newer head/ownership state;
- same-intent remediation stays in one PR;
- necessary independent dependency creates one fresh PR;
- parent assignment is released while dependency is active;
- merged dependency can wake/re-enable the parent;
- owner-blocked lane does not stop unrelated authorized runnable work;
- no runnable work results in waiting rather than invented tasks;
- multi-worker assignments remain exclusive.

## Canonical rule

The operational rule is:

> Continue autonomously inside the authorized mission. When a necessary new dependency is discovered, make it durable in GitHub and execute it under normal one-intent/one-PR rules. When one lane requires the owner, block only that lane and continue other authorized runnable work. When nothing authorized is runnable, wait.

## Notion mirror policy

A Notion copy of this design may exist for human readability.

It is explicitly non-authoritative:

- Worker execution must not read tasks from Notion.
- Notion must not become the queue, dependency graph, checkpoint store, or gatekeeper.
- If Notion and GitHub differ, GitHub/current-main canonical instructions win.
