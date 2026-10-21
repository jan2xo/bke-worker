# G0-04 — dormant same-DO inspection consistency contract

**Parent:** [Worker #135](https://github.com/jan2xo/bke-worker/issues/135). Predecessors: source-only [#136](https://github.com/jan2xo/bke-worker/pull/136), [#137](https://github.com/jan2xo/bke-worker/pull/137), [#138](https://github.com/jan2xo/bke-worker/pull/138).

## One bounded source-only intent

Build a strict, read-only **two-pass change detector** around the existing G0-01 persisted-wake and G0-02 sampled-socket witnesses, with G0-03 tombstone schema and exact-target inspection. The new helper is never imported by the live `src/index.js`, does not create a route, service binding, authentication verifier, Durable Object mutation, new worker identity or automatic GitHub operation.

It takes a strict exact target (`worker_id`, permitted `repo`, positive `pr_number`, exact 40-character SHA), and two dependencies that **future trusted WorkerSession-only code** must derive from the same DO: `ctx.storage` and `ctx.getWebSockets.bind(ctx)`. It performs bounded JSON snapshots of the known persisted state keys before and after invoking G0-02. Changed state, malformed retirement records, wrong target, duplicate sockets, faulty getters, or non-JSON/oversized state must fail closed. Results never expose private socket connection IDs, session IDs, credentials or stored JSON.

Even a successful two-pass equality is **not atomic** and cannot prove absence of in-flight dispatch, current WebSocket liveness, authoritative owner authentication, real fence commitment, cancellation, delivery ACK, revocation or safe GitHub label release. A valid-shaped tombstone may be a mere candidate; schema equality never establishes trusted persistence provenance.

## Further dependencies / activation locks

1. Privately authenticate the **actual human owner** through a dedicated, narrowly scoped service-binding capability, not a caller-supplied boolean, bearer string, mocked callback or unverified request field.
2. Derive canonical GitHub worker/PR/head assignment server-side and select **the actual authoritative named WorkerSession DO** on its existing generation/identity.
3. Bind this witness to the same DO only after independent review of that trust path. Avoid public HTTP routes, ambient admin tokens, browser or WSS inspection endpoints; require a genuinely private owner-only read channel.
4. Implement separately reviewed serialized atomic fence/tombstone transitions across ALL relay state and socket delivery paths. Human approval is needed before any actual PREPRODUCTION retirement/credential action.
5. Read back the committed fence with trusted DO provenance before authorizing any GitHub assignment reconciliation. Never reuse `android-worker-a` for F1/C1.

## Certification plan

Automatic PR Guard and deliberate `/certify relay` at exact head, including the relay-owned Android cross-boundary test and local smoke. Independent source security review before any SHA-locked **source-only** merge. No Android rebuild, client reinstallation, manual WSS/token entry, Cloudflare deployment or production action.
