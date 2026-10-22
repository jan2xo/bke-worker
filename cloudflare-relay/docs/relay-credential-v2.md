# C3-01 — GeckoView relay credential v2 cryptographic evidence (source only)

**Parent:** BKE Worker #133, program #121/C3; Command Center #30. This addition is an **unimported module**, not a WSS handler, Cloudflare deployment, key rotation, enrollment broker, Android runtime change, or second task database. Existing v1 `src/protocol.js`, `src/index.js`, `wrangler.toml`, and deployed `BKE_WORKER_RELAY_TOKEN_KEY` are unchanged. Android PR #90's assigned session/queued wake must not be touched or replayed.

## Versioned device-scoped cryptographic contract

- Strict v2 lease envelope `{lease,tag}` with canonical, domain-separated HMAC-SHA256 verified by a **server-only** epoch key. The signed lease binds installation ID, worker ID, independently pinned P-256 device public-key SHA256, Gecko session-binding SHA256, explicit epoch, unpredictable 128-bit token ID, and a maximum 5-minute lifetime. The caller must supply expected epoch/installation/session and device JWK from an **independently verified server-held paired-device record**; device-provided claims never grant trust.
- Per-presentation P-256 proof signs a distinct domain with one 256-bit server nonce, `GET /relay/<worker-id>`, token ID and lease MAC. Verification rejects scope, epoch, time, canonical-encoding, MAC, signature and key mismatch.
- **A valid signed proof remains replayable until a trusted Durable Object atomically consumes its nonce.** Therefore the function always returns only `CRYPTO_VERIFIED_ONLY`, `authority=NONE`, `nonce_authority=NOT_CHECKED`, and **no** relay connection/renewal/admission privilege. Do not interpret this result as authorization; even a repeated identical proof can produce crypto-only success.
- The module does **not issue** credentials, establish Android identity, persist secret material, rotate epochs, import into runtime, or expose any HTTP/Cloudflare route.

## Follow-on independent, owner-gated work (NOT part of this PR)

1. Human-approved Command Center initial pairing, verified Android OS/Gecko-native peer attestation, device-held nonexportable P-256 identity, and server-private enrollment/pin/revocation record. Coordinate with FORGE Command Center #60 / PR #61.
2. Authenticated **server-only credential issuance/renewal**, current/next key epoch selection, safe limited overlap/revocation and explicit loss/reinstall recovery. Never rotate the live v1 master key and strand a currently attached Android session without controlled acceptance.
3. Cloudflare DO **server-issued challenge + atomic nonce CAS** and fresh installation-wide GitHub PR ownership, paired-device and session readbacks before WSS acceptance; crash-uncertain state must never auto-replay.
4. Owner-authorized PREPRODUCTION acceptance on real paired Android showing expiry, rotation, revocation and no repeated manual copy/paste. Human ChatGPT login/OAuth/MFA/CAPTCHA remains locked.

**Tests:** real WebCrypto P-256/HMAC fixtures and adversarial cross-worker/tenant/session/epoch, expiry, invalid proof, altered MAC and replay-not-authorized. Required relay exact-head CI and independent review before merge; production locked.
