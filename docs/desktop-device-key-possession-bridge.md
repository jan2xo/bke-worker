# Desktop WebExtension P-256 profile identity — source-only

Parent mission: Command Center [issue #30](https://github.com/jan2xo/bke-command-center/issues/30). Depends on [Command Center PR #55](https://github.com/jan2xo/bke-command-center/pull/55) merged at `28a06408e319c86b0b6d0e95bac8caefa819faef`. The Command Center owns proposal-preparation and HMAC installation Durable Object state. BKE Worker PR #105 supplies the missing desktop device-side cryptographic component, not an enrolled online worker.

## Intent and boundaries

The selected Worker target is Android GeckoView plus embedded WebExtension/native messaging, and desktop browser WebExtension. Legacy .NET/CDP is preserved, not the selected new platform. This PR changes **only** the desktop MV3 WebExtension signing and local identity surface; Android needs its own native adapter and live cross-platform acceptance.

The user sees **Create device identity** in the extension popup after setting one valid worker ID. A popup-only message prompts a service worker to create a WebCrypto P-256 ECDSA keypair with `extractable=false`, using an isolated browser extension origin's IndexedDB object store (not `chrome.storage.local` or `chrome.storage.session`). The persisted private CryptoKey is never exported or returned to popup/content scripts. Only public key SHA-256 and "LOCAL KEY READY (UNPAIRED)" are shown. A mismatched worker ID inside that existing browser profile **fails closed** rather than silently rotating/reassigning the private key. No browser profile, secret, cookie, identity token, ChatGPT content or encryption key is sent to GitHub or ChatGPT. Copying a full browser profile may copy the IndexedDB CryptoKey: the browser-origin isolation itself does not cryptographically prove a hardware-bound identity; cloned profile detection and managed platform-bound attestation remain separate requirements.

## Device proof for future authenticated transport

`createDeviceIdentityBridge(store, crypto, clock)` has three methods:

- `initialize(worker_id)`: generates one nonexportable P-256 device key and persists it using one serialized IndexedDB readwrite transaction, idempotently refusing a different worker ID.
- `read(worker_id)`: returns only canonical public JWK `{crv:"P-256",kty:"EC",x,y}`, worker ID and SHA-256 thumbprint. The popup has an even narrower `publicIdentitySummary`.
- `sign(worker_id,challenge)`: an **internal-only** source primitive. It validates exactly six challenge fields, GitHub App installation numeric scope, worker match, lowercase SHA-256 proposal, keyed Admin subject, 256-bit random nonce and safe expiry in the next 30 seconds. It durably claims a nonce in a bounded storage transaction before any signature; duplicate and competing requests fail closed, and storage failure can never return a signed proof. Its 64-byte ECDSA-P256 IEEE-P1363 response is compatible with the Command Center PR #55 `deviceMessage` JSON array, including the exact domain `bke-command-center/preproduction/device-key-possession/v1`. The proof is verified against its own stored public key to fail closed on mismatched pair/corrupt record. Signed output is never persisted or logged.

**Important:** this primitive does not authenticate the source of a challenge or transport; it is **not wired** to popup/runtime messages, content scripts, WebSocket, network fetch, or arbitrary caller-controlled strings. Only a separately certified authenticated device-native/extension-to-controller transport may call it in a future PR. A signature demonstrates **device-key possession**, not authorization to enroll, claim GitHub PR work, share profiles, dispatch ChatGPT prompts, or bypass Cloudflare Access Admin approval. This PR adds NO nativeMessaging permissions, cookies/debugger permissions, host permissions, credentials or controller connection.

## Intentional exact-head certification

The existing automatic PR Guard remains the cheap BKE intent/queue policy checker. An isolated **path-conditional** job now certifies browser-extension changes at the **exact PR head** with Node 22, pinned TypeScript build, unchanged manifest permissions, and adversarial Node/WebCrypto storage tests. No legacy .NET/Android/relay CI is triggered by this extension-only intent.

Tests cover real P-256 nonextractability and cross-key verification, concurrent identity creation and one-shot nonce claims, malformed/cross-worker/stale challenges, storage read/write and corruption, keypair mismatch, profile isolation using separate storage instances, UI-only public status, and absence of exposed signing/runtime network. The Node test adapter is a controlled serialized transaction fixture; it is not a live Chromium IndexedDB or human-authenticated ChatGPT smoke. Actual browser-profile IndexedDB persistence, service-worker lifecycle, Android compatibility, authenticated transport and physical device pairing require distinct acceptance evidence.

## Locked dependencies

No Cloudflare PREPRODUCTION activation, real authenticated device bridge, outbound WSS handshake, service-binding deploy, device challenge delivery, human ChatGPT login, browser-profile migration, production change, new GitHub permissions or worker PR lease is authorized by this PR. Parked BKE Worker PR #90 remains untouched. GitHub remains engineering truth; Worker remains liveness, not a second planner.
