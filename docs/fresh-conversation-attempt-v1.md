# Fresh ChatGPT conversation for every engineering attempt — source-only contract v1

## Operator decision and status

- **Decision:** one implementation or remediation attempt gets a **fresh ChatGPT conversation**. The existing human-authenticated GeckoView or desktop WebExtension worker **session persists**. A new conversation must recover the current BKE Worker canonical instructions and its own assigned PR directly from **GitHub**. No previous-chat handoff, manual memory transfer, Notion task queue, prompt transcript or parallel project database.
- **Status:** SOURCE-ONLY, NOT ACTIVATED. This PR implements a pure WebExtension preflight model and adversarial tests only. No extension navigation, new chat creation, GitHub App calls, worker enrollment, permission requests, browser profile access, native-messaging activation or actual prompt delivery.
- **Authority:** GitHub remains the only durable task/assignment/evidence truth. The candidate gate explicitly outputs `authority: "NONE"`; synthetic GitHub observations or forged browser status do not authenticate a principal.

## Candidate evaluation

`evaluateFreshAttempt(input)` can only report `BLOCKED` or `CANDIDATE_ONLY`. It expects separately validated inputs for:

1. One requested `IMPLEMENT` or `REMEDIATE` attempt tied to a repository, exact PR number, full head SHA, worker ID and unique attempt ID.
2. GitHub-derived evidence showing exactly one open PR assigned to that worker and one worker on that PR, matching current head and attempt ID, a resolved previous attempt, and `NOT_SENT` delivery state for this attempt.
3. Exactly one isolated writable ChatGPT browser target whose tab ID matches its observed page, no shared profile, a current visible idle composer on `https://chatgpt.com`, and a status observation no older than 10 seconds (2-second future-clock allowance).
4. Any contradiction, stale head, missing owner, stale/busy/hidden UI, uncertain delivery or unresolved prior attempt **blocks** the candidate rather than opening another chat or retrying an unknown side effect.

Even a fully coherent fake input only produces `CANDIDATE_ONLY`. This pure parser is NOT proof of authenticated GitHub assignment, live browser isolation, real ChatGPT idle state, authorized navigation or permitted send.

## Required integration work before autonomy

- Define a trusted **GitHub-backed attempt record** and atomic claiming/fencing contract. `currentAttemptId`, `previousAttemptResolved` and `currentAttemptDelivery` here are input fields, not currently implemented provider attestation.
- Bind the trusted GitHub reader to the exact verified worker, isolated browser profile/tab and authenticated transport. A page script, browser URL, runtime callback or bare JSON cannot grant authority.
- Implement the separately certified GeckoView and/or desktop WebExtension actor which, *after* trusted preflight and final revalidation, opens **a NEW ChatGPT conversation**, confirms the new conversation target and only then submits a bounded GitHub pointer for the attempt. Never reuse the previous conversation for a distinct attempt.
- Fence before uncertain submit; if the UI crashes after a possible send, fail closed instead of opening a second chat or silently switching worker ownership. UI `IDLE` alone does not mean engineering attempt completion; verify source and CI/PR state from GitHub.
- Human controls ChatGPT authentication, OAuth, MFA, CAPTCHA and permission changes. No shared writable browser profiles, no production/PREPRODUCTION activation without explicit authorization.

## Intentional CI and scope

Changed files: `browser-extension/src/fresh-attempt-gate.ts`, `browser-extension/tests/fresh-attempt-gate.test.mjs`, this document. Existing `PR Guard` automatically selects the WebExtension exact-head Node 22 `npm run check` graph whenever `browser-extension/` changes; no additional workflow or scheduled trigger is added. No large Android, relay or deployment certification is caused by pure source-only code.

This is an independent MVP dependency of GitHub-owned attempt lifecycle, NOT a claim that live multi-worker or browser continuation is complete. Separate Go-owned [PR #116](https://github.com/jan2xo/bke-worker/pull/116), separately accepted-but-merge-blocked [PR #117](https://github.com/jan2xo/bke-worker/pull/117), and owner-gated live Android [PR #90](https://github.com/jan2xo/bke-worker/pull/90) remain untouched.

**Canonical maxim:** GitHub is truth. Worker is liveness and UI transport, not planner. Fresh chat per execution attempt, no handoff.
