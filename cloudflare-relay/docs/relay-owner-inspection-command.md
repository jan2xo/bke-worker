# G0-05 — dormant signed inspection-command verification (source only)

**Parent authority:** [BKE Worker #135](https://github.com/jan2xo/bke-worker/issues/135). Prerequisite dormant merged source layers #136–#139. **Source base:** `639d2cda331665fe6b4f28ff27e9e237ab6d0df6`.

## Problem

The earlier read-only same-DO witnesses are necessary, but no current BKE Worker endpoint authenticates a human operator before invoking them. A browser-supplied `owner=true`, fake Access header, worker ID or GitHub PR description cannot authorize inspection. [Command Center #30](https://github.com/jan2xo/bke-command-center/issues/30) already defines human-Admin Cloudflare Access verification and narrowly scoped service bindings. Its [`src/admin-access.js`](https://github.com/jan2xo/bke-command-center/blob/e1bb68d5f91a40ea6e0e34063db160bc3f155760/src/admin-access.js) validates the platform `ctx.access`, audience and allowlisted Admin email. That identity context is NOT forwarded automatically through a Cloudflare service binding.

## One independent source-only intent

Introduce **a dormant verifier** for a short-lived, exact-target, purpose-bound HMAC inspection-command envelope, with a **distinct future-only key** and default-OFF `BKE_G0_OWNER_INSPECTION_ENABLED`. Verification binds purpose, exact `worker_id/repo/PR/head`, 256-bit nonce and 30-second issuance/expiry window. It is strictly read-only: no socket/DO access, persistence, public route, service binding, GitHub mutation, token issuance, or wake delivery.

This is a *cryptographically authenticated command format only*. It does NOT prove that the human owner signed in, actively consented, or that the command originated from a correct server/DO identity. A trusted future Command Center signer MUST independently validate the live human Cloudflare Access identity and GitHub assignment, then sign the exact server-derived command over a **dedicated** secret inaccessible to the browser. A future WorkerSession-only receiver MUST independently revalidate assignment, exact target and generation, replay/nonces, and actual DO provenance before running G0-04. The verifier is NOT an authorization endpoint and never yields `can_inspect=true` or `can_retire=true`.

**Trust-chain sketch (all future integrations locked):**

1. Owner signs in through Command Center with platform-verified Cloudflare Access; issuer/AUD/Admin allowlist pass, plus per-action human consent (not supplied by request JSON).
2. Server independently re-reads trusted GitHub App assignment and exact head, derives canonical worker ID/repo/PR/head. No trust in user-supplied PR identifiers.
3. Server signs the purpose-specific nonce-bound command using a dedicated isolated HMAC key, via an explicitly reviewed **private** same-account service binding; no public signer method.
4. A separately certified internal WorkerSession implementation verifies the envelope and one-use nonce, **proves** the `v2:<worker_id>` DO identity via the actual namespace, and invokes G0-04 against `this.ctx.storage` and `this.ctx.getWebSockets`. A valid HMAC alone is not an authorization decision and does not remove replay ambiguity.
5. Retirement commit/epoch, all-route fence enforcement, owner-action authorization, credential revocation and GitHub label release are separate security intents and blocked live actions.

## Source contract

- Only the exact versioned request schema (target + purpose + nonce + issue/expiry + signature) is accepted; incorrect types, unknown extra keys or client "Admin" booleans are denied.
- The HMAC secret must be *distinct* from GitHub App, relay, pairing and device secrets and be exact 32-byte canonical base64url; absent or malformed env config fails closed.
- Only PREPRODUCTION-shaped, explicit default-OFF feature flags are permitted. No flag/config/secret is added to Wrangler in this PR.
- Signature comparison uses Web Crypto `subtle.verify`; fixed-domain canonical message and encoded UTF-8. Never export secret or raw signature in response.
- Every response states `authority:'NONE'`, `human_owner_authenticated:false`, `same_do_verified:false`, `nonce_consumed:false`, `read_permitted:false`, `can_retire:false` and `can_release_assignment:false`. A valid command is `COMMAND_SIGNATURE_VERIFIED_ONLY`, not authorization.
- Read-only verification does not consume a nonce, establish a CAS lock, or prove replay protection. A future owner-only routing implementation MUST add one-use durable challenge/nonce and fail closed on races/retries.
- No pairing/registration, dispatch, recovery, ACK, WebSocket, Cloudflare deployment, live state, credentials, labels or secrets are changed.

## Certification

Cheap PR Guard + deliberate exact-head `/certify relay` (Node security tests, relay cross-boundary compatibility and local smoke). Independent review **ACCEPT** required before source-only SHA-locked merge. Live owner-access verification, signed-command issuance, named service-binding wiring, same-DO inspection, actual serialized tombstone, and human PREPRODUCTION execution are all **NOT CERTIFIED** here and require new authorized intents.

This is a necessary step towards the G0 owner-only read gate, not a substitute for that gate. Keep [PR #90](https://github.com/jan2xo/bke-worker/pull/90) quarantined under `bke-worker:android-worker-a`; do not reconnect or reuse the old worker identity.
