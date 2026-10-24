# F1-03 — signed-proof-bound local read-only native echo (SOURCE ONLY; physical handshake unproven)

This document is part of existing F1-03 Issue #124 / draft PR #146. It describes the strict, one-shot local read-only envelope in
browser-extension/native-host/local-read-only-controller.mjs and the
owner-popup opt-in native proof path.

## What is implemented

- The API accepts ONLY an exact-shape, one-shot LOCAL_READ_ONLY_PING
  envelope, never commands to navigate, send, execute JavaScript, mutate
  GitHub, enroll a worker, read cookies, or change a browser profile.
- Worker ID, P-256 public thumbprint, profile commitment, target commitment,
  bridge commitment, issued two-party proof nonces and short deadline are
  bound into a domain-separated public SHA-256 proposal fingerprint.
- Wrong values, extra keys, mismatched versions, duplicates, clock rollback,
  expiration and even malformed first attempts permanently spend the one
  gate attempt. Explicit close fails closed.
- A valid response says LOCAL_READ_ONLY_PONG, with no pairing, dispatch,
  ChatGPT send or authenticated-controller authority.
- The code and its tests have no network or browser runtime side effects.

## What is NOT implemented or attested

**This is NOT an authenticated controller or session.** The existing
LOCAL_PROOF_OK receipt contains only public fields. Verifying its SHAPE
is not equivalent to verifying a signed P-256 proof in the native host;
a caller could fabricate that shape. The gate must be instantiated
ONLY by a future transport after the real native host has completed and
authenticated its signed challenge. A public SHA-256 digest is NOT a
MAC or a secret token; it offers scope/accidental collision binding only.

The native host now instantiates the gate **only after** cryptographic
verification of the real P-256 proof on the same local Chrome nativeMessaging
channel. A new explicit `read_only_probe:true` HELLO opt-in results in a
one-shot bound LOCAL_READ_ONLY_PING; the extension independently checks exact
schema, profile/target/bridge pins, both nonces, TTL, and SHA-256 fingerprint,
then echoes only the verified frame. The host consumes at most one reply and
returns LOCAL_READ_ONLY_PONG with admission/dispatch/send authority NONE and
external controller authentication NOT_ESTABLISHED. The legacy one-shot
LOCAL_PROOF_OK path remains unchanged for non-opt-in callers.

The source tests run a genuine Node subprocess and a mocked Chrome port.
**This is not real browser-native permission, installed host registration,
or physical Chrome↔Node certification.** No external controller connection,
persistent replay store, autonomous reconnect, OS hardware attestation,
ChatGPT send, GitHub PR authority or account/session enrollment exists.
MV3/restart recovery and authenticated controller admission remain separate
required F1-03 work, and no first-send authorization is granted.
Fail closed if a browser profile/target is shared, cloned or ambiguous.

## Remaining owner/certification gates

- Separate actor reviews exact PR #146 source including the owner-pinned
  policy creation, optional nativeMessaging path and this contract.
- A genuine signed, owner-consented real Chrome-to-Node handshake and
  physical evidence on the operator's Mac.
- A genuinely authenticated per-worker controller session, complete
  browser/target exclusivity and safe MV3 restart semantics. Local
  native-proof-bound PING is not authenticated *external* controller admission.
- Trusted GitHub assignment and first-send authority are separate
  downstream F1-02 / F1-04 tasks, never granted here.

The minimum source proof for this **locally wired read-only contract** is the
automatic exact-head PR Guard + WebExtension/native-host Node tests.
PR #146 remains OPEN/DRAFT/UNMERGED while remaining F1-03 acceptance
gates are incomplete. No operator Mac action yet.
