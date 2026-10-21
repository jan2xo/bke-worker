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

A separate **default-OFF operator configuration emergency-stop** is now imported by `WorkerSession` from `relay-runtime-quarantine-interlock.js`. The keys `BKE_G0_RUNTIME_QUARANTINE_ENABLED` and `BKE_G0_RUNTIME_QUARANTINE_WORKER_ID` are deliberately absent from `wrangler.toml`. Nothing was activated or deployed by the source change. An absent / literal `false` switch retains normal v1 routing when no persistent retirement marker exists, **but now performs explicit negative-only storage reads**; a committed marker blocks routing regardless of later flag changes. A literal `true` also denies the configured old worker identity; malformed activation or identity denies all attempted operations.

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

The absent/default-OFF mode now shares the transactional pre-send
reservation and bounded `blockConcurrencyWhile()` path with enabled mode.
It also reads persisted fence/epoch markers and fails closed if one exists
or a storage read is uncertain. This deliberately changes v1 ordering to
avoid duplicate delivery after crash-ambiguous `socket.send()`.
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


## Enabled-mode persisted marker enforcement extension

With `BKE_G0_RUNTIME_QUARANTINE_ENABLED=true` only, the shared
`WorkerSession.quarantinedBoundWorker()` now fails closed if its actual
bound DO has **either** `retirement_fence_v1` or
`retirement_epoch_v1`, even when its worker ID is otherwise consistent.
`ensureIdentity()` checks the same two keys **before first write**,
preventing accidental resurrection of an untrusted partial or complete
retirement marker. Malformed, unreadable and partial markers deny; this
read-only enforcement never writes or deletes a retired record.

This change is part of the source-only preparation for a durable fence.
It is not atomic proof that *all* already-in-flight
`dispatch/recover/ACK` paths are synchronized with future privileged
retirement RPCs; it does not certify shutdown of an earlier browser send
or previously delivered ChatGPT prompt. Runtime feature remains
undeclared in Wrangler and OFF. Real Cloudflare and adversarial concurrency
tests plus owner/nonce/head authority and live retirement transaction are
mandatory before activation or PR merge.


## Permanent negative tombstone enforcement independent of env config (PR #145)

The runtime now calls `WorkerSession.persistentlyRetired()` before the
first `ensureIdentity()` write and at the relay fetch/dispatch/recover,
send, WebSocket, ACK and relevant post-await side-effect boundaries.
It reads the actual bound DO's `retirement_fence_v1` and
`retirement_epoch_v1` keys and **denies if EITHER key is present**, whether
complete, partial, malformed or for a conflicting worker. Failed reads deny
as uncertain. This is intentionally independent of
`BKE_G0_RUNTIME_QUARANTINE_ENABLED`: disabling a temporary env switch must
not permit a previously retired identity to resume routing.

This change adds storage reads even when the temporary quarantine switch is
absent. Normal v1 *routing decisions* should remain unchanged with two
absent keys, but timing/IO behavior is NOT bit-for-bit identical and requires
regression evidence. This is a security-over-performance choice, not a
deployed feature claim.

**Important incomplete guarantees:** A negative read followed by an
external call or a nontransactional `put/delete` is not an atomic
retirement barrier. The future owner-authorized writer and all live
operations must share a proven serializable cutover boundary to stop
in-flight writes, registration/ACK and already-connected sockets. A legacy
deployed version that does not read tombstones can still bypass a new fence
until it is retired. An externally erased pair cannot be distinguished from
a never-retired DO unless an independent monotonic source exists. Absence
of both markers is NOT positive owner permission.

No owner-signed writer is imported, no live DO writes/deploys occurred, and
no special G0 runtime configuration was provisioned. Dedicated interlock
adversarial/concurrency tests previously failed a tool safety gate and
remain NOT_RUN; do not call this work independently certified or ready for
merge/activation despite ordinary regression CI being green.


## Exact-delivery transactional ACK and queue promotion (PR #145)

ACK persistence now shares a same-DO `ctx.storage.transaction()` boundary
with the future retirement tombstone writer: it reads both
`retirement_fence_v1` and `retirement_epoch_v1`, verifies the
persisted `worker_id` against the registered socket's worker, and
re-reads `active_wake` inside that same transaction to match the exact
ACK delivery. Only then may it persist an `accepted/deferred` phase or
delete the completed/rejected delivery. Missing, conflicting, partially
retired or corrupt worker/delivery state refuses mutation; uncertain
transaction failures close the socket without an ACK retry.

