# BKE F1-02 — Claim and receipt contract (proposed v1)

**Status:** Source-only design proposal, not an approved live protocol.  
**Authority:** [Worker #121 adopted design v2.1](https://github.com/jan2xo/bke-worker/issues/121) and [F1-02 task #123](https://github.com/jan2xo/bke-worker/issues/123).  
**Scope:** Document the distinction between an irreversible pre-send claim and optional post-send evidence. No secrets, provider writes, browser reads or worker activation.

## Safety invariants

1. A ticket is an independently retrieved `bke-ticket` GitHub check run with the exact pinned dispatcher App ID and slug, current PR head, unexpired attempt identity and assigned worker. `github-actions` or missing/mismatched metadata always reject; concurrent valid unconsumed tickets on one head halt.
2. A claim is an immutable GitHub ref `refs/bke/claims/{pr}/{attemptId}`, created **before** submitting anything to ChatGPT. Its target is the **pinned PR head commit**. The ref itself cannot store a future conversation URL, and it must never be rewritten, reused, deleted or used as a status scratchpad.
3. Winning an atomic create (201), reading the claim back, and rechecking head/worker/attempt authority permit **at most one local dispatch attempt**; they do not prove browser delivery or ChatGPT completion. Duplicate ref, 422 ambiguity, timeout, missing readback, stale head, wrong worker, expired ticket, lost write acknowledgement or uncertain provider state mean HALT WITHOUT RETRY.
4. A separate **post-send receipt** records safe URL metadata for the same ChatGPT conversation only after it is actually observed, never by reading response text, reply/message-list content, cookies, authentication or browser profile secrets.
5. The only MVP continuation accepted by #149 is a **second turn in the same conversation**, from a distinct authorized attempt/claim. After process restart, absent or inconclusive receipt/target matching halts, never guesses a different conversation.

## Versioned evidence fields (candidate)

**Ticket (pre-send):** contract version; GitHub check-run ID; pinned issuer `app.id` and `app.slug`; repository; PR; exact head SHA; worker ID; attempt ID; expiry. Source-only validators do not themselves authenticate the HTTP response or prove App control.

**Claim (pre-send):** GitHub ref `refs/bke/claims/{pr}/{attemptId}` target = that exact PR head; record the creation result and authoritative readback; correlate ticket ID, PR, attempt and head in independently attributable GitHub evidence, without rewriting the claimed commit. Claim-ref creation should have a unique single-consumer attempt ID.

**Receipt (post-send):** version, repository, PR, ticket check-run ID, attempt ID, claimed ref, pinned head SHA, observed `https://chatgpt.com/c/{conversationId}` URL (normalized without queries/fragments), timestamp and event type (first send vs same-chat continuation). All input-only: only the page URL may be observed, never message text or reply DOM. A `click()` return is an attempted action, not a remote delivery acknowledgement.

**Subsequent GitHub effect:** an attributable later commit or issue/PR comment quotes the ticket check-run ID and attempt ID plus expected PR/head; validate timing and provenance separately. A quotation alone can be forged by a writer and is not proof of browser delivery.

## Correlation and acceptance

The required chain is:

`trusted ticket -> exact-head claim ref + readback -> single browser submit attempt -> separate receipt (same conversation URL) -> later GitHub effect quoting ticket/attempt`

For the owner-watched two-turn experiment, require two distinct ticket+claim attempts bound to a single isolated worker/PR/profile and **the same observed conversation URL**, with no third send, no replay and a working HALT. Each transition must be independently checked; a missing or inconsistent link fails closed. A commit/comment proving activity is not automatically a proof of ChatGPT response or causality.

## Receipt storage alternatives — owner decision required

Option A — **PR issue comment:** append a sanitized structured receipt to the existing PR ledger. Easy to inspect and already native to GitHub; comments are editable/deletable by authorized actors and are **not** immutable delivery proof. Validate author and avoid exposing authentication/session metadata.

Option B — **separate Git commit/ref:** create a purpose-specific receipt commit/ref without changing the immutable claim ref. Stronger commit identity and immutable-by-hash payload, but refs can still be changed with permission and adds Git write complexity; design uniqueness and atomicity before choosing.

Option C — **App-owned check-run/output:** authorized dispatcher App publishes/updates a distinct receipt check run, preserving exact issuer provenance. App permission, execution timing and output mutability require independent certification; never confuse this with the ticket itself.

**No selection is made here.** The owner must approve receipt location, issuer and ownership/retention rules before any live integration.

## Halt / quarantine conditions

- Any absent or non-pinned App ticket, expired ticket, malformed contract version, consumed ticket, duplicate valid unconsumed ticket, wrong worker, wrong PR/head or missing owner mandate.
- Ref exists, non-201 create, 422 with uncertain reason, write timeout, lost result, readback mismatch, remote outage or revocation.
- Claim won but the serialized browser controller is busy, the target/profile/tab changed, the strict input composer is missing, send result is uncertain, or any click might have happened before an exception.
- Missing, contradictory, unverifiable or changed conversation URL across the second wake; no reply/output scraping to resolve the uncertainty.
- Missing later GitHub effect, unexpected extra send, failed halt switch, failed exact-head CI or unprotected required gate.

## Not yet certified

Real dispatcher App identity/token scope, negative PAT/`GITHUB_TOKEN` rejection test in an owner-approved disposable PR, atomic live ref create + duplicate rejection + readback, native-host credentials, strict browser dispatch, receipt authority/storage, no-replay across restarts and two independent user-watched/unattended-turn observations. This document neither changes those gates nor authorizes a send.
