# PREPRODUCTION Admin catalog: safe runtime-stage diagnostics

## Observed

Human Admin screenshot, 2026-10-19 06:58 PHT, shows `State: UNKNOWN`, `GITHUB_CATALOG_BROKER_UNAVAILABLE`, after Worker PR #101 merged and explicit metadata-only token mint code was deployed. This is a **generic Command Center safe fallback**, NOT evidence by itself that the Cloudflare service binding, GitHub App installation, or GitHub API is unavailable.

Read-only Cloudflare API confirms:
- Worker relay PREPRODUCTION version 75 `4ad7a154-b89a-4635-9a7c-97bba61b8613`, 100% traffic, with explicit `{permissions:{metadata:"read"}}` issuance and strict exact returned-grant verifier.
- Command Center PREPRODUCTION version 18 `3cb51475-d71b-4b4b-92d3-a6c2a25a8273`, 100% traffic, with private `BKE_GITHUB_READ_BROKER` service binding to `CommandCenterReadBroker`.
- Cloudflare Observability issues summary reports zero detected active issues; read-only time-scoped telemetry query shows **zero ingested log events**, despite aggregate Cloudflare dashboard version-error metrics. The historical exception message cannot currently be reconstructed by reading that data.

## Security-bounded error stages

Preserve the exact GitHub metadata-only request/attestation, installation selection, opaque bearer safety, TTL, catalog data checks and all downstream private RPC interfaces. Add fixed failure codes **only for previously uncategorized runtime exceptions**:

| Relay code | Trigger |
| --- | --- |
| `ADMIN_CATALOG_APP_SIGNING_UNAVAILABLE` | Failed App JWT signing or key import |
| `ADMIN_CATALOG_INSTALLATION_LOOKUP_UNAVAILABLE` | Unexpected runtime failure during installation lookup (known safe GitHub HTTP/status errors preserve prior code) |
| `ADMIN_CATALOG_TOKEN_TRANSPORT_UNAVAILABLE` | Network/Worker fetch exception during mint transport |
| `ADMIN_CATALOG_REPOSITORIES_TRANSPORT_UNAVAILABLE` | Network/Worker fetch exception during permitted installation-repository lookup |

**Important:** No catch may include upstream exception message, provider body, key text, JWT, bearer, request header, URL with secrets, grant object, issuer, email, App ID or installation ID. All diagnostics are constant strings. They do not introduce token endpoints or bypass Access/worker authorization.

Known safe fail-closed domain errors (e.g. `ADMIN_CATALOG_TOKEN_GRANT_INVALID`, `ADMIN_CATALOG_TOKEN_REJECTED`, `ADMIN_CATALOG_REPOSITORIES_UNAVAILABLE`, bounded installation statuses) retain current meanings.

**Integration:** Current Command Center safe mapper intentionally treats unknown codes as generic. A separate fresh Command Center PR must map the new fixed codes to coarse human-Admin-only stages before the next owner smoke can identify failure. Do not expose raw RPC exception text as a shortcut.

## Certification and preproduction release

Fresh current-main Worker PR, PR Guard, exact-head `/certify relay` with Required gate, independent security review, SHA-locked squash merge. Then separate fresh-main Command Center PR, full existing `ci` tests/check/Cloudflare dry-run, SHA-locked merge. Source proof does not imply Cloudflare deployment. When deployed to their existing PREPRODUCTION services, only allowlisted human owner can call `/admin`; production locked. No App permissions, secret changes, Android wake, profile sharing, automated MFA/login or Notion.