Following a successful deletion, queued-wake promotion now uses a second
same-DO storage transaction to verify that **neither retirement marker
exists, no other active wake has appeared, and the queued wake validates
against the DO's persisted worker**. Delete-queue and write-active occur
inside the same transaction. Only a successfully promoted wake can enter
the separate `sendActiveIfSafe()` path, where retirement is checked again.

These are *local atomic ACK/promotion side-effect boundaries*, not an
atomic owner retirement protocol. Dispatch still includes several
nontransactional state writes and outbound GitHub work can interleave.
A previously delivered ChatGPT prompt cannot be recalled. A deployed
relay version without these fences can bypass them. Human Admin
authentication, private issuer+nonce, an authoritative same-DO witness,
the real owner-authorized tombstone writer, complete serialized
dispatch/register/send race tests, and independently reviewed exact-head
evidence remain REQUIRED before merge/activation.

**Verification status:** existing relay regression tests and local
Workerd smoke are required again after this head; there are still no
dedicated enabled-retirement, transaction-race or stale-ACK
adversarial tests because an earlier attempt to create that test file
was safety-blocked and has not been bypassed. Do not represent normal CI
success as security acceptance.


## Same-DO transaction for WebSocket registration (PR #145)

The `register` message now establishes `active_connection_id` only
inside a `ctx.storage.transaction()` that reads the same DO's
`retirement_fence_v1`, `retirement_epoch_v1`, and `worker_id`.
Any marker, identity mismatch or uncertain transaction denies/ closes
registration. A recheck before marking the socket attachment registered
also denies detected retirement. This is intended to prevent a
registration racing a future owner tombstone writer from both winning
on a stale pre-registration snapshot. The future writer already refuses
candidate retirement while `active_connection_id` is persisted.

Together with the transactional ACK and queued-promotion changes,
this addresses **specific durable mutation races** without importing
the currently untrusted owner writer. It does **not** prove that
preexisting unregistered sockets are quiescent, that dispatch/recovery
writes are serialized, that an external ChatGPT prompt was not already
delivered, or that the owner/HMAC/nonce/PR-head authority is valid.
No Cloudflare deployment, new route, credential change or owner
retirement was performed.

There are no dedicated adversarial Workerd tests of these newly
modified registration, ACK and promotion transactions in PR #145:
earlier security test-file creation was denied by tool safety checks.
Until proper independently permitted tests and security review exist,
the PR remains draft, **NOT_READY_FOR_AUDIT/MERGE/ACTIVATION**.


## Atomic dispatch delivery-ledger and wake mutation (PR #145)

`WorkerSession.dispatch()` now performs a short local same-DO
`ctx.storage.transaction()` that reads `retirement_fence_v1`,
`retirement_epoch_v1`, and persisted `worker_id` before deciding
whether a validated wake can be queued. Deduplication, current
active-wake / cross-PR semantics, recent-delivery record, and the
chosen active/queued state mutation are evaluated and committed in
**one transaction**, with no external GitHub calls or socket sends
inside its callback. A partial/full retirement marker or worker
identity conflict denies dispatch. An uncertain transaction throws
`DISPATCH_OUTCOME_UNCERTAIN`; it is not retried automatically.

After the transaction, a send opportunity is explicitly bound to
the **exact committed delivery ID**. If another concurrent dispatch
replaces that delivery before `sendActiveIfSafe(expectedDeliveryId)`,
the old caller cannot send the newly replaced wake in its place.
The same exact-ID binding is used after queued wake promotion.

This preserves the former cross-PR, synchronize, continuation and
coalescing response-state contract as far as the existing tests prove,
but changes timing and transaction boundaries. It is NOT proof of
full retirement linearizability: `recover()` still has independent
state transitions and external GitHub I/O, some previously registered
sockets may still exist, and a deployed legacy version without these
checks could act on the same storage. The authenticated owner
transaction and authoritative current DO/PR witness remain absent.
No new security tests were added: the earlier dedicated security
test-file attempt was tool-safety denied and not bypassed.
Dedicated Workerd concurrent dispatch versus retirement/recovery
tests remain mandatory before independent security acceptance.


## Transactional GitHub recovery wake reconstruction (PR #145)

