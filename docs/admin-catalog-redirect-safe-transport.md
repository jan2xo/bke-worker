# PREPRODUCTION GitHub catalog — redirect-safe outbound GET

## Evidence

Owner's human-authenticated Command Center Admin now displays `GITHUB_CATALOG_REPOSITORIES_TRANSPORT_UNAVAILABLE` after independently verified PREPRODUCTION deployments: Worker relay v76 and Command Center v19.

The exact Worker source shows this code comes only from an exception thrown by `fetchImpl` while calling `https://api.github.com/installation/repositories?per_page=100&page=N`. Installation JWT signing, installation lookup, token issuance and strict `metadata:read` token bearer, lifetime and grant validation have all passed their own checks; repository response has not been received.

The outbound GET was configured with `redirect:"error"`. Cloudflare Workers supports that option; any HTTP redirect throws at the fetch boundary and is indistinguishable from network/transport failure. **We have not proved that GitHub redirected**; don't claim it.

## One bounded intent

At ONLY the existing `GET /installation/repositories` call:
- Change `redirect:"error"` to `redirect:"manual"` so a 3xx can be diagnosed without following it.
- Reject EVERY 3xx response with fixed `ADMIN_CATALOG_REPOSITORIES_REDIRECT_BLOCKED`. Do not follow or expose the Location header, replay the token, or grant a redirect origin any authority.
- Preserve `ADMIN_CATALOG_REPOSITORIES_TRANSPORT_UNAVAILABLE` for true fetch exceptions; existing `ADMIN_CATALOG_REPOSITORIES_UNAVAILABLE` for non-2xx provider responses.
- Preserve exact `{permissions:{metadata:"read"}}` token mint request, exact return grant, bearer bounds, TTL, current App installation repository selection, duplicate/truncated response defenses, and all private RPC authorization.
- Tests prove no follow-up fetch to an untrusted redirect target; no Location/bearer disclosure; existing success and true fetch error remain distinguishable.
- Human Admin can only see this safe new stage after a **separate** fresh-main Command Center mapping PR. Until then, the client must show generic broker unavailable for the new code. Do not weaken the fallback.

## Gates

Fresh Worker PR on current main. Required automatic PR Guard + exact-head `/certify relay` including Cloudflare durable relay and Required certification gate. Independent security review, SHA-locked merge, PREPRODUCTION relay source upload/deploy verified by downloaded effective Worker, then separate Command Center PR full CI + exact-head merge/source deployment. Human Access login smoke last. No production, secret writes, GitHub App permission expansion/reinstall, browser auth automation, Android wake or profile access.

Important interpretation: If the next Admin code is `GITHUB_CATALOG_REPOSITORIES_REDIRECT_BLOCKED`, do not automatically follow GitHub redirect with the bearer. Independently establish the origin/path and a trustworthy same-origin redirect policy before adding handling. If it remains transport, investigate network/headers/Cloudflare subrequest behavior without guessing or leaking credentials.
