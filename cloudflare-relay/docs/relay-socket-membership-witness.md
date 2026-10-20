# G0-02 — dormant Durable Object socket-membership witness

**Parent:** [BKE Worker #135](https://github.com/jan2xo/bke-worker/issues/135). **Earlier source-only dependency:** merged [PR #136](https://github.com/jan2xo/bke-worker/pull/136). **Historical unresolved assignment:** Android [PR #90](https://github.com/jan2xo/bke-worker/pull/90) and old `android-worker-a` queued wake.

## Bounded source intent

`readRelaySocketMembershipWitness(deps, expected)` composes the existing strict read-only G0-01 persisted-state witness with a **sample** of `ctx.getWebSockets()` and the **persisted** `active_connection_id`.

This module is deliberately **unimported from `src/index.js`**. It adds no route, admin authentication, connection handler, cron, Cloudflare binding, deployment, secret, dispatch, cancellation, retirement or GitHub label change. It is test-only source until a separately authorized owner-verified private operator interface exists.

A future integrator MUST supply `deps.storage = this.ctx.storage` and `deps.getWebSockets = () => this.ctx.getWebSockets()` from the **same actual WorkerSession Durable Object instance**. The injected dependencies are NOT trusted just because they are syntactically accepted; this module does NOT verify caller/host provenance, Cloudflare Access, the human owner or device identity. Never build those dependencies from HTTP headers, WebSocket/device/browser/ChatGPT content or client-controlled flags.

## Evidence contract and negative gates

- The G0-01 witness must first validate persisted worker identity, exact server-bound repo/PR/head and complete active/queued wake schemas. Any prior BLOCKED condition propagates.
- The membership sampler reads the persisted connection ID, samples `ctx.getWebSockets()`, then rereads the persisted ID and rejects obvious mismatch. **This is NOT a transaction or atomic snapshot**, and it cannot eliminate ABA/close-after-check races.
- Each attachment must follow the existing live WorkerSession `workerId,connectionId,registered,sessionId` structure. Missing, invalid, wrong-worker, extra, undecodable and conflicting attachments block. An unregistered WebSocket has `registered=false` and `sessionId=null` and does not count as an authoritative registered socket.
- More than one registered socket with the same stored ID fails closed; a registered socket with a different/missing stored authoritative ID fails closed. A stored connection ID with *no matching socket* is allowed as redacted diagnostic evidence because it could be stale, but it **never** permits clearing/retirement.
- Output `registered_socket_id_match_observed=true` means a socket object with matching registered attachment was **observed during this inspection only**. It is **not** proof of a currently live, connected, authenticated or authorized ChatGPT target; matching still does not prove delivery or ACK. No ID, session, cookie, bearer, target content or socket object is returned.
- Every result remains `authority=NONE`, `can_retire=false`, `delivery_ack_proven=false`, `delivery_fenced=false`. A missing persisted queue/ID, no observed socket or a matching one does NOT authorize replay, GitHub unlabeling, credential revocation or identity reuse.

## Next dependencies — not fulfilled by this PR

1. Authenticated human-Admin-only read path into the **actual PREPRODUCTION** DO, with owner-approved identity/PR/head binding, verified private transport and redacted audit checkpoint. This dormant helper is NOT deployed or executable against real DO data from here.
2. An independently reviewed **atomic retirement fence/tombstone/epoch** inside actual DO handling, mandatory for connect/register/dispatch/recover/send/ACK/queue promotion, including stale/ambiguous socket/credential rejection and race/rollback tests.
3. Owner-approved live PREPRODUCTION activation/retirement, post-fence readback, secret revocation and only then GitHub assignment reconciliation. `android-worker-a` stays quarantined until independently proven safe; no replacement pairing under that old identity.
4. After the safety gate: [Command Center #30](https://github.com/jan2xo/bke-command-center/issues/30) device-bound one-time enrollment, automatic WSS provisioning and short-lived credential renewal; isolated FORGE F1/CODE REVIEW C1 tabs later.

Source acceptance: Node syntax and adversarial tests, minimum complete exact-head `relay` certification, independent review and SHA-locked source-only merge if authorized. **No production/PREPRODUCTION rollout, Android reinstall or manual WSS/configuration requested.**
