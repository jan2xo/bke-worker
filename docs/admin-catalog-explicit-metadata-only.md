# BKE Admin — explicit metadata-only GitHub installation token (active contract)

## Evidence and correction

After exact-head Worker PRs #98–#100 and PREPRODUCTION relay version 74, the allowlisted human Admin still received `GITHUB_CATALOG_TOKEN_GRANT_REJECTED`. The relay reported that the GitHub App installation token bearer and TTL passed, but the returned `permissions` grant was **not** `{}` or exactly `{metadata:"read"}`. The raw GitHub permissions object was **not viewed**.

Root source contract hazard: The relay token mint request used `{ permissions: {} }` on `POST /app/installations/{installation_id}/access_tokens`, intending to request no optional privileges. GitHub's official REST API documents that installation tokens inherit the App's grants when the `permissions` restriction is not supplied; the API explicitly supports requesting `metadata:"read"`. An empty object is **not trustworthy evidence that GitHub reduced inherited privileges**. Accepting an empty returned grant solely by shape was not justified and did not resolve the live issue.

The safe correction is to ask GitHub **explicitly** to mint only:

```json
{ "permissions": { "metadata": "read" } }
```

Only proceed to `GET /installation/repositories` if the HTTPS issuance response attests **exactly** `{"metadata":"read"}`. Reject `{}`, missing/malformed permissions and any extra read/write grant (including optional read). The catalog route requires no additional permission, but we require a positively attested metadata-only token rather than taking the risk of accidentally inheriting dispatcher write scopes.

Official GitHub references:
- [Create installation access token](https://docs.github.com/en/rest/apps/apps?apiVersion=2026-03-10#create-an-installation-access-token-for-an-app): permission restrictions via the `permissions` parameter, defaults and `metadata` parameter.
- [List repositories accessible to app installation](https://docs.github.com/en/rest/apps/installations?apiVersion=2026-03-10#list-repositories-accessible-to-the-app-installation): installation token, no additional fine-grained optional permissions needed.

## Security boundaries retained

- The same installed GitHub App, installation chosen by canonical existing repository lookup; no App reinstallation, no broadening of selected repositories or permissions.
- Installation token stays **only** in private Cloudflare relay; Command Center receives validated metadata-only repository names and links through named Worker RPC. No raw token, permissions object, emails, JWT material or private key exposed.
- Separate existing dispatcher write-token path and separate fixed repository read-token broker are unchanged.
- Existing 2–61-minute TTL and opaque header-safe `ghs_` bearer checks stay intact; incomplete/duplicate GitHub catalog response remains fail closed.
- If GitHub *rejects the explicit metadata request*, fail closed with existing issuance code. If GitHub still returns unexpected grants, fail closed with `ADMIN_CATALOG_TOKEN_GRANT_INVALID` / `GITHUB_CATALOG_TOKEN_GRANT_REJECTED`. **Never** fall back to `permissions: {}`, an omitted permissions body, a PAT or a write-scoped installation token.
- Negative tests prove a token with inherited full App write grants is rejected even though the token request was explicit, and the catalog endpoint is never called with that credential.

## Proof and rollout

One fresh Worker PR from current main, automatic PR Guard, exact-head `/certify relay` Cloudflare durable relay + Required certification, independent least-privilege review, and SHA-locked squash merge when ACCEPT.

A code merge does not update Cloudflare. Verify a PREPRODUCTION relay version with the explicit `metadata:"read"` token request is uploaded and deployed at 100%, then human Admin visits `https://cc.jl-bke.com/admin` for live success. A built-in release-provenance verification is preferred; the Cloudflare connector's version/deployment API cannot replace the multipart source upload/build automatically. Do not claim acceptance from CI or a deployment timestamp alone.

**Never deploy to production, mutate GitHub App permissions, expose token contents, automate login/MFA or wake Android as part of this fix.**
