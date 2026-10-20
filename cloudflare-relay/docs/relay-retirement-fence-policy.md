# G0-03 — dormant retirement tombstone and negative-only fence contract

**Parent:** [Worker #135](https://github.com/jan2xo/bke-worker/issues/135). Previous source-only layers: merged [G0-01 PR #136](https://github.com/jan2xo/bke-worker/pull/136) (persisted-state witness), [G0-02 PR #137](https://github.com/jan2xo/bke-worker/pull/137) (sampled socket membership). Old assignment [PR #90](https://github.com/jan2xo/bke-worker/pull/90) still has `bke-worker:android-worker-a`, and old queued delivery is NOT cancelled or certified completed.

## Exact scope: source-only, unimported, and deliberately not a working retirement control

`relay-retirement-fence-policy.js` exposes three pure functions/values:

- `validateRetirementTarget(target)`: exact server-side worker ID, allowed repo, PR number and exact-head SHA checks.
- `proposeRetirementTombstone(request)`: emits an immutable **non-authoritative CANDIDATE** tombstone `retirement_fence_v1`, refusing malformed requests, extra client-supplied privilege/approval fields, mismatched existing records, and repeated attempted retirement. **`PROPOSAL_ONLY` is not a write, atomic CAS, owner approval or authority to commit.** A proposed epoch=1 is a placeholder; a real fenced epoch/generation must be selected and committed serially by the same DO.
- `inspectRetirementOperation(persistedFence, target, operation)`: a deliberately **negative-only** gate over connect, register, dispatch, recover, send, ACK, queue promotion, socket close and error. A valid retired target is DENIED; unknown operation, missing or malformed fence, wrong worker/repo/PR/head are also DENIED. The absent-fence result does **not** authorize legacy unfenced traffic; this function cannot be used alone as a runtime routing allowlist.

**Every result** exposes explicit `authority='NONE'`, `can_commit=false`, `can_dispatch=false`, `can_reconnect=false`, `can_release_assignment=false`, `can_reuse_worker_id=false`, `delivery_ack_proven=false`, `delivery_fenced=false`, `atomic_commit_proven=false`, `credential_revocation_proven=false`. Merely modeling a valid tombstone cannot establish real deployment, an atomic write, a durable fence or a completed ChatGPT turn. No secrets/cookies/session IDs are accepted or produced.

The module is **NOT imported by `src/index.js`**, not referenced from a public URL, does not call any DO storage writes or WebSocket operations, and has no new Cloudflare flag/route, authentication or production capability.

## Remaining separate owner-gated and security-reviewed implementation work

A safe real PREPRODUCTION retirement workflow requires all of the following before the historical Android identity can be released:

1. An authenticated, privileged internal owner-only inspection path into the **actual exact WorkerSession DO**, deriving worker/repo/PR/SHA context from trusted server-side GitHub/owner inventory. The existing G0-01/02 helpers are source-only and cannot independently prove any live state, owner authentication or socket/ChatGPT liveness.
2. Explicit scoped human owner consent for the particular old worker, PR/head and queued delivery. The user saying GO authorizes routine engineering, **not** credential revocation, live durable-state mutation, PREPRODUCTION deployment, owner-only security cutover or forced relabeling.
3. Revalidate the actual DO state **inside serialized atomic storage operations**, ensuring no alternate owner, duplicate socket, stale epoch or uncertain in-flight event. Persist a **monotonic** tombstone under `retirement_fence_v1` and verify committed readback with trusted DO provenance. No read-only witness or in-memory policy can by itself provide an atomic CAS/linearization point.
4. Before activation, integrate the fence with **every** WorkerSession entry/transition: `fetch`/connect/dispatch/recover, WebSocket register/ACK, `sendActiveIfSafe`, `promoteQueuedWake`, socket-close/error, and any replay/re-enrollment path. Check fencing in the **same serialized transition boundary as sends/queue writes**. Prevent reconnect and newly registered stale clients even when they hold legacy tokens. Handle at-least-once delivery, stale sockets, out-of-order requests, ambiguous send/ACK, interrupted commits, repeated cancellation and concurrent revisions.
5. After independently verified active fence, explicitly owner-approved revocation/rotation of old credentials, and only then release the old GitHub `bke-worker:android-worker-a` label with a durable exact-head checkpoint. **Do not reuse the legacy worker ID for F1/C1**; provision unique, isolated, device-scoped enrollments. Never uninstall/reinstall old APKs to “prove” a cancelled queued wake.
6. Run the minimum complete declared exact-head graph and independent security review on every activating PR. Live PREPRODUCTION tests/deployment are separately authorized and cannot be inferred from source-only CI.

## Adversarial source tests

Tests exercise strict target/tombstone keys, invalid protocol/generation/worker/repo/PR/head, repeated or wrong-target proposals, fake approval/privilege keys, denied missing fence/unknown route, nine retired-worker action gates, immutable proposals, and explicit negative proof values. CI `/certify relay` validates syntax and the existing relay smoke while leaving actual WebSocket/DO runtime unchanged.

**Product goal beyond G0:** Command Center #30 one-time human enrollment with automatic private WSS setup, device-scoped credential rotation, and later separate FORGE F1 and CODE REVIEW C1 tabs. No recurring manual WSS/token entry requested from the owner.
