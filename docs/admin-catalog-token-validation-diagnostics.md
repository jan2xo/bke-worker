# Admin catalog token rejection — exact stage without credentials

## PREPRODUCTION observation

Human Admin at `https://cc.jl-bke.com/admin` still sees `GITHUB_CATALOG_TOKEN_PERMISSION_REJECTED` after PR #98's modern stateless token compatibility source was deployed. GitHub App token issuance returned an HTTP success to the relay, but current relay source groups **three independent checks** into `ADMIN_CATALOG_TOKEN_SCOPE_INVALID`: (1) opaque bearer safety, (2) 2–61 minute remaining lifetime, and (3) exact `{ metadata: "read" }` granted permissions. The live response values remain unknown. Do not infer which condition failed from the old error alone.

## One-intent change

Preserve the three strict conditions and their order. Only replace the combined error with fixed codes:

- `ADMIN_CATALOG_TOKEN_BEARER_INVALID`: invalid `ghs_` class, length, whitespace, or control/header characters. Never reveal token structure or bytes.
- `ADMIN_CATALOG_TOKEN_EXPIRY_INVALID`: unparseable, expired, very short or implausibly distant expiry. Never reveal timestamps.
- `ADMIN_CATALOG_TOKEN_GRANT_INVALID`: returned `permissions` is not an object with exactly one `metadata: "read"` entry. Never expose the returned object or hint at which additional permission is present.

All three failures abort *before* querying `GET /installation/repositories`. Successful grant still obtains only the current installed App-approved repository catalog, no token data in result. Token issuance request remains explicitly `{ permissions: {} }`. No automatic permissions widening, GitHub App reinstallation, source code retrieval, key rotation or GitHub bearer/JWT interpretation.

The Command Center's current safe error whitelist **does not yet include these three new codes**. A *separate fresh Command Center PR* is required to map only these exact broker messages to three fixed Admin-facing labels before user-facing diagnosis is possible. Until both components are certified, merged and deployed in correct order, an unrecognized code must remain generic `GITHUB_CATALOG_BROKER_UNAVAILABLE`. Do not weaken fail-closed behavior to avoid that diagnostic gap.

## Certification and release gate

- Automatic PR Guard.
- Exact-head `/certify relay` including Cloudflare durable relay negative contract and Required certification gate. No extra Android build unless contract requires it.
- Security review: no secrets/errors/permissions leaked; same metadata-only and expiry guarantees; no public token endpoint.
- Exact-head SHA-locked merge (source only).
- Only after separately certified/merged Command Center diagnostic client: targeted **BKE Worker relay PREPRODUCTION** and **Command Center PREPRODUCTION** deployments of their exact main SHAs, followed by human-authenticated Admin page acceptance.
- If the result is `GRANT_INVALID`, inspect *documented* GitHub permission response semantics in a separate bounded intent; never grant write/contents scopes or disclose returned grants to the browser.

No production deployment, token/key rotation, OAuth/MFA/security automation, Android wake or shared writable browser profile. GitHub PR and issue #30 are the durable ledgers.
