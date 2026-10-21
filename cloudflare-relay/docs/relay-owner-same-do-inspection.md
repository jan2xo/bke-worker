# G0-06 — default-OFF WorkerSession same-DO inspection candidate

**Parent:** [BKE Worker #135](https://github.com/jan2xo/bke-worker/issues/135). **Base:** `aa11f83defa9c6cbfd8bbc3e353a90da76897804`. **Prerequisites:** dormant G0-01 through G0-05 merged source contracts.

## Intent and precise security limit

The prior G0-04 helper accepted abstract `{storage,getWebSockets}` dependencies. That interface cannot itself establish Cloudflare Durable Object provenance; a client-supplied callback is never credible peer attestation. G0-06 adds a new `WorkerSession.inspectRetirementCandidate(command)` receiver to the actual existing Durable Object class, which passes only `this.ctx.storage` and `this.ctx.getWebSockets`. It deliberately creates **no public HTTP, WebSocket, relay, owner-login, or credential endpoint** and changes no existing fetch or socket route.

The internal receiver module derives the expected exact `worker_id/repo/pr_number/expected_head_sha` from the DO's **stored worker identity and stored wake(s)**, rather than accepting caller-supplied `expected` ownership. Ambiguous or malformed wake identity, different active and queued PR/head, absent wakes, unexpected state changes across the inspection window and underlying G0-04 witness/socket failures all deny. It verifies the G0-05 HMAC envelope against this server-derived candidate, samples G0-04, then requires post-sample exact state equality. Output deliberately exposes only redacted booleans and GitHub target identifiers, no connection IDs, access secrets, nonce, raw socket or command.

**This is still NOT an authenticated Admin inspector.** The default-off `BKE_G0_SAME_DO_RECEIVER_ENABLED` and G0-05 flags must both be explicitly enabled before any read. These are **not defined in Wrangler**, no key is provisioned, and nothing in this PR enables them. The HMAC is only a signature-shape proof and may be replayed: even a `INSPECTION_CANDIDATE_ONLY` return has `authority: NONE`, `human_owner_authenticated: false`, `read_permitted: false`, `same_do_verified: false`, `nonce_consumed: false`, `can_retire: false`, `can_release_assignment: false`, `delivery_fenced: false`. An isolated test double cannot certify actual deployment provenance. **Do not enable the flags using only this PR.**

A later separate source/security intent must establish a private, installation-scoped Cloudflare service binding from Command Center with platform-verified Admin Access and per-action consent, exact fresh GitHub assignment/head evidence, a dedicated server-only signer, one-use nonce/replay fencing in the actual same DO, and independently authenticated receiver identity. Only then can owner-authorized read acceptance be performed in PREPRODUCTION. Retirement/tombstone epoch enforcement across connect/register/dispatch/recovery/send/ACK/promote and credential/label release are **additional independent gates**.

## Reviewable proof

- Real `WorkerSession` receiver calls the helper using only `this.ctx` dependencies, and there is no new public route or Wrangler registration.
- Signed worker/repo/PR/head mismatch, fake Admin flags, wrong key, expiry and absent/ambiguous stored wake are denied before observation.
- State changing during inspection, socket membership ambiguity, malformed/oversized UTF-8 wake state and storage/crypto exceptions fail closed.
- Test assertions enforce no write/delete/transaction, no socket send, no secrets in output, replay protection and all authority gates false.
- Cheap automatic PR Guard plus deliberate `/certify relay` at exact head; BRO-KODE independent security review and explicit owner-authorized SHA-locked source merge required.

**Never** claim live DO provenance, owner authentication, replay protection or live retirement from these source tests. Historic [PR #90](https://github.com/jan2xo/bke-worker/pull/90) remains OPEN/DRAFT with `bke-worker:android-worker-a` quarantined and old ambiguous wake. Do not rearm, retry, reconnect, revoke, release the label or deploy.
