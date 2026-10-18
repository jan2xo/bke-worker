# Installed-repository catalog (Admin, PREPRODUCTION source only)

This feature discovers repositories already available to the **existing BKE Worker GitHub App installation**, without a human providing installation IDs, repository URLs or per-worker tokens. It is a bounded prerequisite for Command Center issue #30, not a source-fetcher or broad GitHub organization enrollment.

## Authority and trust

- Canonical engineering truth remains GitHub.
- The relay's GitHub App authenticates using its encrypted server-only private key. Installation is resolved from the fixed BKE Worker control repository, not selected by an untrusted browser parameter.
- The GitHub App installation access-token request explicitly uses `permissions: {}` to prevent inheriting its existing write grants. The response must **explicitly report exactly `metadata: read`** or the feature fails closed. GitHub documents that `GET /installation/repositories` works with a GitHub App installation token and requires no optional repository permissions.
- The catalog token remains in the relay; the caller receives only validated IDs, names, default branches, archived/private flags and canonical GitHub links.
- Both `BKE_ADMIN_BROKER_ENABLED=true` and the **separate** `BKE_ADMIN_REPO_CATALOG_ENABLED=true` are required on the *relay*. Neither flag is enabled by this change.
- `CommandCenterReadBroker.listApprovedGitHubRepositories` is a **private Cloudflare named service-binding RPC**. There is no public catalog/token HTTP route and no worker/device credential is issued.
- The catalog is bounded to at most 500 repositories, fails on an incomplete/changed count, duplicate identity, malformed upstream data or invalid returned scope. It never treats partial enumeration as complete.

## Cross-repository follow-up

A separate, fresh Command Center PR must consume catalog metadata only **after verifying the human Admin's signed Cloudflare Access JWT**. Its server-side RPC request should carry exactly `{ purpose: "admin_installation_repository_catalog" }`. It must not expose bearer, GitHub App private key, signing secrets or browser session data. A service binding is an account-level capability and not a substitute for independent Admin identity checks.

Automatic display of a repository in this catalog **does not authorize installing the GitHub App into that repository or expanding permissions**. The catalog only reflects the current installation's existing approved scope. Source-content reads (e.g. for Render Dock advertisements) will require a separate fine-scoped and audited source-read intent, with verified installation grants and product identity.

## Certification and deployment locks

Minimum complete source graph: PR Guard, `cloudflare-relay` Node tests including `admin-catalog.test.mjs`, `npm run check`, `/certify relay` including the Android/relay cross-boundary contract, and exact-head security audit. Human PREPRODUCTION RPC/Access smoke is a separate owner-controlled activation gate.

Do NOT deploy, flip either flag, install/reconfigure the GitHub App, rotate real keys, wake Android, share writable browser profiles or enable production from this PR.
