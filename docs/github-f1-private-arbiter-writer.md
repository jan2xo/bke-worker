# F1-02 — server-private real GitHub REST arbiter writer (dormant)

**Owner-authorized shipping mission:** [FORGE F1 #121](https://github.com/jan2xo/bke-worker/issues/121). **Independent engineering issue:** [F1-02 #123](https://github.com/jan2xo/bke-worker/issues/123). This file documents the **implementation currently available**, not a live F1 enrollment/authorization or complete F1-02 gate.

## Concrete implemented improvement

`scripts/github_f1_private_arbiter_writer.py` implements real GitHub REST message construction using Python's HTTPS client. Unlike prior `publish_by_fast_forward` source callback model, this code has an actual fixed-endpoint wire adapter:

1. GET the **existing, fixed** `jan2xo/bke-worker` ref `refs/heads/bke/control-claims-v1`.
2. GET exact commit → one-file tree → Git blob and compare canonical JSON and Git blob SHA-1; GET ref again and require same SHA.
3. Parse existing `github_atomic_claim.py` manifest and validate an **append-only successor** or an irreversible uncertainty fence. No invented new manifest authority.
4. POST canonical Git blob, a one-file tree, then a **single-parent child commit**. Re-fetch that child and verify exact parent + manifest.
5. PATCH **only** the fixed GitHub ref with `force:false`. A conflicting sibling cannot both fast-forward it.
6. GET the changed ref and reread its exact commit/tree/blob twice. Ambiguous API failure, lost reply, ref race, modified payload, foreign URL/redirect, malformed JSON, parent error or conflict is **BLOCKED**, and cannot authorize a send or trigger an automatic retry.

The transport has **no caller-configurable repository, ref, URL or HTTP opener**. The opener explicitly disables environment proxies, rejects redirects, checks actual response URL and bounds bodies. Errors are sanitized; neither tokens nor provider response content are returned.

**Important:** the default `GitHubAppArbiterWriter(token)` is **READ-ONLY**. Its `publish` method always raises `F1_PROVIDER_LIVE_WRITE_LOCKED`. The `live_writes_enabled=True` capability must only be constructed inside a separately certified **server-private, owner-authorized** GitHub App service principal; it is provided to test the real REST call sequence with disposable fake data in CI, **not turned on anywhere in the repo**.

This source code is a concrete provider adapter, but without a live GitHub App caller it does **not** attest actual installation identity/scope or the truth of PR labels, registered worker sessions, ChatGPT targets or GitHub server reference protection. Even coherent spoofed transport mocks have `assignment_authority=NONE`, `send_authority=NONE`, `dispatch_authority=NONE` and `wake_authority=NONE`.

## Relationship to existing source and unfinished shipping work

- Uses existing `scripts/github_atomic_claim.py` `_validate_successor` and `validated_manifest`, shared ref `bke/control-claims-v1` and canonical `claims-v1.json`; **does not create a new ref/task database**.
- Does **not** pull code from or merge [PR #117](https://github.com/jan2xo/bke-worker/pull/117), which has a prior GitHub tool **safety merge block**. It is a separately bounded fixed HTTPS write adapter under pre-authorized [#123](https://github.com/jan2xo/bke-worker/issues/123); no bypass of #117 or force pushes.
- The existing arbiter manifest v1 models worker **RESERVED/DELIVERY_UNCERTAIN**, not the full first-message `FENCED_READY_TO_SEND / MAY_HAVE_SENT` claim model in merged [#120](https://github.com/jan2xo/bke-worker/pull/120). This PR **does not pretend** these are the same atomic record. The additional attempt-specific durable send-once schema and authenticated binding to `bootstrap-fence.ts` remain F1-02 work.
- No operational integration into Cloudflare relay, WebExtension, serial dispatcher, Chrome, PR labels, a real GitHub app token or human ChatGPT profile.
- **Owner/security prerequisites:** verified server-private GitHub App principal and complete installation repository scope; approved nonproduction disposable ref/repository for first real authenticated GET/POST/PATCH/read-back; ref initialization and anti-rollback protections; PR label reconciliation, worker/session lease; service-personnel permissions; GitHub production ruleset checks if available. [CC #30](https://github.com/jan2xo/bke-command-center/issues/30) separately governs enrollment/credential issuer.
- **PREPRODUCTION and production remain LOCKED.** No token issuance, remote Git ref write, Chrome permission, deployment or prompt send is authorized by merging the source.

## Required verification before integration or enabling live writes

- Adversarial CI regression suite `tests/github_f1_private_arbiter_writer_contract.py`, invoked through the existing cheap `tests/github_atomic_claim_contract.py` PR-Guard entrypoint: deterministic GitHub REST wire mocks, fixed ref, no-force PATCH, competing sibling, lost response after ref movement, malicious wrong child parent, wrong ref/missing ref, schema alteration, redirect and off-origin rejection, duplicate JSON, blob tamper, disabled-by-default lock and fixed credentialed transport. CI mocks **are not GitHub provider acceptance**.
- BRO-KODE independently reviews source exact head/security boundaries and certifies scope.
- Operator must **separately approve** live GitHub App provider/disposable-ref trial and any server-principal changes before F1-02 can be declared fully integrated. Until that proof and the first-message CAS ledger are present, **F1-02 remains BLOCKED for final live acceptance; F1-04 cannot send.**
