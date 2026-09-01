# BKE Worker

BKE Worker is a deterministic worker runtime around the real ChatGPT application. Notion defines what work exists; the worker selects context and reasoning policy, the platform driver controls ChatGPT, and the result returns to Notion. There is no OpenAI API dependency and no external recreation of ChatGPT context.

## Structure

- `BKE.Worker.Core` — portable domain models, contracts, policy, and testable loop.
- `BKE.Worker.Notion` — work-source adapter boundary; implementation intentionally deferred.
- `BKE.Worker.ChatGPT` — platform-neutral driver boundary/stub.
- `BKE.Worker.Platform.Android` — Android V0 contracts and driver seam. Device binding remains pending real-device validation.
- `BKE.Worker.Platform.*` — future platform-specific driver homes.

## Android V0 execution contract

The Android driver must operate only through the authenticated ChatGPT app and Android accessibility semantics. It must:

1. Launch or foreground ChatGPT.
2. Discover and deterministically match `RecentChat`, `ProjectChat`, or `NewChat`.
3. Inspect, select, and verify the requested reasoning profile before sending.
4. Populate and submit the composer.
5. Observe completion with a bounded timeout.
6. Capture only the newest assistant response.

The Android module now contains explicit accessibility, context-matching, reasoning-verification, execution-state, failure-code, and local-result seams. Android framework `AccessibilityService` wiring is intentionally device-dependent and is not certified by CI.

## Manual device gate

Use an authenticated Android device/emulator with ChatGPT installed and Accessibility Service permission enabled. Run:

```
BKE WORKER TEST 001.

Reply with exactly:

BKE_WORKER_OK
```

Record evidence for RecentChat, ProjectChat, NewChat, HIGH reasoning selection/verification, submission, completion detection, and response capture. Do not record credentials or upload accessibility-tree dumps.

## Next gate

Complete the concrete Android `AccessibilityService` adapter and manual-test harness. Only after real-device evidence passes should Notion polling, claiming, and result persistence begin.
