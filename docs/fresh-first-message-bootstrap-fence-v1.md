# First-message bootstrap and durable fence — source-only contract

## Scope and status

Issue #119 adds a pure TypeScript evaluator for the case where a brand-new ChatGPT conversation does not receive a stable /c/<conversation-id> until after the first user message. It complements the fresh-conversation gate from merged PR #118 without weakening that gate or changing existing extension actors.

This is a source-only state contract. It does not call GitHub, create a commit/ref, navigate a browser, send a message, register a host, change permissions, inspect a profile, assign a worker, or alter PREPRODUCTION/production. The evaluator returns only BLOCKED or CANDIDATE_ONLY and always sets authority to NONE. A well-formed synthetic fixture is not authenticated evidence.

## State model

- UNAUTHORIZED: no valid GitHub-backed authorization for this attempt.
- AUTHORIZED_PREPARE: the exact attempt, open PR/head, one worker assignment, completed prior attempt and complete prior-conversation history are consistent. This state permits only a candidate to re-evaluate the landing page and arrange the durable fence.
- FENCED_READY_TO_SEND: the durable pre-send fence has been committed and read back for this exact attempt, worker, head, execution, target/profile/tab and generation. It is still NOT_SENT and has no consumed send claim; this state is not a send permit.
- FENCED_MAY_HAVE_SENT: the future trusted adapter has durably consumed the one-shot opportunity via an atomic GitHub compare-and-swap (CAS) and read it back before invoking submission. Once this claim exists, the first message may have been sent; a crash makes delivery uncertain, and this state cannot produce another send candidate.
- CONFIRMED_NEW_CONVERSATION: a post-send observation proposes a stable new conversation ID for the fenced attempt, not in GitHub-backed prior history.
- DELIVERY_UNCERTAIN: a crash/restart occurs after the one-shot send claim is consumed, or the send result becomes ambiguous. Do not retry the first message or open a second chat under the same attempt.
- BLOCKED: evidence is missing, conflicting, stale, reused or malformed.

Transitions are projections, not mutations. A candidate result never writes the GitHub ledger. A future trusted adapter must commit the transition to GitHub and read it back before acting.

## Two-stage first-message boundary

1. PREPARE requires the GitHub authorization projection, exactly one worker/PR assignment, complete dense unique prior-conversation history, a resolved prior attempt, and the owner-selected isolated target at a fresh visible idle NEW CHAT landing surface. Landing page means exactly https://chatgpt.com/, not a prior /c/<id> thread. PREPARE does not authorize sending.
2. The future adapter must atomically commit the durable pre-send fence to GitHub before any submission and read it back as FENCED_READY_TO_SEND / NOT_SENT. This first commit binds the immutable PR head, attempt ID, worker, target/profile/tab, execution ID and fence generation. No local-memory flag or page assertion substitutes for the durable record.
3. VERIFY_FENCE_COMMIT only proposes FIRST_SEND_CAS_CANDIDATE when the fence remains FENCED_READY_TO_SEND / NOT_SENT, the matching durable fence and fresh commit receipt validate, and no sendClaim is present. It is a request to attempt the next provider operation—not a first-message candidate, submission permit, or send authority.
4. Before calling the browser send API, the future trusted adapter MUST atomically CAS the GitHub ledger from FENCED_READY_TO_SEND / NOT_SENT with no sendClaim to FENCED_MAY_HAVE_SENT / MAY_HAVE_SENT, attaching a unique durable sendClaim bound to the exact fence, attempt, worker, head, execution and target. It must read back the winning claim. Only the actor that wins this CAS may invoke one send, and only after read-back. Competing/replayed CAS attempts must fail; they may not submit.
5. The durable sendClaim is an irreversible consumed marker for that attempt. The evaluator blocks PREPARE, VERIFY_FENCE_COMMIT, recovery and other send-related events after it exists, including when a caller's state fields appear to have regressed. A future adapter must always re-read provider-authenticated current GitHub state rather than rely on cached observations. A non-durable/in-memory claim or browser receipt is never a substitute for provider CAS.
6. After the CAS has been consumed, a crash—even one occurring before the actor can prove whether the browser call started—must recover as DELIVERY_UNCERTAIN. Do not retry the same attempt or open another chat. Reconciliation or a new owner-authorized attempt is required. A restart before CAS may only re-read the current provider state and compete for the CAS; it must never send based on a cached candidate.
7. Only after a first-message send may the surface provide a stable /c/<id>. CONFIRM_NEW_CONVERSATION requires a receipt bound to the same durable sendClaim ID/SHA, exact fence and attempt, observed thread URL, timestamps after the claim, and complete prior-ID set. Reusing any prior conversation fails closed. This merely proposes CONFIRMED_NEW_CONVERSATION; a separate authenticated adapter must persist the new conversation ID to GitHub and verify that durable record.

## Fail-closed guarantees and deliberate limitations

- Wrong repository, PR, current head, worker, attempt, multi-assignment, closed PR or unresolved previous attempt block.
- Missing, truncated, duplicate, sparse, inherited-index, undefined or malformed conversation history blocks.
- Shared profiles, mismatched target/profile/tab, multiple writable target matches, authentication-required UI, busy UI, unexpected URLs and stale observations block.
- A missing/non-durable fence, wrong commit SHA, wrong attempt/head/worker/target, wrong execution, generation replay or stale commit receipt cannot become a CAS-claim candidate.
- A consumed sendClaim marker blocks a second candidate even if stale caller-projected state fields say NOT_SENT. The actual guarantee that only one actor wins remains the future trusted GitHub CAS provider's responsibility.
- A post-send ID already present in prior history is rejected. A caller-created receipt, including a coherent forged fence/claim fixture, can only result in CANDIDATE_ONLY with authority NONE.
- The state evaluator is pure and cannot guarantee atomicity or one-shot behavior itself. A future adapter must atomically CAS FENCED_READY_TO_SEND / NOT_SENT to FENCED_MAY_HAVE_SENT / MAY_HAVE_SENT, persist and read back a claim before send, and fail closed on conflict, stale reads or uncertainty. The GitHub/native/browser provenance boundary does not exist in this PR.
- This source does not assume ChatGPT issues /c/<id> before first send. The source contract explicitly accommodates ID allocation after the first message but fails closed when no trusted fenced attempt or post-send identity evidence exists.

## Certification plan

Required exact-head proof: cheap PR Guard for the WebExtension path, TypeScript build, manifest validation, all WebExtension tests and native-host contract tests. Broad Android, relay or deployment certifications are not causal for this source-only module. No new workflow or permission is introduced.

## Explicitly not certified here

- Authenticated GitHub provider, complete history reader, conditional durable fence writer/read-back, atomic one-shot send-claim CAS provider/read-back, and trusted durable claim provenance.
- Actual Chrome/GeckoView target isolation, browser-controller provenance, ChatGPT navigation/first-message behavior, stable ID allocation timing, or real send/uncertain-delivery recovery.
- Worker enrollment, automatic queue dispatch, host registration, nativeMessaging permission grant, credentials, Cloudflare, PREPRODUCTION or production activation.

Issue #119 and the PR body/comment are the durable execution contract. The manual wake is the only start mechanism for this lane. Do not self-approve or merge; stop for independent GPT-6 review after exact-head certification.
