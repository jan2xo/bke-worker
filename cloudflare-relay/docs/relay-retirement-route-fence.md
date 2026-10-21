# G0-08 — Dormant negative-only route-fence observer

**Parent:** [G0 lifecycle Issue #135](https://github.com/jan2xo/bke-worker/issues/135). **Source base:** `bke-worker@9085720fb6029c4cf532f9157c9671df0cd2bf39` (G0-01 through G0-07 merged).

## Purpose, authority and isolation

The G0-07 transaction kernel stages a candidate `retirement_fence_v1` + `retirement_epoch_v1` pair but cannot prove a live routing fence. G0-08 provides an **UNIMPORTED, read-only, negative-only** route-observation contract and an auditable inventory of the nine current `WorkerSession` operation seams. It **does not** change `src/index.js`, `wrangler.toml`, WebSocket registration, dispatch, ACK or recovery.

**Do not wire this helper into live paths as an allowlist.** No result authorizes a connect, wake, ACK, retry, assignment release or worker-ID reuse. A matching retired fence yields `RETIRED_BLOCKED`, with `authority:NONE`, `delivery_fenced:false`, `all_paths_fenced:false`, `atomic_commit_proven:false` and all privilege booleans false. A missing, damaged or mismatched pair produces `BLOCKED`, **never** `ALLOWED`. The transaction-shaped storage dependency is untrusted; a local test double does not establish actual Cloudflare Durable Object serialization, same-DO identity, owner consent or GitHub ownership.

## Contract

The exported `inspectDormantRetirementRouteFence(storage,{target,operation})`:

1. Synchronously copies and validates an exact plain `worker_id/repo/pr_number/expected_head_sha` target and one of the nine literal G0-03 `FENCED_OPERATIONS`. Unknown or extra privilege fields fail before any state reads. The canonical object is frozen before any await to defeat mutable-input time-of-check/time-of-use attacks.
2. Requires an injected `storage.transaction(callback)`; no nontransactional fallback. Reads `worker_id`, `retirement_fence_v1` and `retirement_epoch_v1` through the transaction handle, not external `storage.get`. No `put/delete/socket/send` is ever called.
3. Blocks persisted worker conflicts; absent fence+epoch; missing/corrupt, invalid or downgraded paired keys; mismatched worker, repo, PR or head; and transaction errors or invalid callback results. Both keys externally erased remains **undetectable from a never-retired DO**, and this function intentionally does not infer safety from absence.
4. Returns an immutable, redacted denial/result with all authority fields false. It never returns the stored fence record, retirement ID, websocket attachment, delivery ID, bearer, nonce or secret.

The seam inventory is `connect`, `register`, `dispatch`, `recover`, `send`, `ack`, `promote`, `socket-close`, `socket-error`. Tests verify all nine markers remain recognizable in `src/index.js`. In addition, **`ensureIdentity()` mutates stored identity before routing** and must be gated before its first write in any future live integration. Merely inserting checks into the nine handlers would be insufficient; the outer `WorkerSession.fetch` and WebSocket event sequencing, existing sockets, in-flight methods, transaction interleavings and registration-to-send race all require independent proof before enabling actual retirement.

## Exact-head adversarial certification

- Valid paired fence/epoch for each of the nine operations returns `RETIRED_BLOCKED` while never permitting action.
- Missing, partial, malformed, stale or contradictory pair; wrong worker/PR/head; forged privileges and unknown operations all deny.
- Transaction absent/broken, injected callback result and storage error are redacted and fail closed.
- Delayed-read target mutation after function entry cannot alter the canonical target/operation. Foreign initial target cannot be mutated into authority.
- Source inventory verifies no accidental `index.js` import, no Wrangler feature flag or runtime route.
- Required CI: cheap PR Guard + deliberate `/certify relay` at **exact PR head**. Android APK, production, live Cloudflare DO changes and actual browser/device are not required.

## Separately locked future work

Before any real G0-07 writer or G0-08 observer may gate active runtime, the operator must separately authorize authenticated owner Access and per-action consent, verified Command Center private service principal and nonce issuance/one-use consumption, live same-DO provenance, trusted GitHub assignment/head, truly atomic **all-path** enforcement (including `ensureIdentity()`), crash/race and previously connected sockets, fenced readback, and credential and label release gates. Tests in this source PR are not evidence that any of those have been achieved. Do not enable PREPRODUCTION or production flags, deploy, modify credentials or revivify quarantined Android [PR #90](https://github.com/jan2xo/bke-worker/pull/90) / `bke-worker:android-worker-a`.

**Issue #135 remains OPEN / LIVE RETIREMENT BLOCKED** until independently reviewed exact owner scope and explicit operator authorization establish genuine live safety.