`WorkerSession.recover()` performs GitHub ownership discovery **outside**
the Durable Object storage transaction. After completing that bounded
external read and resolving conflict to fail-closed, the handler now
re-reads the current DO `retirement_fence_v1`, `retirement_epoch_v1`,
`worker_id` and `active_wake` inside a **single storage transaction**.
The `planRecovery` decision, any active/queued deletion, and any
reconstructed active-wake write are committed together. A retirement
marker or worker identity conflict denies, while uncertain transaction
outcomes produce `RECOVERY_OUTCOME_UNCERTAIN` with no automatic replay.

For plans that create a `queued` wake, the later WebSocket send is bound
to the precise `delivery_id` selected in that recovery transaction,
preventing an older recovery invocation from inadvertently sending
another transaction's replacement wake.

This reduces DO-local stale-read races **but does not prove GitHub
ownership CAS**: the external GitHub label/head could change after
recovery discovery and before the local commit. No owner authentication
or privileged retirement writer is imported. Already delivered prompts,
preexisting sockets, legacy deployments and remote GitHub mutation
cannot be made atomic with this storage transaction. Dedicated
concurrent recovery-vs-retirement, GitHub ownership drift, malformed
prior wake and failed commit security tests remain NOT_RUN because a
prior attempt to create the dedicated test file was safety-blocked
and was not bypassed. Keep source PR draft until independent proof.


## Unified transactionally reserved WebSocket send (PR #145)

The send boundary is now **unconditional**. Both normal/default-OFF and
explicit-quarantine execution use `sendActiveIfSafeDelivery()` behind the
canonical `sendActiveIfSafe()` entrypoint. A short DO
`blockConcurrencyWhile()` selects the registered authoritative socket,
then a same-DO storage transaction reads the persisted worker,
`active_connection_id`, `active_wake`, and both retirement markers.
The transaction requires a valid **queued** wake, exact socket/worker/
connection agreement, and the specified delivery ID when supplied by
a preceding dispatch/recover/promotion transaction. It persists
`phase: sent` before any WebSocket send attempt.

Only the wake object actually reserved by the transaction is serialized
and sent. On a throw/connection failure after the commit, the outcome
is **uncertain**: no rollback of the sent reservation and no automatic
redelivery. No GitHub/network I/O occurs inside this local gate.

This removes the previous default-OFF v1 `socket.send`-then-`put`
crash ambiguity and default-mode unguarded socket/worker mismatch.
It changes normal runtime event scheduling and write-before-send timing,
which requires dedicated Workerd testing for pre-commit failure,
post-commit failure, stale socket replacement, concurrent dispatch,
partial/tampered tombstones, double-send, and retry suppression.
The existing default-OFF smoke/181-node test graph does **not**
certify these adversarial properties.

This is **not** a privileged retirement writer, owner authentication
flow, nonce/PR-head CAS, old-socket termination proof or authorization
to deploy. The earlier attempted dedicated test-file creation was
tool-safety blocked; no route around that restriction was attempted.
The PR remains DRAFT/UNMERGED until independent enabled-mode security
proof and explicit separate owner action scope are complete.


## Exact connection-ownership CAS for ACK and socket cleanup (PR #145)

A stale socket could pass the earlier `active_connection_id` check in
`webSocketMessage()`, yield during a subsequent read, and then mutate an
active delivery after a newer socket had registered. The ACK storage
transaction now re-reads `active_connection_id` and requires the same
registered socket attachment connection ID, exact worker and delivery ID,
and an eligible already-sent phase (`sent`, `accepted`, or `deferred`)
**inside that transaction**. An ACK for `queued` or
`recovery_required` cannot clear or advance an unsent delivery. A stale
connection refuses mutation without promoting a different queued wake.

`clearConnectionIfAuthoritative()` previously performed a standalone
read of `active_connection_id` followed by an unconditional delete. A
newer registration between those two operations could be erased by the
old socket's close/error event. Cleanup now performs exact worker and
connection-ID compare-and-delete inside the same DO storage transaction,
under the same immutable retirement marker checks. Stale or malformed
attachments, retired DOs and uncertain transaction outcomes never trigger
a second deletion attempt.

This closes two **specific source-level connection handoff races** and
preserves `one worker -> one active connection authority`. It does
not prove the remote ChatGPT message outcome, human owner authentication,
nonce/PR-head authorization, full in-flight send cutover, or credential
release. No new adversarial live-Workerd tests were added; earlier
creation of the dedicated activated-mode security test file was
safety-blocked and not bypassed. Existing regression CI cannot
independently certify real concurrent registration/ACK/close behavior.
