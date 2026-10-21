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


## Explicit uncertain send outcome after durable reservation (PR #145)

The real `WorkerSession` previously returned `false` when
`socket.send()` threw **after** storing `active_wake.phase = sent`.
Both `dispatch()` and `recover()` then reported a `*_queued` state,
misrepresenting a possibly delivered ChatGPT prompt as safe to queue.

`sendActiveIfSafeOutcome()` now reports three distinct internal
outcomes: `sent` when the WebSocket send call returned; `not_sent`
when no reservation was made or accepted; and `uncertain` when the
storage transaction threw with a possible commit or a send threw after
a committed reservation. The established boolean entrypoints
`sendActiveIfSafe()` and `sendActiveIfSafeDelivery()` remain in
place for existing callers; the dispatch/recover endpoints use the
richer outcome and return `state: delivery_outcome_uncertain` for
uncertain sends rather than falsely claiming `queued`.

An `uncertain` response is **never** authorization to replay, rearm,
release the PR assignment, or override the persisted state. Successful
return from `socket.send()` is likewise only an attempted transport
send, not proof of remote ChatGPT delivery/ACK. This does not
authenticate a retirement owner or implement the monotonic owner
tombstone/epoch writer.

Dedicated tests covering transaction throw-after-commit, socket send
failure after durable reservation, concurrent wake replacement,
partial retirement markers, and the caller's recovery decision remain
NOT_RUN. The prior security-test-file creation safety denial was not
bypassed; existing 181-test green alone cannot certify these cases.


## Transactional first-identity admission (PR #145)

`WorkerSession.ensureIdentity(workerId)` previously performed a
negative read of the retirement fence/epoch, then read `worker_id`,
then checked retirement again, and finally issued an **independent**
`put(worker_id)`. A concurrent retirement transaction could commit
after the final marker read but before the identity write. Repeated
nontransactional checks were insufficient to prevent this first-write
race.

The method now performs the retirement-marker checks, persisted
identity comparison, and initial `worker_id` insertion in **one short
same-DO `storage.transaction()`**, validating the worker ID before
admission. Either stored marker, existing identity conflict, malformed
worker ID, or transaction error causes denial. If a transaction throws
after committing, this method returns denied/uncertain and does not
repeat its write. No external GitHub/network I/O occurs inside this
transaction.

This narrows the future retirement cutover to a common local storage
serialization boundary, but it is **not** a complete authorized
retirement writer: trusted owner consent/issuer and one-use nonce,
actual GitHub PR/head/worker assignment proof, already-active socket
fencing, crash ambiguity, stale deployments and real Workerd race
tests are still required. The earlier separate adversarial test-file
creation was safety-denied and was not bypassed. Passing baseline
regressions cannot prove those pending conditions.


## Non-interleavable WebSocket registration handoff (PR #145)

The old registration handler committed `active_connection_id`, then
awaited a separate retirement read **before** serializing the new socket
attachment and closing previously registered sockets. Two competing
registrations could interleave there: register A could admit, register B
could replace A, and resumed A could then close B's socket or mark A
registered despite no longer owning the stored connection ID.

The real `WorkerSession` now holds a **short local**
`ctx.blockConcurrencyWhile()` gate across the in-DO
`storage.transaction()` registration CAS, the final retirement-marker
read, `serializeAttachment()`, and the retiring of older registered
sockets. The transaction still checks BOTH persistent retirement markers
and the exact bound worker ID before writing `active_connection_id`.
No external GitHub, authorization, browser, or remote network call occurs
inside the gate; the subsequent queued-wake send happens **outside** it
and applies its own atomic reservation/connection-ID checks.

An ambiguous registration commit fails closed; there is no retry or
automatic assignment release. An older socket whose close fails is still
non-authoritative under the persisted connection-ID comparisons in ACK
and cleanup. The gate increases event serialization during connection
handoff and must be evaluated under real Workerd registration/replacement
races and interruption. Those dedicated adversarial tests are still
NOT_RUN following the earlier safety-denied test-file creation, which
was not bypassed. Existing relay regressions cannot prove all these
races or authorize the retirement writer.


