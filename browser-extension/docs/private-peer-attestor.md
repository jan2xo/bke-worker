# Owner-pinned native host signed peer evidence — SOURCE ONLY

Parent: [BKE Command Center issue #30](https://github.com/jan2xo/bke-command-center/issues/30). Dependency: merged Command Center [PR #57](https://github.com/jan2xo/bke-command-center/pull/57) provides a server-side verifier of a separate attestor's P-256 signature. Worker [PR #108](https://github.com/jan2xo/bke-worker/pull/108) provides an owner-controlled local Chrome host installer, **not** proof of server-trusted Chrome/browser provenance.

## What this PR delivers

A standalone **dormant** Node.js signer in `browser-extension/native-host/private-peer-attestor.mjs`. A future independently authenticated operating-system host process may inject an owner-approved *separate attestor* P-256 private-key signing capability, and a trusted platform/session inspector. It signs the exact canonical signature array expected by Command Center PR #57, under a fresh server-generated 32-byte nonce. It locks the worker ID, source, device public-key thumbprint, browser profile, bridge and ChatGPT target fingerprints to an owner-approved policy; the session fingerprint must be independently obtained from the trusted private transport. One response is allowed per nonce, only one pending session is allowed, and errors/uncertain outcomes never trigger automatic retries.

This source file must NOT be imported by `entry.mjs`, `host.mjs`, the WebExtension, Cloudflare runtime, or the installer. Its test key is ephemeral and has no authority.

## Critical trust boundary

This signer is **not** an authenticated host or OS attestor by itself. Signing browser JSON or values supplied by a Chrome argv origin is explicitly prohibited. The platform-specific `inspectTrustedPeer` function is an *unimplemented, trusted-code-only dependency*, and must verify provenance through an independently pinned native executable, actual browser/GeckoView host association, OS installation ownership, per-profile isolation and trusted private channel. Likewise, its separate P-256 attestor private key and server-side public key pin must be securely provisioned/registered by an explicitly human-authorized ceremony. Do not reuse the WebExtension IndexedDB device identity key, GitHub App key, Cloudflare relay token or admin token.

Command Center must bind the matching authenticated peer and challenge to its private trusted transport; the proof is necessary but is NOT pairing consent, a worker lease, dispatch authority or permission to automate ChatGPT login.

## Certification scope

- Source-only Node 22 / real generated-key P-256 adversarial tests, exact canonical cross-repo fixture, replay/uncertain/race/wrong-policy negatives.
- Exact-head WebExtension/native-host CI and existing required PR Guard.
- No `nativeMessaging` browser permission or host installer/Chrome registration changes; no Cloudflare activation, secret creation, Android PR #90 wake, production or PREPRODUCTION changes.
- Next independent milestone: genuine OS-backed, privately provisioned attestor and authenticated transport, then owner-approved live acceptance.
