## Description

<!--
Describe what this PR changes, why the change is needed, and the user/system behavior it enables.

Keep this section readable for a human reviewer.
Do not use the PR description as a chronological execution log.
Detailed BKE execution checkpoints, stale CI generations, debugging history,
artifact hashes, and merge verification belong in PR comments.

BKE WAVE RULE:
One independent engineering intent belongs in one PR.
When this intent is complete, the next independent wave must start from current
main on a fresh branch and open a new PR using this template.
Do not reuse an old/merged feature branch for a new intent.
-->

This PR ...

Fixes #<!-- issue number, if applicable -->

---

## Type of change

- [ ] Bug fix (non-breaking change which fixes an issue)
- [ ] New feature (non-breaking change which adds functionality)
- [ ] Breaking change (fix or feature that changes an existing contract or behavior)
- [ ] Documentation update
- [ ] Performance improvement
- [ ] Code refactoring
- [ ] Tests
- [ ] CI / certification
- [ ] Packaging / release infrastructure
- [ ] Security / trust-boundary change

---

## How Has This Been Tested?

<!--
Describe the behavior that was actually tested or certified.
Do not mark scenarios complete until the corresponding proof exists.
-->

### Tested Scenarios

- [ ] ...
- [ ] ...
- [ ] ...

### Certification

- **Exact head:** `<SHA>`
- **Required certification:** `<contracts / core / parent / module names>`
- **Result:** `PENDING / PASS`

<!-- Add workflow run IDs after certification has actually completed. -->

---

## Architecture / Security

<!-- Remove this section when genuinely not applicable. -->

- **Ownership boundaries affected:**
  - BKE Launcher:
  - Licensing Agent:
  - Digital Solutions:
  - GitHub / release authority:
- **Authentication / authorization impact:** None / ...
- **Persistence / migration impact:** None / ...
- **Packaging / signing / provenance impact:** None / ...
- **Fail-closed behavior:** None / ...
- **Cross-repository dependencies:** None / `repo@exact-SHA`

---

## Screenshots (if applicable)

<!-- Required for meaningful user-visible UI changes when screenshots are practical. -->

### Before

<!-- image -->

### After

<!-- image -->

---

## Checklist

- [ ] My code follows the conventions and ownership boundaries of this project
- [ ] I have performed a self-review of my changes
- [ ] I have added screenshots for meaningful UI changes where practical
- [ ] I have updated documentation where needed
- [ ] My changes introduce no new unexplained warnings
- [ ] I have added or updated tests/certification that prove the changed behavior
- [ ] Required cross-repository dependencies are pinned to immutable SHAs/releases where applicable
- [ ] The minimum complete certification graph is declared
- [ ] Required certification passed on the exact current head before merge
- [ ] Production/security locks remain respected unless explicitly authorized
- [ ] This PR contains one coherent engineering intent; the next independent wave will use a fresh PR from current `main`

---

## Additional context

<!--
Add implementation notes, tradeoffs, compatibility considerations,
migration details, or follow-up work that helps reviewers understand the change.

Do not turn this section into a CI transcript.
-->

---

## Certification Notes

<!--
Keep this short and intent-focused.

PR description = human-readable change record.
PR comments = durable BKE execution ledger.

Use PR comments for:
- BKE EXECUTION CHECKPOINT — IMPLEMENTED
- BKE EXECUTION CHECKPOINT — CERTIFIED
- BKE EXECUTION CHECKPOINT — MERGED
- exact SHAs
- certification run IDs
- artifact hashes/provenance
- stale-generation notes
- final merge verification
-->

**Required:**
- ...

**Not required:**
- ...

**Reason:**
<!-- Brief ownership/risk explanation. -->

**Environment:**
`DEVELOPMENT / PREPRODUCTION / PRODUCTION`
