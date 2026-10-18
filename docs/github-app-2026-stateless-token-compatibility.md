# GitHub App installation token compatibility — October 2026

**Live PREPRODUCTION symptom:** authenticated Command Center Admin displayed `GITHUB_CATALOG_TOKEN_PERMISSION_REJECTED` after the catalog broker error-diagnostic update. The relay's `ADMIN_CATALOG_TOKEN_SCOPE_INVALID` check combined token shape, remaining lifetime, and granted permission response. We cannot claim which subcondition failed from that code alone.

**Verified upstream change:** GitHub's [October 2, 2026 rollout completion](https://github.blog/changelog/2026-10-02-stateless-github-app-installation-tokens-rolled-out/) states newly minted GitHub App installation tokens now use stateless `ghs_APPID_JWT` format, roughly 520 characters and containing JWT punctuation. GitHub recommends treating bearer strings as opaque and not making application logic depend on the contents. Our relay previously used `/^ghs_[A-Za-z0-9_]+$/` in BOTH the installation-repository catalog and separate read-only broker. That excluded legitimate stateless tokens containing dots or hyphens. This change removes that unsupported format assumption.

The new validator checks only a `ghs_` installation-token prefix, bounded bearer length, and absence of whitespace/HTTP control characters. It never decodes JWT payloads, validates GitHub-internal JWT signatures, parses token claims, or logs/returns the token to the Admin page. Actual authorization still comes from GitHub's HTTPS token issuance response and the existing strict scope/expiry checks.

**Security preserved:**
- Catalog mints token with **explicit `permissions: {}`** and retains its strict returned-grant requirement: exactly `{metadata: "read"}`. No additional read or write permission is accepted.
- Existing GitHub App installation remains restricted to the installation-approved repositories; the broker does not add repositories or permissions.
- Catalog access token remains inside the relay and is used only on `GET /installation/repositories`, never returned in Command Center RPC responses.
- Existing read-only token broker continues to issue a fixed repository ID and `contents/issues/pull_requests:read`; dispatcher write-token path is unchanged.
- Tests exercise synthetic old and new bearer formats and reject extra permission grants, non-installation tokens, injected whitespace/CRLF, and implausibly long values. All test tokens are dummy strings.

**Required certification:** exact-head PR Guard and full `/certify relay` (Cloudflare durable relay, catalog negative tests, Android/relay boundary, Required gate), independent security audit, SHA-locked source merge.

**Rollout:** deploy **BKE Worker relay PREPRODUCTION only** from exact merged `main` after source certification and keep Command Center and its existing Admin bindings untouched. The owner refreshes authenticated Admin; a successful catalog response must list only repositories already approved for the existing GitHub App. If `GITHUB_CATALOG_TOKEN_PERMISSION_REJECTED` persists, do not weaken the grant requirement: investigate separate permitted safe diagnostics for token-format/TTL/grant subconditions without exposing secrets.

No production deployment, key rotation, App installation mutation, Android wake, human login automation, browser-profile access or shared writable browser profile. GitHub PR is the durable execution ledger.
