# On-demand GitHub App worker PR ownership inventory — broker source

**Status: source-only, private RPC OFF by default.** Dependency of Command Center issue #30 after the 76-repository Admin catalog human acceptance. GitHub is the sole durable PR assignment authority. This code neither pairs devices nor dispatches/wakes workers.

## Exact purpose and trust boundaries

New named WorkerEntrypoint method `CommandCenterReadBroker.listVerifiedWorkerAssignments({purpose:"admin_worker_assignment_inventory"})` calls `fulfillCommandCenterAdminAssignments`. It is **not a public HTTP route**. It refuses every field other than the exact purpose and requires BOTH `BKE_ADMIN_BROKER_ENABLED=true` and a separate, currently-unconfigured `BKE_ADMIN_PR_INVENTORY_ENABLED=true` gate on the relay. A Command Center caller must independently prove a platform-verified allowed human Admin before using the private RPC; Service Binding membership is a privileged account capability, not browser authentication.

The relay resolves the existing GitHub App installation from the fixed `jan2xo/bke-worker` control repository. It does **not** use the dispatcher write-scoped token. It explicitly mints a short-lived installation token with ONLY `permissions:{metadata:"read",pull_requests:"read"}`, verifies exact returned permission keys/modes, valid installation bearer type and 2–61 minute expiry, and retains the bearer inside the relay. Any denial from GitHub (including absent installed PR-read grant) fails closed; do not silently widen permissions or reuse dispatcher tokens.

It enumerates **all existing installation-approved repositories**, bounded to at most 100 and requiring the canonical control repository ID. Each is processed through the fixed `https://api.github.com/repos/<validated-owner>/<validated-repo>/pulls?state=open&per_page=100&page=N` endpoint. For each repository, pages are followed until a short terminal page, with a hard four-page maximum, a combined 2,000 open-PR cap, and a 500 worker-claim cap. Every provider response must succeed; redirect following is OFF for all new RPC provider requests and the `Location` header is neither read nor surfaced. Any scope, pagination, duplicate repository, duplicate PR, invalid label, multi-worker-labelled PR, or duplicate worker ownership across repositories fails the entire enumeration. Never return a partial snapshot as complete.

Response is a NEW allowlisted projection only: installation identity (private inter-Worker RPC), approved repository count, number of open PRs scanned, and PR numbers/repository IDs/exact-head SHAs with ONLY labels of the form `bke-worker:<worker_id>`. No PR body, unassigned non-worker labels, provider token, App private key, arbitrary URL, or credential material is returned. Even empty claims mean only `0` observed *at the enumeration time*, not an exclusive or transactional lock.

## Critical consistency caveat

`consistency:"NON_ATOMIC_ENUMERATION"` is intentional: even 76 successful GitHub read calls across repositories are **not** one GitHub snapshot. Labels/heads may change between pages or after enumeration, and GitHub doesn't provide atomic cross-repository reads here. Consequently, this RPC alone must **never** be treated as an authoritative lease, a device activation grant or a final proof of worker availability. The future Command Center integration must revalidate current exact PR state immediately before any pairing/dispatch, enforce unique PR-worker leases through GitHub and a separately authorized bounded transactional mechanism, and fail closed on ambiguous races. Do not set a browser-supplied `verified:true` bit and call that proof.

## Certification and rollout

Minimum complete source gate: PR Guard + exact-head `/certify relay` (Node broker/inventory tests, runtime smoke, reconnect contract, Cloudflare relay contract, source policy), independent bounded App permission/redirect/credential-exfiltration review and SHA-locked squash merge. The new flag stays OFF; no Cloudflare deployment, key/secret change, GitHub App installation permission expansion, Admin pairing API or production action follows from a source merge. Later Command Center private-consumer + Access binding, true SQLite DO pairing, CSRF/nonces and live human acceptance require separate fresh PRs.

Android GeckoView parked PR #90 and all worker target/browser profiles remain untouched.
