# Multi-worker PR delegation

## Intent

BKE Worker supports multiple independent worker runtimes concurrently while preserving:

`one worker instance -> one active PR assignment at a time`

`one PR -> one active worker`

GitHub remains the durable engineering authority. Worker state is a liveness/recovery cache only.

## Stable worker identity

Every worker runtime MUST have a stable `worker_id`.

Canonical format:

`[a-z0-9][a-z0-9-]{0,62}`

Worker identity is configuration, not a task database. It identifies the runtime that may claim matching GitHub work.

## Durable PR assignment

A PR is assigned with exactly one GitHub label:

`bke-worker:<worker_id>`

Rules:

- zero `bke-worker:` labels -> unassigned;
- exactly one label -> assigned to that worker;
- more than one label -> ambiguous and fail closed;
- one worker observing a second concurrently active assigned PR -> conflict and fail closed;
- reassignment requires an explicit GitHub label transition and operator recovery when prior execution is crash-ambiguous.

The PR label is authoritative. Any assignment cached in a Worker state file is only a recovery hint and MUST be revalidated by ChatGPT against live GitHub before engineering action.

## Routing

Supported signed GitHub events are routed deterministically.

### Pull request events

Relevant `pull_request` events carry the PR number, head ref/SHA, state, and labels.

- adding this worker's `bke-worker:<worker_id>` label establishes the assignment and may dispatch;
- an `opened` or `reopened` event with one matching worker label may establish the assignment;
- unrelated PR metadata actions do not redispatch an already assigned worker;
- an assignment label for another worker is ignored by this worker;
- multiple worker labels are rejected as ambiguous;
- removing this worker's assignment label or closing the assigned PR revokes the cached assignment and stops automatic continuation.

### Push events

Push remains a wake source only when the pushed `refs/heads/<branch>` exactly matches the cached head ref of this worker's active assigned PR.

A push to `main`, an unassigned branch, or another worker's branch MUST NOT wake this worker.

Webhook delivery IDs are retained in a bounded durable recent-delivery window. Redelivery is suppressed even when another delivery arrived in between; dedupe is not limited to the immediately previous event.

## ChatGPT execution boundary

Each worker dispatch prompt identifies its `worker_id`, assigned PR number, expected head ref, and expected head SHA. Before acting, ChatGPT must recover `BKE-WORKER-CANONICAL-PROJECT-EXECUTION-INSTRUCTIONS.md` from the current `main` branch of `jan2xo/bke-worker`, then recover live GitHub state.

The worker ChatGPT account does not need to share the owner's ChatGPT Project, memory, or prior chats. Those surfaces are never execution authority.

Before implementation or merge work ChatGPT must verify:

1. the PR is still open;
2. the PR has exactly one `bke-worker:` assignment label;
3. that label matches this `worker_id`;
4. this `worker_id` does not own a second open PR;
5. the recovered head SHA matches the intended PR before exact-head certification or merge.

If any ownership check is ambiguous, execution stops.

Worker remains liveness/orchestration. It does not invent work or maintain a parallel task queue.

## Per-worker isolation

Concurrent workers MUST NOT share writable runtime resources.

Each worker uses its own:

- ChatGPT target;
- persistent Chromium profile;
- loopback CDP endpoint;
- durable state file;
- heartbeat/liveness state.

Workers on the same host use a common resource-lock directory. Exclusive leases cover worker ID, ChatGPT target, profile, state file, and CDP endpoint so an accidental shared resource fails before dispatch.

The lease is intentionally host-local. GitHub remains the cross-runtime ownership authority, and ChatGPT revalidates live PR ownership before acting.

Authentication remains human-owned. OAuth, MFA, CAPTCHA, and security challenges are never automated.

## Crash and reassignment semantics

A restart from an uncertain `DISPATCHING` or `CONTINUING` state remains fail closed.

If a worker receives a different active PR assignment while it still owns one, it blocks instead of switching work.

If a worker starts with no cached assignment while GitHub already contains an assignment label, it remains `WAITING_FOR_ASSIGNMENT` until an explicit assignment-establishing PR event is delivered. The operator may remove/re-add the label or redeliver the relevant assignment webhook; Worker does not query GitHub with its own token.

Safe reassignment sequence:

1. stop or recover the old worker;
2. remove/replace the old PR assignment label in GitHub;
3. ensure no ambiguous worker labels remain;
4. deliver the new PR assignment event;
5. resume only after ownership is unambiguous.

## Certification target

The first multi-worker wave must prove with two isolated worker runtimes that:

- worker A advances only PR A;
- worker B advances only PR B;
- webhook deliveries do not cross-dispatch;
- duplicates do not double-dispatch;
- ambiguous assignment fails closed;
- duplicate worker ownership fails closed;
- assignment removal stops continuation;
- state, target, profile, and CDP configuration are isolated;
- required proof is exact-head and SHA-locked before merge.

Production remains locked unless separately authorized.