## G0 recovery evidence preservation (PR #145)

When GitHub assignment discovery returns **zero current assignments**, it is
not authority to erase a durable `active_wake` or `queued_wake`.
Recovery now returns `unassigned_delivery_preserved` (409) without
deleting or replacing either record. If GitHub selects another PR/head
while a non-queued wake persists, `assignment_drift_requires_owner` (409)
preserves the original delivery ID and phase instead of synthesizing
another `recovery_required` wake or dispatching a new ChatGPT prompt.
A genuinely empty DO with no assignment still returns
`waiting_for_assignment` without mutations. A queued-only case retains
its original delivery. The DO transaction validates both persisted wake
slots before planning.

This removes two automatic evidence-discard paths from the source runtime.
It does **not** certify cancellation, GitHub/DO atomicity, a live tombstone,
or earlier deployed code versions; nor does it implement authenticated
owner reconciliation. Regression assertions were added only to the
existing `reconnect-recovery.test.mjs` for this distinct recovery change.
The previously safety-denied enabled-G0 adversarial test-file creation
was not retried or bypassed. Real Workerd concurrency, trusted owner
authority, one-use private nonce, same-DO witness, full deployment-version
barrier and independent security review remain required.


## Owner-to-WorkerSession retirement authority: exact dependency contract (PR #145)

Status: **DESIGNED / NOT IMPLEMENTED / NO AUTHORIZATION GRANTED**.
This section describes the *minimum trusted integration* to be proven in a
separate review. It is not a public route, runnable issuer, or owner consent.
The current `G0-05` HMAC verifier is purpose-bound to
`read_retirement_witness_v1` and intentionally returns
`COMMAND_SIGNATURE_VERIFIED_ONLY`. It cannot be upgraded by interpreting
a successful MAC as an authenticated owner, permission to read, or authority
to persist `retirement_fence_v1`. The dormant G0-07 writer also grants NONE.

### Concrete principals and order of operations

1. **Human-owned Admin origin, before any privileged DO read.** A separately
   secured Command Center control plane must enforce real Cloudflare Access
   policy and independently verify the Access application JWT cryptographic
   signature, pinned issuer, application AUD, expiry/not-before, human
   principal type and explicit Admin authorization. Reject missing/invalid
   claims, wrong Access application, non-human service-token identity, or
   provider outage. The owner must explicitly confirm **this specific
   retirement action** and its named effects *after* viewing a trusted,
   redacted pending-delivery scope; browser-supplied `owner_authenticated`,
   consent booleans and copied JWT payload JSON have no authority.
   Human OAuth/MFA/CAPTCHA remains manual.
2. **Server-only GitHub authority preflight.** Using the private GitHub App
   broker, resolve the exact repository ID, OPEN PR number, HEAD SHA,
   single worker assignment label, and absence of competing assignments.
   Discover the exact WorkerSession namespace/generation and target worker ID
   from trusted configuration, not from a caller-chosen DO URL/ID. A GitHub
   comment or webhook payload alone is insufficient; both can outlive an
   assignment. Missing or conflicting evidence returns BLOCKED.
3. **Distinct private command issue.** After owner consent and GitHub proof,
   a dedicated, nonpublic issuer may produce an audience- and
   purpose-restricted short-lived retirement decision containing action
   `retire_preproduction_worker_v1`, exact worker/repo/PR/head, DO generation,
   owner decision identifier, a cryptographically random one-use nonce,
   expiry, and the expected **full delivery set**. The issuer must own its
   signing key and provenance; neither a device, PR, browser, nor generic
   relay bearer may mint this command. The existing *inspection* HMAC
   purpose/key is not retirement authority and must not be reused.
4. **Private transport is NOT identity.** Use an explicitly declared
   narrowly scoped internal service binding only after the issuer is
   authenticated. Cloudflare documents that Access `ctx.access` is **not
   propagated** over service bindings; downstream cannot infer Admin identity
   from the transport or accept a self-asserted `trusted` property. An
   independently authenticated, scope-bound issuer assertion and a
   receiver-side authorization check are both needed. Never expose a
   public WorkerSession `/retire` endpoint, or put secrets/JWTs in PR logs.
