# Android relay-ready wake + ChatGPT dispatch

## Intent

Wire the BKE Worker Android/Gecko host so it is ready for a future Cloudflare/VPS relay **before** that relay exists.

This intent owns the worker side only:

```text
future relay
  -> outbound WSS already established by Android foreground service
  -> bounded wake packet
  -> Android validates/dedupes
  -> Android builds canonical CONTINUE FROM PR prompt
  -> Gecko native messaging port
  -> ChatGPT composer
  -> BUSY / READY observation
  -> bounded ACK/status back to relay
```

No Cloudflare code or production endpoint belongs in this PR.

## Security boundary

The relay never supplies arbitrary prompt text.

It may supply only bounded wake metadata:

```json
{
  "protocol": 1,
  "type": "wake",
  "worker_id": "android-worker-a",
  "repo": "jan2xo/bke-worker",
  "pr_number": 24,
  "expected_head_sha": "0123456789abcdef0123456789abcdef01234567",
  "reason": "pull_request_event",
  "delivery_id": "delivery-id"
}
```

Android constructs the continuation prompt locally from that metadata.

The prompt requires ChatGPT to recover current-main canonical instructions and live GitHub truth before engineering action.

## Transport contract

- non-loopback transport requires `wss://`;
- `ws://` is accepted only for localhost/127.0.0.1 development;
- non-loopback relay configuration requires a runtime pairing/session token;
- the token is held in service memory only in this wave and is never logged or committed;
- reconnect uses bounded exponential backoff;
- one worker ID maps to one active relay client;
- delivery IDs are deduplicated with a bounded recent set;
- one ChatGPT dispatch may be active at a time;
- while BUSY, at most one re-evaluation wake is retained.

## Gecko bridge

The built-in WebExtension opens `runtime.connectNative("bke.worker.gecko")`.

Native Android keeps the corresponding GeckoView `WebExtension.Port` and sends only a bounded `dispatch_prompt` command generated locally.

The content script:

- refuses dispatch outside ChatGPT;
- refuses dispatch when turn state is already BUSY;
- refuses dispatch without a composer or send control;
- writes the locally generated continuation prompt;
- clicks the ChatGPT send control;
- reports bounded dispatch success/failure;
- never returns prompt or response contents to Android/relay.

## Completion

A wake lifecycle is:

```text
wake
 -> accepted/deferred
 -> prompt dispatched
 -> BUSY observed
 -> READY observed
 -> completed ACK
```

A duplicate delivery ID must never double-send the ChatGPT prompt.

## Out of scope

- Cloudflare Worker / Durable Object implementation;
- GitHub webhook ingress;
- server-side worker routing;
- production deployment;
- OAuth/MFA/CAPTCHA automation;
- arbitrary remote prompt/DOM/JS execution;
- assistant-response scraping;
- canonical runtime cutover from Linux/Playwright.
