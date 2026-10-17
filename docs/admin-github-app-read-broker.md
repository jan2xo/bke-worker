# Command Center — internal read-only GitHub App broker

**Status:** source implementation only. Deployed PREPRODUCTION has NOT been modified. This is a necessary, independently bounded dependency for [Command Center issue #30](https://github.com/jan2xo/bke-command-center/issues/30).

## Trust and architecture

Current serial GitHub Actions OIDC -> GitHub App installation-token broker remains unchanged. Its existing `mintInstallationToken()` continues to request only the canonical BKE Worker repository ID with the exact previous write permissions. Do not reuse that token in Admin or a browser.

This intent adds a separate **READ-ONLY** GitHub App installation-token issuance function:

- Installation identity is independently resolved by the GitHub App from **`jan2xo/bke-worker`**, not supplied by the caller.
- The token request is restricted to immutable repository ID `1354026486` and `contents: read`, `issues: read`, `pull_requests: read`.
- Token response expiry is validated and tokens are short-lived; the GitHub App private key never leaves the already encrypted Cloudflare relay boundary.
- No worker, browser, GitHub PR, log or Actions workflow receives this Admin broker token.

The only invocation path is a **named Cloudflare Service Binding RPC entrypoint** `CommandCenterReadBroker.mintReadOnlyGitHubToken()`; it is not registered in the public HTTP fetch router. A caller must be another Cloudflare Worker inside the authorized account with an explicitly configured binding using `entrypoint = "CommandCenterReadBroker"`.

This is a **Cloudflare account/service-binding capability boundary**. The caller must itself independently validate the human Admin's Cloudflare Access JWT before invoking RPC, enforce exact intended action and never return the minted token in its HTTP/JSON response. Untrusted content-script/ChatGPT requests must never invoke this RPC.

**Default OFF:** `BKE_ADMIN_BROKER_ENABLED` must be exactly `true` on the *broker's* trusted Cloudflare environment before RPC will mint. No live flag has been set. The RPC validates the exact request shape and the specific `{ purpose: "admin_source_discovery", repository: "jan2xo/bke-worker" }` capability. The caller cannot request different repositories, elevated permissions, or a dispatcher write token.

## Next separate intent

The Command Center can add a `BKE_GITHUB_READ_BROKER` named Service binding to the PREPRODUCTION relay Worker and use this private RPC only after verified Admin access. The Command Center must override its current manually provisioned `GITHUB_TOKEN` for this Admin discovery request *in memory only*. The returned GitHub App token is never persisted, never sent to the Admin browser, and not used for any worker PR mutation. Broker unavailable/disabled must fail closed **without falling back to a stronger PAT**, not silently revert to a static token.

This first broker covers only `jan2xo/bke-worker`, because broadening installation scope needs explicit owner consent. It does NOT certify organization-wide repository discovery, credential revocation of the GitHub App private key, provider OAuth automation, ChatGPT login, worker pairing, or multi-worker concurrency.

## Certification and locks

Required for source acceptance: relay node tests with `cloudflare-relay/tests/admin-broker.test.mjs`, `npm run check`, exact-head `relay` certification and security review proving no HTTP token route or write-token permission change.

Deployment/activation requires a separately authorized PREPRODUCTION operation: verify matching Cloudflare account and service target, configured source version, Access authenticated/denied behavior, scoped GitHub token response, rotation on repeat and no browser token leak. Production remains LOCKED. No secret provisioning, Cloudflare deployment, worker assignment, browser-profile change, or Android wake is part of this PR.
