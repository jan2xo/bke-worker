# Android single-worker PREPRODUCTION live 30-minute continuation acceptance

**Intent:** BKE ANDROID CONTINUATION CERTIFICATION

**Authority:** current `main` BKE Worker canonical instructions; issue [#83](https://github.com/jan2xo/bke-worker/issues/83); operator-gate preparation [PR #89](https://github.com/jan2xo/bke-worker/pull/89). GitHub is durable engineering truth; worker is executor/liveness, not a planner.

**Current evidence status:** NOT RUN / DEVICE STATE UNKNOWN. This file and its PR are a controlled disposable acceptance ledger, not proof of Android session liveness, authenticated ChatGPT execution, or successful 30-minute continuation.

## Preflight and single-owner arming

**Do not attach a worker label from the main brain while Android readiness is unknown.**

1. This PR is a draft, based on fresh `main`, with no runtime implementation changes. The only changed file is this acceptance document.
2. No other open PR across the owner's GitHub repositories may have `bke-worker:android-worker-a`; do not reuse a shared GeckoView session, extension pairing, or worker ID.
3. The human confirms **BROWSER ATTACHED / CHAT READY / RELAY CONNECTED**, the app's worker ID is exactly `android-worker-a`, and no duplicate session exists.
4. The human runs the repo-owned owner gate from a Git checkout: `bash scripts/certify-android-continuation-preproduction.sh`. It recovers main/this PR and performs identity/ownership/safe-diff checks before requiring the human arming acknowledgement.
5. Only after that gate may the script apply one `bke-worker:android-worker-a` label. Label delivery/wake does not equal acceptance proof.

No reinstall, re-signing, production deployment, relogin automation, secret export, or profile migration. If status is unavailable or ambiguous, **stop without arming**.

## Assigned worker's strictly bounded mission

After an authenticated GitHub/relay wake, the ChatGPT worker must recover the canonical instructions on current main, verify live ownership/PR head, and check the current PR task checklist. Do not act on a generic message alone.

**First turn:**

- Independently verify the assigned PR number, exact head SHA, sole worker label, and intended ChatGPT target; do not infer any of these from the owner's attestation.
- Record a short `BKE CONTINUATION CHECKPOINT — FIRST_TURN` GitHub PR comment with worker ID, PR number, head SHA, current checklist cursor, and whether the relay delivery is terminal/non-uncertain. This is only a progress checkpoint; do not mark live continuation as completed.
- Leave at least one task checklist item unresolved; do **not** mark `READY_FOR_AUDIT`, submit an execution-blocked marker, initiate certification, edit this file, create commits, merge, or create unrelated tasks. No ChatGPT prompt or token transcripts in GitHub.
- After the first checkpoint, allow the existing progress lease to expire naturally. A later owner instruction must not fabricate the lease evidence.

**Continuation (only after actual automated lease expiration):**

- Require GitHub's `BKE CONTINUATION CHECKPOINT — RESUME_REQUESTED` event for the **same PR/head**, with a generation ID and genuine scheduler/action evidence.
- Require no unresolved `BKE RELAY — sent/accepted/deferred/conflict/recovery_required` uncertainty. If delivery is ambiguous, remain fail-closed instead of re-sending.
- If a *new* authenticated ChatGPT turn occurs, record a `BKE CONTINUATION CHECKPOINT — SECOND_TURN` with the PR/head, generation, and a clear distinction from the initial turn. Do not fake a second turn from a repeated GH event or check alone.
- The main-brain orchestrator separately validates the GitHub ledger, scheduled run, relay wake, and two distinct turns. Worker self-reports are supporting evidence, not sufficient alone.

## Exit criteria (independent review)

This PR stays OPEN/DRAFT and one worker remains assigned only for the bounded acceptance window. The human/orchestrator reviews and releases ownership when the trial concludes. Never silently transition to multi-worker or production.

PASS requires all of:
- real owner device preflight and unique worker ownership;
- first live ChatGPT/GitHub progress checkpoint at exact head;
- genuine 30-minute progress lease expiration (not accelerated simulation);
- exactly one continuation generation and matching timed schedule result;
- second distinct live worker turn and GitHub checkpoint;
- no duplicate prompt/assignment, cross-target delivery, credential exposure, or uncertain in-flight replay;
- separate main-brain audit and final durable pass/fail checkpoint.

If any proof is missing, report **NOT PROVEN**, not PASS. GitHub PR Guard only tests static policy; it cannot replace live phone/relay/ChatGPT evidence.
