# FORGE F1-04 — first-message actuator boundary

## Status

This PR is a **source-first draft** for the bounded new-chat/first-message path. It does not claim live F1 readiness, runtime authority, an authenticated GitHub App principal, a trusted native/browser pairing, or a real ChatGPT send. Current source has no trusted live submit adapter; `FIRST_MESSAGE_LIVE_SEND_ENABLED` is a literal `false`.

## First-message ordering

1. Read the authoritative live task, exact PR head, single-worker assignment, active attempt and complete conversation history through the future authenticated F1-02 provider adapter.
2. Verify the dedicated target/profile/tab and an idle, authenticated `https://chatgpt.com/` landing page through the future trusted F1-03 controller. A blank fresh chat must have **no** `/c/<id>` yet.
3. Commit and read back the durable pre-send fence.
4. Consume the one-shot first-send claim in the authenticated GitHub ledger, then independently read it back by exact claim SHA and identity pins. The new pure `AUTHORIZE_FIRST_SUBMISSION` stage requires matching read-back receipts for both the fence and claim before it returns `FIRST_SUBMISSION_CANDIDATE`.
5. Only a separately certified runtime may submit the fixed bootstrap prompt once. Any crash, lost write/read-back, stale tab, login challenge, UI drift, duplicate target, wrong profile/worker/PR/head, or uncertain delivery is blocked or quarantined; it must not resend.
6. After a real send, capture the actual stable `/c/<conversation-id>`, bind it to the same attempt/fence/claim/worker/PR/head/tab, and persist the receipt. A synthetic ID or pre-send URL is not a conversation receipt.

The pure evaluator validates coherence only. It cannot authenticate provider responses and its result always has `authority: NONE`.

## Source delivered here

- Adds a strict pre-submit gate that requires a durable fence, exact consumed-claim fields, and a matching post-CAS GET read-back receipt with chronology and identity pins.
- Adds an allowlisted bootstrap prompt containing only the canonical repository, exact PR number, exact head SHA and validated worker/attempt/execution identifiers. Arbitrary controller prompts, PR title/body text, JavaScript, page text, local paths and secrets are never interpolated.
- Adds adversarial tests for wrong worker/PR/head/profile/target/tab, shared or duplicate targets, missing composer, login challenge, busy/UI drift, missing/mismatched claim read-back, uncertain delivery, crash recovery and unsafe prompt identifiers.
- Actual browser submit, native messaging, GitHub ref writes, authentication automation and any PREPRODUCTION/production operation remain unavailable in this revision.

## Unmet gates

- F1-02 #123: independently owner-certified authenticated provider principal, real owner-approved disposable-ref CAS/write/readback and migration proof.
- F1-03 #124: independently owner-certified trusted per-profile native/browser pairing and real browser control proof.
- Human owner: isolated real-browser acceptance after those boundaries are integrated.
- BRO-KODE: independent audit of the exact final PR head and its CI.

Synthetic tests are not live proof. No live send, provider write, enrollment, dispatch or activation is performed by this source PR.
