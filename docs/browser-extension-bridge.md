# WebExtension bridge architecture — desktop surface of one BKE office

## Intent and status

The operator-selected target offers **two interchangeable browser-integrated office entry/execution surfaces**: Android GeckoView with an embedded WebExtension/native-message bridge, and a desktop browser WebExtension. The engineering office itself is GitHub-governed, not bound to Android, a Linux host, or a browser profile. Worker assignment remains exclusive by GitHub PR/worker label.

The desktop extension lives in a human-owned authenticated browser profile and will eventually establish an **outbound authenticated control-plane connection** without exposing public CDP. The checked-in Manifest V3 foundation is presently **probe-only**; it has not yet certified remote prompt delivery, continuation, or multiple live extension workers.

Android GeckoView is a **separate implemented platform path** with historical live PREPRODUCTION GitHub -> Cloudflare relay -> ChatGPT proof (PR #38). Its installed/current device state is not inferred from that historical result. Cross-platform protocol reuse is desirable, but GeckoView native messaging and desktop browser-extension lifecycle/permissions need platform-specific adapters and certification.

Linux/.NET + Playwright/CDP is preserved as legacy implementation and test evidence. It is **not the operator-selected target**. This document changes architecture direction, not deployed runtime or certification status.

## First foundation

The first extension wave is deliberately probe-only.

```text
CHATGPT TAB
  |
  | isolated content script
  | status only
  v
MV3 SERVICE WORKER
  |
  +-- validate sender origin + payload
  +-- chrome.storage.session -> transient ChatGPT status
  +-- chrome.storage.local   -> non-secret worker configuration
  |
  v
EXTENSION POPUP
  |
  +-- worker ID
  +-- future controller URL
  +-- live probe/status
```

The content script reports only:

- current ChatGPT URL;
- whether the tab is visible;
- whether a usable composer is present;
- whether a visible stop/busy control is present;
- observation time.

It does not collect prompt text, assistant responses, cookies, credentials, OAuth data, MFA material, or browser profile contents.

## Language and runtime split

- **Desktop browser extension foundation:** TypeScript / Manifest V3, currently Chrome-targeted/probe-only; support for other desktop browsers requires compatibility testing.
- **Android:** GeckoView plus its embedded extension/native-messaging adapter.
- **Control/wake/assignment:** GitHub is durable authority; Cloudflare relay and other orchestrators are transport/liveness infrastructure, not task databases.
- **Authentication:** human-owned ChatGPT session in each isolated browser or GeckoView profile.

Shared concepts are worker identity, bounded dispatch, idempotency, recovery, and GitHub ownership—not an assumption that Chrome extension APIs, GeckoView messaging, or .NET server APIs are identical. Do not rewrite or remove existing code solely because the selected architecture changed.

## Permission boundary

The foundation requests only:

- `storage`;
- host access to `https://chatgpt.com/*`.

The service worker immediately restricts both `chrome.storage.local` and `chrome.storage.session` to `TRUSTED_CONTEXTS`, so content scripts cannot read bridge configuration or transient stored status directly.

It intentionally does not request:

- `<all_urls>`;
- `cookies`;
- `debugger`;
- `history`;
- `identity`;
- `nativeMessaging`;
- `webRequest`.

Future changes must justify any new permission in the PR certification plan.

Content-script messages are treated as untrusted input. The service worker validates sender origin, protocol version, field types, and ChatGPT URL origin before persisting status.

## Persistence

The extension does not replace the Chromium profile.

The browser profile remains the durable container for the human-authenticated ChatGPT session and installed extension. The extension stores only non-secret bridge configuration in `chrome.storage.local`.

Transient page observations use `chrome.storage.session` and disappear with the browser session.

No passwords, cookies, access tokens, MFA secrets, or copied browser-profile data belong in BKE Worker state or extension storage.

## Controller transport direction

The controller URL field is preparatory only. This foundation does not open a network bridge.

The next transport intent should implement an authenticated, outbound-only control channel with these properties:

- `wss://` for non-loopback transport;
- loopback `ws://` allowed only for local development;
- explicit pairing/device identity before command acceptance;
- no bearer secret embedded in source;
- bounded protocol messages rather than arbitrary JavaScript/DOM evaluation;
- reconnect/backoff that survives MV3 service-worker lifecycle;
- per-worker identity bound to the controller session;
- idempotency/delivery IDs for dispatch commands;
- fail closed on protocol/version/identity mismatch.

Chrome 116+ is the current minimum because future WebSocket activity can extend a Manifest V3 extension service worker lifetime while messages continue to flow.

## Desktop WebExtension activation gate

The **WebExtension is the selected desktop target**, but this foundation must not be described as a live autonomous executor until an independently scoped PR proves:

1. exact worker, GitHub PR assignment, extension/pairing, and browser-profile identity;
2. human-authenticated ChatGPT session survives browser and extension restart without automating authentication;
3. correct ChatGPT conversation/target is selected and confirmed;
4. composer availability, busy/idle state, and interruption safety fail closed;
5. bounded authorized PR dispatch reaches only the intended worker conversation;
6. duplicate, conflicting, or ambiguous delivery cannot double-send;
7. no credential, cookie, browser-profile, or unauthorized message-content leakage;
8. control-plane disconnect/reconnect and uncertain in-flight turns do not duplicate execution;
9. multiple desktop extension workers remain isolated and cannot cross-dispatch;
10. meaningful results appear in GitHub PR checkpoints and exact-head certification, not as private direct reports to Master.

The legacy Playwright/CDP implementation remains in source until a separate authorized retirement intent, but **it is not the target or prerequisite for activating the desktop WebExtension**. Android and desktop workers may execute asynchronously from independent PR assignments. The main office recovers their progress from GitHub; automatic main-office wake is a later, separate certification gate.
