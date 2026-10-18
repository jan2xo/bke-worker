# GitHub App catalog: historical zero-optional-grant hypothesis (superseded)

> **SUPERSEDED — 2026-10-19:** The conclusion below that `permissions: {}` is a safe, proven least-privilege token request was **not established**. The owner still received `GITHUB_CATALOG_TOKEN_GRANT_REJECTED` after deploying PR #100. GitHub documents that omitted restrictions result in inherited installation grants, and an empty permissions map should not be treated as positive proof that GitHub applied a restriction. The active catalog contract now requires an explicit token mint request `{ permissions: { metadata: "read" } }` and an exact returned grant `{ metadata: "read" }`. See `docs/admin-catalog-explicit-metadata-only.md`. Historical content below is retained for audit and must not be reused as an operating recommendation.

---
## Verified source and provider contract

Owner’s authenticated PREPRODUCTION Command Center now reports `GITHUB_CATALOG_TOKEN_GRANT_REJECTED`. Worker relay source emits this only **after** GitHub returned an accepted installation-token response whose bearer format and expiry passed independent checks; its returned `permissions` object was not exactly `{ "metadata": "read" }`. The response's exact content was **not observed**, and no actual GitHub bearer or grant object was read or logged.

GitHub's official REST docs for `GET /installation/repositories` state that **a GitHub App installation token requires no optional repository permissions** for this listing. GitHub's token-issuance endpoint permits specifying reduced permission grants via the `permissions` body parameter. Our issuance request already explicitly supplies `{ "permissions": {} }`, never omits the parameter or asks for write/read grants.

The old relay verifier incorrectly required the returned granted permissions to contain **exactly one** entry `metadata: read`. That rejects an equally safe zero-optional-grant response `{}`, even though GitHub documents that the catalog endpoint requires no extra permission.

## Narrow security correction

Accept an issued permission attestation only when it is a JSON object with:

- **zero keys**: `{}`; or
- **exactly one key**: `{ "metadata": "read" }`.

Reject **all** other permission objects, including any `contents: read`, `issues: read`, any write grant, unexpected key, metadata-write, null, missing or malformed permissions object. The relay remains fail closed on ambiguous token issuer, improper `ghs_` bearer shape, invalid TTL, invalid repository identities, duplicate/truncated pagination, or unavailable GitHub API. The temporary installation token remains **inside the private relay** and is never sent to Command Center, GitHub PRs or logs.

GitHub App installation repository selection remains the **existing owner-approved scope only**, not an invitation to install the App into new repositories. This remains metadata-only repo enumeration; actual source-content access requires its own separately certified least-privilege grant.

**Confidence boundary:** the browser's `GRANT_REJECTED` is consistent with the empty-object mismatch, but until live acceptance succeeds we cannot assert that GitHub actually returned `{}`. If the same error persists, stop and investigate classification through non-sensitive proof—not raw grant dumps or accepting additional permissions.

## Source certification and release

Full required exact-head `/certify relay` plus PR Guard; tests prove that `{}` and `metadata:read` both list existing approved repos while all other read/write permissions are denied before GitHub catalog fetch. Independent exact-head review, SHA-locked merge.

Only human-authorized **BKE Worker relay PREPRODUCTION** deployment of exact merged main after source certification; no Command Center deployment or secret change is necessary because existing safe failure codes and Admin auth remain compatible. Live human Admin signs in manually and confirms the authorized repository inventory. If still blocked, keep the grant check strict and inspect the next safe code.

Cloudflare API connector can inspect and manage versions/deployments and secret bindings, but publishing new bundled Worker source uses the separate `multipart/form-data` Version Upload API; it is **not equivalent** to activating an already uploaded version. A fully unattended GitHub-built exact-SHA release chain is a future independent intent, not a reason to bypass current source/provenance checks.

No production, browser-profile, Android, App installation expansion, credential rotation, or authentication automation.
