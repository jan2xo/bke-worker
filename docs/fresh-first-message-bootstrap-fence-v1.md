# First-message bootstrap and durable fence — source-only contract

## Scope and status

Issue #119 adds a pure TypeScript evaluator for the case where a brand-new ChatGPT conversation does not receive a stable /c/<conversation-id> until after the first user message. It complements the fresh-conversation gate from merged PR #118 without weakening that gate or changing existing extension actors.

This is a source-only state contract. It does not call GitHub, create a commit/ref, navigate a browser, send a message, register a host, change permissions, inspect a profile, assign a worker, or alter PREPRODUCTION/production. The evaluator returns only BLOCKED or CANDIDATE_ONLY and always sets authority to NONE. A well-formed synthetic fixture is not authenticated evidence.

## State model

- UNAUTHORIZED: no valid GitHub-backed authorization for this attempt.
- AUTHORIZED_PREPARE: the exact attempt, open PR/head, one worker assignment, completed prior attempt and complete prior-conversation history are consistent. This state permits only a candidate to re-evaluate the landing page and arrange the durable fence.
- FENCED_MAY_HAVE_SENT: a durable GitHub fence has been observed for this exact attempt, worker, head, execution, target/profile/tab and generation. The state name is intentionally conservative: once the durable fence is written, a crash can make the message outcome unknowable.
- CONFIRMED_NEW_CONVERSATION: a post-send observation proposes a stable new conversation ID for the fenced attempt, not in GitHub-backed prior history.
- DELIVERY_UNCERTAIN: a crash/restart or unknown send result occurred after the fence. Do not retry the first message or open a second chat under the same attempt.
- BLOCKED: evidence is missing, conflicting, stale, reused or malformed.

Transitions are projections, not mutations. A candidate result never writes the GitHub ledger. A future trusted adapter must commit the transition to GitHub and read it back before acting.

## Two-stage first-message boundary

1. PREPARE requires the GitHub authorization projection, exactly one worker/PR assignment, complete dense unique prior-conversation history, a resolved prior attempt, and the owner-selected isolated target at a fresh visible idle NEW CHAT landing surface. Landing page means exactly https://chatgpt.com/, not a prior /c/<id> thread. PREPARE does not authorize sending.
2. The future adapter must atomically commit the durable pre-send fence to GitHub before invoking any first-message submission. The commit must bind the same immutable PR head, attempt ID, worker, target/profile/tab, execution ID and fence generation. No local-memory flag or page assertion can substitute for a durable commit.
3. VERIFY_FENCE_COMMIT only proposes FIRST_MESSAGE_CANDIDATE when the record is already FENCED_MAY_HAVE_SENT, its fence has a full commit SHA, all bindings match, and a matching commit-return receipt confirms the write occurred in the same live execution. This is a consistency check, not authenticated proof or send authority.
4. If the live invocation crashes/restarts after the fence, or submission may have occurred and its outcome is not proved, RECOVER_AFTER_RESTART / MARK_DELIVERY_UNCERTAIN returns BLOCKED with DELIVERY_UNCERTAIN. Never automatically resubmit, open another conversation, change worker, or reuse the same attempt. Owner-authorized recovery needs a new attempt ID and fresh conversation after the ambiguous attempt has been reconciled or explicitly dispositioned.
5. Only after the first message may the surface provide a stable /c/<id>. CONFIRM_NEW_CONVERSATION checks the actual observed thread URL against a matching post-send receipt, exact fence and attempt bindings, timestamps after the fence, and the complete prior-ID set. Reusing any prior conversation fails closed. This merely proposes CONFIRMED_NEW_CONVERSATION; a separate authenticated adapter must persist the new conversation ID to GitHub and verify that durable record.

## Fail-closed guarantees and deliberate limitations

- Wrong repository, PR, current head, worker, attempt, multi-assignment, closed PR or unresolved previous attempt block.
- Missing, truncated, duplicate, sparse, inherited-index, undefined or malformed conversation history blocks.
- Shared profiles, mismatched target/profile/tab, multiple writable target matches, authentication-required UI, busy UI, unexpected URLs and stale observations block.
- A missing/non-durable fence, wrong commit SHA, wrong attempt/head/worker/target, wrong execution, generation replay or stale commit receipt cannot become a first-message candidate.
- A post-send ID already present in prior history is rejected. A caller-created receipt, including a completely coherent forged one, can only result in CANDIDATE_ONLY with authority NONE.
- The state evaluator is pure and cannot guarantee atomicity or one-shot behavior itself. The future adapter must perform GitHub compare-and-swap/conditional fencing, commit before send, send at most once in the same live invocation, and treat uncertainty as terminal. The GitHub/native/browser provenance boundary does not exist in this PR.
- This source does not assume ChatGPT issues /c/<id> before first send. The source contract explicitly accommodates ID allocation after the first message but fails closed when no trusted fenced attempt or post-send identity evidence exists.

## Certification plan

Required exact-head proof: cheap PR Guard for the WebExtension path, TypeScript build, manifest validation, all WebExtension tests and native-host contract tests. Broad Android, relay or deployment certifications are not causal for this source-only module. No new workflow or permission is introduced.

## Explicitly not certified here

- Authenticated GitHub provider, complete history reader, conditional durable fence writer/read-back, or live atomic compare-and-swap.
- Actual Chrome/GeckoView target isolation, browser-controller provenance, ChatGPT navigation/first-message behavior, stable ID allocation timing, or real send/uncertain-delivery recovery.
- Worker enrollment, automatic queue dispatch, host registration, nativeMessaging permission grant, credentials, Cloudflare, PREPRODUCTION or production activation.

Issue #119 and the PR body/comment are the durable execution contract. The manual wake is the only start mechanism for this lane. Do not self-approve or merge; stop for independent GPT-6 review after exact-head certification.
