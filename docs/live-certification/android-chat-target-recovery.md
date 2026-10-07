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


## One-command local certification

The live device matrix is driven by the repository-owned operator entrypoint:

```bash
bash scripts/certify-android-chat-target-recovery.sh
```

The entrypoint discovers the exact parent head, downloads and verifies the
stable-signed recovery APK built from that same exact revision, preserves the existing
`com.bke.worker.gecko` installation, and prompts only at the human ChatGPT
authentication boundary.

The recovery APK uses the existing PREPRODUCTION Android signing authority, never the
production signing key. After the one-time migration from the legacy ephemeral CI debug
signature, the entrypoint uses `adb install -r` so
`com.bke.worker.gecko.recoverycert` app data, its Gecko profile, and the
human-authenticated ChatGPT session survive later certification rebuilds. Uninstall is
allowed only when Android explicitly reports the legacy signature as incompatible.

Fixed recovery-cert actions are accepted only by a debuggable package whose
application ID ends in `.recoverycert`. They are invoked through the
non-exported Worker service from the app UID and expose only bounded test
operations: content crash, content-kill callback, NO_COMPOSER, native-port loss,
exhausted-recovery fail-closed behavior, and explicit reject/recovery of a
deliberately uncertain certification wake. They do not accept arbitrary prompt
text, JavaScript, shell commands, URLs, or credentials.

For the content-process kill case, the operator entrypoint first attempts a real
`:tab`/Tab child-process kill. If the Android build isolates that child such
that the app UID cannot kill it, the script exercises the fixed onKill callback
path for diagnostics but reports the matrix as BLOCKED rather than claiming a
real kill PASS.

The in-flight uncertainty test uses the parent recovery PR and worker ID
`android-worker-recovery-cert`. The script assigns that temporary worker only for the
bounded live proof, waits for `CHAT: BUSY`, crashes the content process, requires
`BLOCKED_UNCERTAIN_TURN`, waits to prove the state remains blocked, then performs
an explicit operator reject/recovery before stopping the relay and releasing the
temporary assignment. An interrupted/ambiguous run fails closed rather than
silently clearing ownership.

The script sources the PREPRODUCTION relay master key only from the authorized
local secret file, derives a worker-bound token without printing it, transfers
that token to the debuggable sidecar without writing it to GitHub, and removes
the temporary app-private token file immediately after configuration.

Production remains locked.


## Recovery render and durable witness

Recovery status includes a monotonic recovery sequence and the last initiating recovery
reason. Live certification uses that durable witness for native-port loss instead of
requiring a one-second poll to catch the transient `CHAT: RECOVERING` value.

When a new recovery sequence reaches `CHAT: READY` or `CHAT: BUSY`, the Activity
explicitly requests a root/GeckoView layout and invalidation pass. This prevents a
recovered GeckoSession from remaining visually white until unrelated operator UI
interaction (such as expanding Worker Configuration) forces a layout.
