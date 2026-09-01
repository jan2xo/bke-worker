# BKE Worker

`BKE Worker` is a deterministic worker runtime around the real ChatGPT application. Notion defines what work exists; the worker selects the context and reasoning policy, the platform driver controls ChatGPT, and the result returns to Notion. There is no OpenAI API dependency and no external recreation of ChatGPT context.

## Structure

- `BKE.Worker.Core` — portable domain models, contracts, policy, and testable loop.
- `BKE.Worker.Notion` — work-source adapter boundary; implementation intentionally deferred.
- `BKE.Worker.ChatGPT` — platform-neutral driver boundary/stub.
- `BKE.Worker.Platform.*` — platform-specific driver homes; Android is the first vertical-slice target.

Dependency direction is inward: platform and adapters reference Core contracts; Core references no UI, Notion SDK, or platform APIs.

## Execution policy

Supported profiles are `DEFAULT`, `MEDIUM`, `HIGH`, and semantic `MAX_AVAILABLE`. The default is `HIGH`; the driver must resolve and verify the actual UI selection before sending work.

## Next gate

Implement Android driver V0: launch ChatGPT, select Recent/Project/New context, apply and verify `HIGH`, submit `WORKER TEST 001`, detect completion, and capture the response. Only after that proof should Notion persistence become functional.

## Scaffold status

This wave contains contracts, models, stubs, fake-adapter test seams, and CI-ready projects. It does not certify real UI automation, production readiness, or Notion connectivity.
