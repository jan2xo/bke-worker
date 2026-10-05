# Android ChatGPT target recovery — implementation wave

## Parent mission

This dependency exists for the single-worker roadmap in #39 and the live serial
Task A ledger in #48.

Owner direction for this wave:

> implement first; certify dependencies one by one later.

No explicit Intent Certification is invoked by this implementation wave.

## Recovery behavior

The Android Worker now keeps browser/ChatGPT recovery bounded and separate from
GitHub ownership.

### Gecko content process crash / kill

GeckoView reports the session as closed/unusable after content-process crash or
kill. The Worker keeps the same `GeckoSession` object attached to the UI and:

1. enters `RECOVERING`;
2. reopens the session against the existing `GeckoRuntime` when closed;
3. rebinds the built-in Worker WebExtension native-message delegate;
4. reloads `https://chatgpt.com/`;
5. waits for a valid Worker status;
6. retries at most three recovery attempts.

After exhaustion, the Chat state becomes `FAILED`.

### Composer unavailable

A valid ChatGPT page that has no usable composer enters `NO_COMPOSER`.
Recovery is triggered only after one bounded readiness window. Periodic
WebExtension status reports do not reset that window indefinitely.

### Native bridge disconnect

The WebExtension already retries its native port. Android gives that reconnect a
bounded grace window. If the native port remains disconnected, the same bounded
ChatGPT recovery path is invoked.

## Duplicate-dispatch boundary

If a Gecko crash/kill happens while an accepted wake is still in flight, the
Worker does not infer completion and does not redispatch automatically.

Instead:

`BLOCKED_UNCERTAIN_TURN`

is surfaced and the active wake remains fail-closed. This avoids turning browser
recovery into duplicate prompt delivery.

## Authentication boundary

Recovery may reopen/reload the existing human-authenticated ChatGPT surface.

It does not:

- enter credentials;
- automate OAuth;
- automate MFA;
- solve CAPTCHA/security challenges;
- synthesize a new login session.

If ChatGPT no longer has a usable composer because authentication or a security
challenge is required, bounded recovery eventually fails closed for human
recovery.

## Later certification

Required later:

- PR Guard;
- `android` Intent Certification;
- live device stop/start/reopen proof;
- controlled crash/kill recovery proof;
- controlled no-composer/native-port recovery proof;
- active-turn uncertainty proof.

Production remains locked.