5. **Real same-DO authoritative witness and CAS.** In the *existing*
   `WorkerSession` for the derived `v2:<worker_id>`, inspect persisted
   `worker_id`, exact active/queued delivery IDs, phases, recent IDs,
   `active_connection_id` and registered live WebSocket attachments.
   Readbacks must explicitly distinguish `UNKNOWN` from a proven worker
   ACK: no historical ACK timestamp or remote ChatGPT cancellation can
   be invented from an empty key. For retirement, perform only a short
   **same-DO storage transaction**: compare target and expected full
   delivery/connection state, validate previous epoch/fence, CAS a one-use
   nonce or consumed decision, and atomically persist an immutable monotonic
   `retirement_fence_v1` plus `retirement_epoch_v1` or return BLOCKED.
   Never put slow GitHub/Access/network I/O inside `storage.transaction()`
   or `blockConcurrencyWhile()`. A GitHub preflight and DO CAS are not
   a globally atomic distributed transaction: scope freshness,
   intervening-drift rejection and uncertainty handling require independent
   proof. Repeated or possibly committed transactions must not auto-retry.
6. **Socket/prompt and deployment barrier.** After a proven fence+epoch
   readback, deny subsequent register, send, dispatch, recover, ACK,
   promotion, and old-socket cleanup; close registered sockets without
   claiming that this cancels a prompt **already delivered to ChatGPT**.
   All still-serving deployment generations must be proven to honor the
   persisted fence before cutover. Any old script, unreadable old socket,
   uncertain ACK, missing full delivery set, or ambiguous commit remains
   **BLOCKED / owner adjudication required**, not silently `cancelled`.
7. **Release is a separate step.** Only after the prior steps have
   independently passed may a *separately authorized* operation revoke the
   precise worker credentials and reconcile the GitHub assignment label.
   If that external step fails, preserve the DO fence and record the partial
   failure in GitHub; never erase/reissue a wake or reuse `android-worker-a`
   automatically. Identity reuse/re-enrollment needs its own certified plan.

### Current concrete blocking evidence (2026-10-21)

