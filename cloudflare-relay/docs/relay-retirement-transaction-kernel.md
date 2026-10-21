# G0-07 — dormant transactional retirement-fence kernel (SOURCE ONLY)

Parent: [BKE Worker G0 Issue #135](https://github.com/jan2xo/bke-worker/issues/135). Based on Worker `main=40d55c87b5e1910e7c496308417e3f8a6da6dba2`, after default-off G0-06 PR #141.

## Intent

Build a *bounded, unimported* testable transaction kernel for a permanent, monotonically guarded retirement tombstone. G0-01..G0-06 provide negative-only stored delivery, socket, fence, sampled consistency and signed inspection contracts, but **do not** implement atomic persistent retirement. This kernel explores one precise transactional write and identical readback model; it is **NOT** an authorized retirement entrypoint.

Files: `src/relay-retirement-transaction-kernel.js` and adversarial Node tests. `src/index.js`, `wrangler.toml`, worker routes, registration/ACK/dispatch/recovery/promote and credentials remain untouched. The module **must not be imported or invoked on a real DO** until separate independently approved owner-access, action consent, GitHub source-of-truth head/label, scoped private service principal and one-use nonce checks are established *AND* all relay entrypoints enforce the retired fence transactionally. A JavaScript argument, signed inspection command or synthetic storage transaction cannot grant that authority.

## Contract

- Reject any request with extra `authenticated`, `owner_approved`, privilege, or unknown fields. Input has exact validated `target` (worker, allowed repo, PR, head), `retirement_id`, `created_at_ms` and a sorted deduplicated list of **all currently observed active/queued delivery IDs** (1–2).
- A `storage.transaction(callback)` interface is **required**. Never fall back to independent `storage.put` writes; both the immutable G0-03 `retirement_fence_v1` record and new `retirement_epoch_v1` high-water value are staged inside the **same transaction**. Initial epoch is exactly 1.
- Check G0-01 persisted worker and wake witness **inside the transaction**, demand nonempty exact delivery-set equality and refuse malformed, foreign-PR/head, missing worker, extra active phase fields or stored `active_connection_id`. A missing connection ID does not prove the absence of all live sockets; the negative field remains false.
- Once a paired fence/epoch exists, **never rewrite or increment** it. An identical decision returns a redacted existing-record observation; a different target/decision, missing half, malformed record, changed/rolled-back epoch or high-water without a fence fails closed. An un-fenced epoch cannot be reset to zero.
- Following a reported successful transaction, perform exact fence/epoch readback. Any mismatched/missing/error response fails closed. An exception from `transaction()` may happen after commit: return **TRANSACTION_OUTCOME_UNCERTAIN**, never infer rollback; later exact retry is idempotent.
- Every response explicitly sets `authority:NONE`, `can_retire:false`, `delivery_fenced:false`, `all_paths_fenced:false`, `atomic_commit_proven:false`, `can_release_assignment:false`, `credential_revocation_proven:false`, `same_do_provenance_verified:false`. A test transaction is **not** proof of actual Cloudflare SQL DO serialization or absence of concurrent dispatch, and matching readback does not certify a runtime gate. Outputs contain no delivery IDs, socket IDs, credential, nonce or raw persisted record.

## Required adversarial proof

Tests cover first write with both keys, exactly idempotent retry, different decisions/targets, malformed/missing fence high-water, absent/conflicting wake state, persisted connection-ID, exact active+queued delivery ID set, injected privilege fields, transaction absence, rollback on partial write, crash after commit then safe retry, lost or mismatched readback, concurrent competing decisions and no runtime import. Deliberate required CI: automatic PR Guard + `/certify relay` exact head.

## Remaining gates (not implemented here)

The actual human owner Admin Access + signed per-action consent and a verified private Command Center service identity must select authoritative target, one-use nonce and fresh GitHub assignment/head from trusted boundaries. A separate integration must enforce one monotonic fence on **every** connect/register/dispatch/recover/send/ACK/promote/socket close/error path with serialization, including crash/replay race cases and existing open sockets. Only then can a human explicitly authorize **scoped PREPRODUCTION** DO retirement and independently inspect readback; credential revocation and GitHub label release remain later owner-only actions.

Parent #135 stays OPEN/LIVE BLOCKED. Historical PR #90 and `bke-worker:android-worker-a` remain OPEN and quarantined. No old wake replay/rearm, Android reinstall, WSS, Cloudflare config/secret, deployment, ChatGPT auth, live DO invocation or assignment label mutation is authorized.
