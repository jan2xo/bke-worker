# F1-03 — proposed read-only local controller envelope (SOURCE ONLY)

This document is part of existing F1-03 Issue #124 / draft PR #146. It
describes a new standalone contract under
browser-extension/native-host/local-read-only-controller.mjs.

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

The gate is intentionally **UNIMPORTED** from entry.mjs, host.mjs and
the extension service worker. No runtime channel, command dispatch,
native host registration, browser permission, OAuth, GitHub PR authority,
device/session enrollment, ChatGPT send or OS attestation is enabled by
this addition. No persistent cross-process replay database is created:
host restart/MV3 reconnect must require an entirely fresh owner-bound
proof and durable recovery plan before a status transport is wired.
Fail closed if a browser profile/target is shared, cloned or ambiguous.

## Remaining owner/certification gates

- Separate actor reviews exact PR #146 source including the owner-pinned
  policy creation, optional nativeMessaging path and this contract.
- A genuine signed, owner-consented real Chrome-to-Node handshake and
  physical evidence on the operator's Mac.
- A genuinely authenticated per-worker controller session, complete
  browser/target exclusivity and safe MV3 restart semantics.
- Trusted GitHub assignment and first-send authority are separate
  downstream F1-02 / F1-04 tasks, never granted here.

The minimum required proof for this **unwired pure contract** is the
automatic exact-head PR Guard + WebExtension/native-host Node tests.
PR #146 remains OPEN/DRAFT/UNMERGED while remaining F1-03 acceptance
gates are incomplete. No operator Mac action yet.
