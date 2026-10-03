# Chromium extension bridge architecture

## Intent

The browser extension is the planned browser-side bridge for BKE Worker's multi-worker architecture.

The long-term purpose is to let a worker's normal persistent Chromium profile run on an approved host without exposing a public CDP endpoint. The extension lives inside that exact browser profile and eventually creates an **outbound authenticated connection** to the BKE control plane.

The current canonical autonomous runtime remains:

`Linux/.NET -> human-authenticated persistent Chromium -> loopback Playwright/CDP -> ChatGPT Chat`

This extension does not replace that runtime yet.

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

- **Browser extension:** TypeScript / Manifest V3.
- **BKE Worker/control plane:** .NET/C#.
- **Browser authentication:** human-owned Chromium profile.

Do not rewrite the existing Worker into TypeScript merely to support the extension. The extension is a browser-native adapter, not a replacement for the .NET orchestration/runtime layer.

## Permission boundary

The foundation requests only:

- `storage`;
- host access to `https://chatgpt.com/*`.

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

## Migration rule

The extension path is additive until it proves parity with the required browser contract.

Before replacing Playwright/CDP for live engineering, certify at minimum:

1. exact worker/profile identity;
2. human-authenticated ChatGPT session survives normal browser/worker restart;
3. correct ChatGPT target is observed;
4. composer availability and busy state fail closed;
5. bounded prompt dispatch reaches only the intended worker conversation;
6. duplicate/ambiguous dispatch cannot double-send;
7. no credential or message-content leakage;
8. controller loss/reconnect does not create uncertain duplicate execution;
9. multiple extension-backed workers remain isolated.

Until that proof exists, Playwright/CDP remains canonical.