- [BKE Command Center #30](https://github.com/jan2xo/bke-command-center/issues/30)
  still lists verified Admin owner identity, private credential issuer and
  real pairing/revocation proof as pending; it grants **no** G0 retirement
  consent, issuer, or service-binding implementation.
- [BKE Worker #135](https://github.com/jan2xo/bke-worker/issues/135)
  explicitly declares PR #90 / `android-worker-a` with two known pending
  delivery IDs and **no authoritative cancellation**. The actual DO may
  contain queued/sent work. No signed owner decision or independent current
  DO inspection has been supplied.
- `WorkerSession.dispatch()` still deliberately supports
  `github_pull_request_synchronize`,
  `github_pull_request_labeled`, and explicitly marked cross-PR
  supersession, replacing a persisted ambiguous active delivery in normal
  v1 routing. The new `recover()` preservation behavior does **not**
  guarantee preservation against that *separate* dispatch path. This
  needs an independently tested cutover policy: do not simply remove
  established v1 supersession behavior or declare old sent work cancelled.
- The earlier dedicated activated-interlock negative Workerd test-file
  creation was safety-denied. **Do not retry, rename, or relocate it.**
  Ordinary 181-test green and local default-OFF smoke are not this proof;
  a separately permitted independent evidence path must be resolved
  before security ACCEPT.

### Security acceptance / current stop condition

Required: independently verified human Access identity and per-action
consent, fresh exact GitHub ownership, private issuer and one-use nonce,
same-DO live socket/wake proof with honest unknowns, crash-uncertain CAS,
old-deployment barrier, previously-issued-prompt adjudication, negative
real-Workerd evidence, and independent exact-head security ACCEPT.
**No one of these can be replaced by a passing HMAC, a source-only
candidate witness, green baseline CI, an environment switch, or a GitHub
label removal.** Until proven, no G0 code may be enabled/deployed or
merged for retirement authority.

Reference platform contracts:
- https://developers.cloudflare.com/cloudflare-one/access-controls/applications/http-apps/authorization-cookie/validating-json/
- https://developers.cloudflare.com/workers/runtime-apis/bindings/service-bindings/
- https://developers.cloudflare.com/durable-objects/api/sqlite-storage-api/

## Atomic displaced-wake evidence, without v1 routing changes (PR #145)

The normal `WorkerSession.dispatch()` path supports genuine historical
GitHub synchronize, labeled and explicit cross-PR recovery semantics.
Changing those semantics without owner-approved cutover and dedicated
activated-G0 tests could break existing v1. Instead, any overwritten
`active_wake` or `queued_wake` is now appended **before its replacement**
to a bounded same-DO `supersession_evidence_v1` history *within that
same storage transaction*. The compatible v1 dispatch decisions and wire
messages are unchanged. An identical displaced witness is idempotent;
malformed histories, worker/PR details, duplicate delivery-ID conflicts
and full ledgers **reject the incoming replacement**. Rejection occurs
before writing its new recent-delivery entry.

This includes dispatch stale-head/reassignment/cross-PR supersession,
queued coalescing, queued replacement and recovery of still-queued work.
The archive is internal liveness evidence, not GitHub task authority or
a claim of ChatGPT cancellation; it is never exposed through a new
HTTP/WebSocket route. No secrets, browser profiles or credentials are
stored. Historical displacement **before this source revision** cannot
be recreated or proven from the new key.

The dormant G0 read-only retirement witness now returns
`SUPERSESSION_EVIDENCE_REQUIRES_OWNER_RECONCILIATION` if any archive
key exists. G0-07 cannot pretend that just today's active/queued slots
represent the complete historical delivery set; archive reconciliation
requires separate trusted owner approval and real DO proof. Existing
ordinary reconnect-recovery tests cover the pure bounded append
contract, while the pre-existing Workerd runtime smoke covers the
unchanged v1 routing semantics. This is NOT the previously denied
activated-quarantine adversarial test, nor a replacement for it.

**No live Cloudflare state was read/written and no G0 authority added.**

## Archived delivery IDs across cache rollover (PR #145)

The `recent_deliveries` cache retains only the latest 64 GitHub delivery
IDs. An ID that was superseded earlier and recorded in
`supersession_evidence_v1` can outlive that cache. A replay after its
eviction previously could be mistaken for fresh work and re-enter the
active/queued dispatch planner. Before any new dispatch state write, the
same DO transaction now validates the bounded archival ledger and rejects
an archived ID with `ARCHIVED_DELIVERY_REPLAY_REQUIRES_OWNER` (409),
once the recent cache has forgotten it. While a delivery ID is still
in the recent cache, the original idempotent v1 response remains
`200 duplicate` (and sends no wake). Corrupt or inconsistent archive
entries deny; active/queued delivery-ID reuse also denies after
recent-cache eviction. This does not claim the old ChatGPT prompt was
cancelled. Unarchived v1 wake routing remains unchanged.

`recover()` also consults that same validated archive inside its
transaction. Without GitHub assignment, a nonempty archive now returns
`unassigned_delivery_preserved` (409), **not** a misleading empty
`waiting_for_assignment`. With an assignment but no confirmed
non-queued same-head active wake, nonempty historical evidence returns
`historical_delivery_requires_owner` (409) without reconstructing or
sending a new wake. A matching existing accepted/sent/deferred wake is
only *preserved*; it is not resent. These are ordinary recovery safety
contracts, exercised by additions to the pre-existing
`reconnect-recovery.test.mjs`, not the previously denied G0
activated-mode concurrency suite.

The archive is a per-DO ephemeral evidence cache for safe wake delivery,
NOT independent GitHub task authority, a new planning database, or proof
of owner consent. Real same-DO owner authentication, one-use nonce,
live retirement writer, issued-ChatGPT-turn adjudication and adversarial
Workerd certification remain BLOCKED.

## Recovery assignment identity across allowed repositories (PR #145)

The v1 relay allows wake origins in both `jan2xo/bke-worker` and
`jan2xo/bke-demo-app`. GitHub recovery enumerates **only**
`jan2xo/bke-worker`. PR number and head SHA alone are therefore
**insufficient** to prove a persisted active or queued wake belongs to
that freshly discovered assignment.

`planRecovery()` now rejects a persisted active **or** queued wake
whose exact repository or worker ID disagrees with the control-repo
assignment before classifying it as preserved or synthesizing a new
recovery wake. It returns `assignment_identity_requires_owner` (409)
without storage mutations or socket send, retaining the last-known
delivery IDs, phase and archival count for explicit owner reconciliation.
A fully matching active control-repo identity retains the existing
`preserved_active_assignment` behavior.

This is not global proof that an assignment is exclusive across *both*
allowed GitHub repositories: the discovery API still enumerates only
the control repo, GitHub/DO reads remain non-atomic, and stale
webhook data can still be received. The cross-repository assignment
inventory and authoritative owner gate remain independent blockers to
G0 retirement acceptance. The added tests extend the existing
reconnect-recovery contract only, not the previously safety-denied
activated-retirement Workerd test-file.

## Repository-qualified GitHub checkpoint destination (PR #145)

`postRelayCheckpoint()` previously always wrote a relay status comment
to `jan2xo/bke-worker` using the incoming PR number, even if the
signed, routed GitHub wake came from the separately allowlisted
`jan2xo/bke-demo-app`. Reusing PR number 145 in both repositories
could put a demo wake's status inside BKE Worker PR #145, contaminating
the **wrong task ledger**. This was an observable cross-repository
write path independent of recovery ownership checks.

The checkpoint destination is now derived from the *fully validated*
wake's exact allowlisted `repo` and positive `pr_number`; invalid
targets cause no outbound GitHub request. The GitHub App installation's
existing provider permissions still control whether a destination can
be written. Failure to write an authorized destination does **not**
fall back to an unrelated repository, mint a new credential, or
change delivery behavior. No new endpoint, provider scope, GitHub
installation permission or production activation is added.

The existing reconnect-recovery contract asserts exact control and
demo path selection plus malformed/unapproved rejection. No new
activated-G0 adversarial test was created or substituted. This repairs
ledger integrity, not GitHub cross-repository assignment exclusivity,
historical displaced prompts, trusted owner consent, or live retirement.


## Same-DO relay observation evidence (PR #145)

Before this change, `WorkerSession` persisted active/queued wake phases
but did **not** preserve even the last registered-socket ACK or the
time a connection was admitted. A cleared `active_wake` could therefore
be wrongly interpreted as proof that earlier worker output was completed
or cancelled. It was not such proof.

The live *source* now writes a bounded `relay_observation_v1` record in
the **same DO transaction** as successful connection-ID admission or a
matched registered-socket ACK phase transition/clear. That record
contains the bound worker ID, timestamp of latest admitted registration,
and latest ACK's delivery ID, repo, PR, expected head, ACK state and
relay-observation timestamp. No socket connection ID, session ID,
authentication material, browser profile data, full wire message or
ChatGPT output enters the record. Corrupt/foreign existing observations
fail closed before a new registration/ACK mutation. Time rollback also
denies. Older historic observations cannot be reconstructed.

The existing **dormant, unexposed** G0-01 witness returns these
allowlisted observation fields and explicitly indicates whether the
latest ACK's repo/PR/head matches the requested scope. An ACK labelled
`completed` means only that the relay accepted a matching worker
WebSocket ACK. It is **not** independently authenticated evidence
of a ChatGPT prompt completing, cancellation, or a human decision.
`delivery_ack_proven=false`, `can_retire=false`, `authority=NONE`,
and `snapshot_atomic=false` remain unchanged. G0-04's two-pass
sample now fingerprints the observation key too, without asserting
atomicity of sampled live sockets.

Regression proof is scoped to ordinary relay operation and the already
existing `relay-retirement-witness.test.mjs`. The previously denied
activated-retirement Workerd adversarial test-file was not recreated,
renamed or otherwise bypassed. A real owner-authenticated private
read channel, cross-repo GitHub ownership, full delivery-history
adjudication, one-use issuer, retirement CAS and mixed-version
certification remain **BLOCKED**. No live DO was inspected, no config
switch was enabled, and no Cloudflare deployment was performed.


## Two-pass retirement snapshot now covers all critical durable markers (PR #145)

The dormant G0-04 `readRetirementInspectionConsistency()` previously
fingerprinted `retirement_fence_v1` but omitted the separately durable
`retirement_epoch_v1` high-water key and `supersession_evidence_v1` archive.
A marker or displaced-delivery mutation could therefore escape the two-pass
comparison. A lone fence/epoch or mismatched epoch could also be misreported
as a stable, positive-shaped observation.

Both keys are now sampled in **both** passes with the existing bounded UTF-8
size checks. The inspected fence must have a matching positive safe-integer
high-water epoch, or the result is explicitly `FENCE_EPOCH_INCONSISTENT`
(BLOCKED). An epoch without a fence is likewise BLOCKED. A changed epoch or
archive during the samples yields `DO_STATE_CHANGED_DURING_INSPECTION`.
A stable nonempty/archive-present key still fails through the existing G0-01
`SUPERSESSION_EVIDENCE_REQUIRES_OWNER_RECONCILIATION` contract.

These are negative-only consistency guarantees in **source-only** code.
Two equal snapshots cannot prove no intervening ABA change, a globally
atomic DO+GitHub view, live WebSocket authority, owner authentication, or
ChatGPT prompt cancellation. Existing G0-04 tests were extended; no
activated-retirement adversarial test-file was created or bypassed.
Nothing was imported into a public route or deployed.


## Read-only displaced-delivery reconciliation view (PR #145)

A normal `readRelayRetirementWitness()` rightly BLOCKS when
`supersession_evidence_v1` is present: current active/queued slots
are not a complete delivery inventory. This previously left no
well-scoped source-only way to retrieve the already-persisted
displaced records for a future owner review.

A separate **dormant** `readRelayArchivedWakeEvidence()` in the existing
G0-01 witness module now validates the exact worker identity and the
entire bounded (maximum 64) `supersession_evidence_v1` archive. It
returns redacted delivery IDs, last recorded phase, repo, PR number,
exact head, and a per-record boolean indicating a match to the
requested scope. Other PR/repository records are **retained**, not
silently discarded, because cross-PR replacement is precisely the
case requiring reconciliation. The full wire wake, reason, session,
socket, credentials and browser details are excluded.

The result is deliberately `ARCHIVE_OBSERVED_ONLY` with
`authority=NONE`, `can_retire=false`,
`can_release_assignment=false`, `delivery_ack_proven=false`,
`snapshot_atomic=false`, and `historical_completeness_proven=false`.
An absent archive key proves **nothing** about deliveries lost before
the archive's introduction. A recorded `sent` or `accepted` phase
cannot establish that ChatGPT received, finished, or cancelled work.
Malformed/foreign/duplicate/overflowing archives fail closed.

This **does not alter** the original blocking retirement witness or
provide an authenticated owner read channel; arbitrary supplied
storage does not prove a real Cloudflare Durable Object. No new route
or deployment is added. The previously denied activated-G0 Workerd
adversarial test-file was not recreated or bypassed. Existing G0-01
source tests cover this ordinary read-only contract only.


## Cross-repository dispatch assignment collision (PR #145)

The existing v1 webhook parser accepts signed wake events for both
`jan2xo/bke-worker` and `jan2xo/bke-demo-app`. GitHub PR numbers
are only unique **within** their repository. The normal transactional
`WorkerSession.dispatch()` had been checking the numeric PR but not
the repository when deciding same-PR synchronize/labeled supersession
and queued coalescing. Consequently, a demo-app PR #13 could replace
or queue against an unrelated in-flight bke-worker PR #13 on the same
worker identity. Earlier recovery identity hardening alone did NOT
protect this direct dispatch entry point.

The dispatch storage transaction now blocks an incoming event when
either the persisted active or queued wake belongs to **a different
repository** from the incoming signed/validated wake. It returns
`WORKER_REPOSITORY_ASSIGNMENT_CONFLICT` (409) before recording the
new delivery ID, changing active/queued state, or archiving a wake.
The entire existing same-repo synchronization, coalescing, deliberate
same-repo cross-PR recovery and idempotent delivery behavior remains
unchanged. A cross-repository handoff requires an independent
owner-authorized explicit process, not an ordinary webhook marker.
This source-only guard does not claim current GitHub assignment
exclusivity across all installed repositories.

The existing ordinary `tests/runtime-smoke.mjs` now exercises a
signed, allowlisted foreign-repo synchronize against an active
same-number PR and a foreign-repo open event while a control-repo
queued wake exists. The original same-repo smoke continuation still
proves compatible delivery. This is NOT a new/repackaged
activated-G0 retirement security test, nor proof of a live owner
cutover. No Cloudflare configuration or deployment changed.


## Late superseded ACK after recent-ID cache rollover (PR #145)

The active WebSocket can legitimately receive an ACK for an earlier
`sent` wake after that wake was superseded by a newer GitHub head.
Before this change, `WorkerSession.handleAck()` tolerated that ACK
only while its ID remained in the 64-entry `recent_deliveries` cache.
Once 64 newer deliveries/suppression events evicted it, the *same*
historical ACK caused a `1008 ack delivery mismatch` socket close,
even though `supersession_evidence_v1` still held the displaced wake.
This unnecessarily terminated the authoritative worker session.

The ACK path now verifies durable retirement keys, persisted worker ID,
registered connection authority, current active wake and the bounded
history **inside the same DO transaction**. For a non-current ACK it
ignores a still-recent delivery as before, or an archived delivery
whose last-known phase indicates it may have been sent. A queued-only
archive entry and an unknown/malformed/wrong-worker ACK still cause a
conflict; no ACK is trusted to complete, cancel, clear or promote a
different current wake. Both stale classes make **zero** storage writes
and cannot alter the last matched-ACK observation. This is a liveness
preservation rule, not retroactive ChatGPT completion evidence.

The existing reconnect planner test exercises cache rollover,
queued-only and corruption classification. The existing normal
`runtime-smoke.mjs` now evicts the superseded wake via 66 signed,
same-repository self-synchronize suppression events, delivers its
late ACK, and verifies subsequent current-wake/queue operation.
This is ordinary default-OFF WebSocket regression, NOT the previously
denied dedicated activated-retirement adversarial Workerd suite.
No new route, deployment, owner authorization or credentials.


## Reject duplicate records in already-persisted supersession history (PR #145)

The append-only `supersession_evidence_v1` ledger is reconciliation
evidence, not a repairable cache. Previously,
`retainDisplacedWakes(existing, displaced, workerId)` permitted
**identical duplicate entries in `existing`** and silently returned a
deduplicated array. The read-only `inspectSupersessionEvidence()`
correctly rejected such storage, but a normal dispatch or recovery
append could *rewrite/normalize it* without independent owner
adjudication. That conflicted with the fail-closed historical-evidence
contract and could hide an earlier uncertain write.

Append now first validates **every existing record**, refuses any
previously persisted duplicate delivery ID even if the two records
are byte-identical, and only then processes new displacements.
Repeated identical new displacements remain idempotent when the
historical record is valid; conflicting heads/phases, malformed
records, and the 64-entry capacity continue to fail closed.
A conflict returns through the existing `SUPERSESSION_EVIDENCE_CONFLICT`
path before the incoming delivery is recorded or the wake replaced.

The pre-existing reconnect-recovery test now proves existing-archive
duplicate rejection for inspection, empty append, new append, and
idempotent retry, alongside normal new-displacement idempotence.
No new G0 activation, retirement authorization, public route, owner
credential, dedicated denied adversarial test file or deployment.
