# G0-08 — Dormant negative-only route-fence observer

**Parent:** [G0 lifecycle Issue #135](https://github.com/jan2xo/bke-worker/issues/135). **Source base:** `bke-worker@9085720fb6029c4cf532f9157c9671df0cd2bf39` (G0-01 through G0-07 merged).

## Purpose, authority and isolation

The G0-07 transaction kernel stages a candidate `retirement_fence_v1` + `retirement_epoch_v1` pair but cannot prove a live routing fence. G0-08 provides an **UNIMPORTED, read-only, negative-only** route-observation contract and an auditable inventory of the nine current `WorkerSession` operation seams. It **does not** change `src/index.js`, `wrangler.toml`, WebSocket registration, dispatch, ACK or recovery.

**Do not wire this helper into live paths as an allowlist.** No result authorizes a connect, wake, ACK, retry, assignment release or worker-ID reuse. A matching retired fence yields `RETIRED_BLOCKED`, with `authority:NONE`, `delivery_fenced:false`, `all_paths_fenced:false`, `atomic_commit_proven:false` and all privilege booleans false. A missing, damaged or mismatched pair produces `BLOCKED`, **never** `ALLOWED`. The transaction-shaped storage dependency is untrusted; a local test double does not establish actual Cloudflare Durable Object serialization, same-DO identity, owner consent or GitHub ownership.

## Contract

The exported `inspectDormantRetirementRouteFence(storage,{target,operation})`:

1. Synchronously copies and validates an exact plain `worker_id/repo/pr_number/expected_head_sha` target and one of the nine literal G0-03 `FENCED_OPERATIONS`. Unknown or extra privilege fields fail before any state reads. The canonical object is frozen before any await to defeat mutable-input time-of-check/time-of-use attacks.
2. Requires an injected `storage.transaction(callback)`; no nontransactional fallback. Reads `worker_id`, `retirement_fence_v1` and `retirement_epoch_v1` through the transaction handle, not external `storage.get`. No `put/delete/socket/send` is ever called.
3. Blocks persisted worker conflicts; absent fence+epoch; missing/corrupt, invalid or downgraded paired keys; mismatched worker, repo, PR or head; and transaction errors or invalid callback results. **A transaction return value alone is not proof of a storage read:** a closure-scoped callback count and completed immutable callback result must show exactly one inspection invocation, and the adapter must return that *same result object*. Skipping the callback, replacing its result, returning a clone, or invoking it more than once fails closed with `TRANSACTION_RESULT_INVALID`. This is source-level consistency of the injected adapter, **not proof of a genuine Cloudflare transaction or state provenance**. Both keys externally erased remains **undetectable from a never-retired DO**, and this function intentionally does not infer safety from absence.
4. Returns an immutable, redacted denial/result with all authority fields false. It never returns the stored fence record, retirement ID, websocket attachment, delivery ID, bearer, nonce or secret.

The seam inventory is `connect`, `register`, `dispatch`, `recover`, `send`, `ack`, `promote`, `socket-close`, `socket-error`. Tests verify all nine markers remain recognizable in `src/index.js`. In addition, **`ensureIdentity()` mutates stored identity before routing** and must be gated before its first write in any future live integration. Merely inserting checks into the nine handlers would be insufficient; the outer `WorkerSession.fetch` and WebSocket event sequencing, existing sockets, in-flight methods, transaction interleavings and registration-to-send race all require independent proof before enabling actual retirement.

## Exact-head adversarial certification

- Valid paired fence/epoch for each of the nine operations returns `RETIRED_BLOCKED` while never permitting action.
- Missing, partial, malformed, stale or contradictory pair; wrong worker/PR/head; forged privileges and unknown operations all deny.
- Transaction absent/broken, a forged *same-operation* `RETIRED_BLOCKED` result without invoking the callback, replacement of a callback-observed `BLOCKED`, a clone of a successful callback result, duplicate callback invocation and storage errors are all redacted and fail closed.
- Delayed-read target mutation after function entry cannot alter the canonical target/operation. Foreign initial target cannot be mutated into authority.
- Source inventory verifies no accidental `index.js` import, no Wrangler feature flag or runtime route.
- Required CI: cheap PR Guard + deliberate `/certify relay` at **exact PR head**. Android APK, production, live Cloudflare DO changes and actual browser/device are not required.

## FORGE formal review remediation

[FORGE/BKESITSolutions CHANGES_REQUESTED review #5595095449](https://github.com/jan2xo/bke-worker/pull/143#pullrequestreview-5595095449) correctly found that the original source observer trusted a forged transaction return despite the adapter skipping callback execution. The new closure-scoped callback invocation count and exact callback-result identity proof close this narrow source-integrity gap, with deterministic adversarial tests. The reviewed head and its 177-test certification are superseded by the remediation and cannot authorize a merge. A new independent exact-head review remains required.

## Separately locked future work

Before any real G0-07 writer or G0-08 observer may gate active runtime, the operator must separately authorize authenticated owner Access and per-action consent, verified Command Center private service principal and nonce issuance/one-use consumption, live same-DO provenance, trusted GitHub assignment/head, truly atomic **all-path** enforcement (including `ensureIdentity()`), crash/race and previously connected sockets, fenced readback, and credential and label release gates. Tests in this source PR are not evidence that any of those have been achieved. Do not enable PREPRODUCTION or production flags, deploy, modify credentials or revivify quarantined Android [PR #90](https://github.com/jan2xo/bke-worker/pull/90) / `bke-worker:android-worker-a`.

**Issue #135 remains OPEN / LIVE RETIREMENT BLOCKED** until independently reviewed exact owner scope and explicit operator authorization establish genuine live safety.


## G0 runtime interlock integration status — PR #145 (not retirement)

A separate **default-OFF operator configuration emergency-stop** is now imported by `WorkerSession` from `relay-runtime-quarantine-interlock.js`. The keys `BKE_G0_RUNTIME_QUARANTINE_ENABLED` and `BKE_G0_RUNTIME_QUARANTINE_WORKER_ID` are deliberately absent from `wrangler.toml`. Nothing was activated or deployed by the source change. An absent / literal `false` switch preserves existing v1 behavior; an intentionally set literal `true` denies the configured old worker identity, while malformed activation or identity denies all attempted operations.

The guard is inserted before the first `ensureIdentity()` write and across the actual `connect`, `dispatch`, `recover`, `rememberDelivery`, `sendActiveIfSafe`, WebSocket register/message, ACK, wake promotion and socket cleanup paths. Several asynchronous steps also recheck the flag just before writes or socket sending. These checks are best-effort protection against accidentally routing a known retired identity **only after an independently authorized deployment owner configures the stop**. They do **not** prove a linearizable retirement cutover.

**Mandatory missing proofs before merge or activation:**

- The interlock has **no authenticated owner consent, no trusted private issuer, no nonce consumption, no GitHub assignment proof, and no persisted retirement epoch**. Configuring it is a future human-controlled PREPRODUCTION gate, not a routine source operation.
- The current implementation intentionally does **not** call the G0-07 writer or G0-08 observer. No caller may interpret an absent tombstone as evidence of permission.
- A previously issued WebSocket wake or ChatGPT prompt remains uncertain. Mutable runtime configuration checks cannot serialize with existing Cloudflare Durable Object events, WebSocket closure, multi-step storage writes or a request already running in another deployed isolate. Even rechecking after individual awaits cannot guarantee that **every** in-flight operation was fenced.
- A matching configured worker identity does not guarantee a trustworthy persisted `worker_id`/wake/connection tuple. Any cross-identity corruption must fail closed in a separately proven same-DO transactional integration.
- The newly authored dedicated runtime-interlock adversarial-test **file creation was rejected by tool safety checks**; no such suite is present or certified. Existing Node + local relay smoke PASS only demonstrates absence of existing regressions with default OFF, **not correctness when the stop is enabled**. Do not claim independent ACCEPT, merge readiness or live retirement from that PASS.
- A trustworthy finish still requires Admin-authenticated private DO inspection, one-use authorization, atomic monotonic persisted fence+epoch, enforced cutover on all paths, old socket/delivery readback, explicit credential/assignment reconciliation, and a separate operator-approved real-world acceptance.

Track PR #145 and parent Issue #135 as **SOURCE IN PROGRESS / LIVE RETIREMENT BLOCKED**. Historical PR #90 and `android-worker-a` remain untouched.


## G0-07 transaction-writer result provenance (PR #145)

Independent source audit found that `stageRetirementFenceCandidate()` previously
trusted the value returned by an injected `storage.transaction()` adapter.
Unlike the remediated G0-08 read-only observer, it did not establish that its
callback had actually been invoked. A forged `STAGED`/`EXISTING` return
could therefore reach the post-transaction shape readback without a verified
callback, even though it **never granted retirement/assignment authority**.

The unimported G0-07 writer now requires **exactly one completed transaction
callback and the adapter returning the identical callback result object**
before inspecting its staged/existing outcome. Zero, duplicate, incomplete
or replaced callback results deny with `TRANSACTION_RESULT_INVALID`.
An exception may occur after a commit and continues to mean
`TRANSACTION_OUTCOME_UNCERTAIN`—not rollback.

This closes a **narrow injected-adapter result-provenance failure mode**; it
does NOT prove a real Cloudflare transaction, a one-shot owner nonce,
trusted GitHub scope, same-DO provenance, a successful live readback,
or a serialized all-path cutover. This writer remains **unimported** from
`WorkerSession`. Real/cloud tests remain required. The attempted
separate enabled-quarantine security-test file was previously denied by a
tool safety check and was not retried or bypassed; no such evidence is
claimed by this documentation change.

Required independent adversarial coverage before any merge or activation
must include callback skipped with forged positive return; twice invoked;
callback `BLOCKED` replaced with forged positive; cloned result; thrown
transaction after stage/commit; existing-fence readback forgery; interrupted
owner action; and real DO socket/delivery races. Do not treat ordinary
default-OFF smoke or source-only doubles as operational G0 retirement.


## Conditional wake reservation and socket send (PR #145)

Under the **explicitly configured** `BKE_G0_RUNTIME_QUARANTINE_ENABLED=true`
runtime mode only, the actual `WorkerSession.sendActiveIfSafe()` now uses
a short `ctx.blockConcurrencyWhile()` window for the local DO state read,
registered socket selection, and WebSocket send. No GitHub/network fetch or
owner-signing request takes place inside that window.

Before sending, the enabled path checks the DO's persisted worker identity
against the queued wake and registered socket identity and stops if **either**
`retirement_fence_v1` or `retirement_epoch_v1` storage key exists. This is
a *negative* marker check, not proof that an absent marker permits retirement
or releases a GitHub assignment. The configured legacy worker target is still
denied independently by the server-owned static quarantine predicate.

The enabled path persists `phase: sent` **before** calling `socket.send()`.
If persistence fails, it does not send; if sending fails or the process
crashes afterward, the delivery remains ambiguous and is **not**
automatically replayed as queued. This deliberately prefers recoverable
uncertainty and possible nondelivery over duplicate ChatGPT prompt delivery.
It is only a bounded local send ordering seam, **not a complete atomic
retirement cutover**.

The absent/default-OFF mode still runs the prior v1 implementation without
entering `blockConcurrencyWhile()` or reading any fence/epoch storage keys.
Neither switch key is declared in Wrangler; this PR does not deploy or
enable it.

**BLOCKED before approval/activation:** dedicated real Workerd tests for
pre-send crash, failed send, stored-fence presence or partial pair,
competing queued dispatch/ACK/socket replacement, profile ownership and
replay; trusted Admin consent and private issuer+nonce; a verified current
GitHub PR/head; real same-DO owner retirement transaction using a compatible
serial side-effect boundary; old socket and already-delivered prompt
disposition; credential/assignment release with explicit human approval.
Tests were not added here because the earlier attempted dedicated
security-test-file creation was tool-safety blocked. No existing suite's
green result may be cited as proof of this new behavior.
