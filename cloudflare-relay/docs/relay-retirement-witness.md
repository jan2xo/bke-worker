# G0-01: dormant read-only relay retirement witness

Parent: BKE Worker Issue #135 (https://github.com/jan2xo/bke-worker/issues/135).
Old live-certification ledger: PR #90 (https://github.com/jan2xo/bke-worker/pull/90).

## Scope

This is only an **unimported read-only helper with adversarial tests**. It is not a cancellation endpoint, Admin route, authenticated DO introspection API, worker lifecycle controller, or proof of live delivery/cancellation. The relay entrypoint, Wrangler configuration, deployed Cloudflare secrets, GitHub assignments and Android application remain unchanged.

GitHub shows android-worker-a still assigned to PR #90 while the relay earlier recorded coalesced_queued delivery ecba94d0-cc65-11f1-81c0-1201344291e7. The operator intentionally uninstalled both Android APKs. The DO may nevertheless retain the wake. **Do not remove the worker label, reuse this worker ID, start a replacement WSS connection, or assert LIVE PASS merely because this observer exists.**

The helper readRelayRetirementWitness(storage, expected) reads existing worker_id, active_wake, queued_wake, active_connection_id, and recent_deliveries using get only. It returns redacted, non-secret routing metadata; active phase and registered-connection presence; and immutable authority=NONE, delivery_ack_proven=false, delivery_fenced=false, can_retire=false. It validates each persisted active/queued wake through the canonical relay `validateWake()` contract, requiring **exactly** `protocol`, `type`, `worker_id`, `repo`, `pr_number`, `expected_head_sha`, `reason`, and `delivery_id`, including protocol/version, message type, allowed repository, valid reason and canonical delivery ID format. No unknown or missing wake fields are accepted. The server-owned `expected` context must also pin the allowed `repo`, preventing cross-repository PR-number/head identity confusion. Active wake envelopes allow only `wake` and `phase`; invalid phase/schema fails closed. The helper deliberately omits reason and other unnecessary diagnostic data from its redacted result. It fails closed on missing/mismatched identity, wrong repository/PR/head, malformed state, or unavailable storage. No active wake is not proof that an already-sent ChatGPT turn completed. Sequential reads are **not** an atomic consistency cut.

## Requirements for future owner-gated live use

1. Independently authenticate the human Admin and obtain explicit scoped owner consent. A trusted server must derive and bind the worker ID, PR number and exact head. Device/browser-request fields must not supply authority or be treated as a trusted expected context.
2. Select the pre-existing exact-generation WorkerSession DO using a privileged internal service binding. Expose a minimal read-only redacted witness only through a separately authenticated operator interface, not a public route. This PR does **not** provide such an interface.
3. Independently design and certify atomic DO retirement tombstone/epoch fencing; refuse new connects, register, recovery and dispatch for retired identities; reject stale sockets and credentials, and handle all partial-write/ambiguous-outcome races. Do not infer cancellation from GitHub label removal.
4. Durably prove the post-fence readback and authorized credential revocation, then release GitHub ownership using an explicit human-gated procedure. Never automatically reuse android-worker-a as FORGE F1.
5. Run the smallest complete exact-head relay certification graph and independent source audit before an authorized SHA-locked merge. No live PREPRODUCTION deployment, token rotation, cancellation, wake, or device authentication is authorized here.

The eventual product outcome remains one-time authorized Gecko enrollment, automatically renewed device-scoped relay credentials and isolated FORGE F1 / CODE REVIEW C1 tabs. This witness alone does not deliver those capabilities.
