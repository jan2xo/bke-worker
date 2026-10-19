# GitHub arbiter ref inspection — bounded READ-ONLY source contract

## Status: source-only; NOT ACTIVATED

This independent dependency follows BKE Worker PR #115's source-only Git-ref
reservation model. **No live ref is created, mutated, activated, or claimed.**

A future server-private writer needs a reliable read of the *fixed* shared
arbiter ref before it can conditionally publish a proposed child commit. This
intent adds a bounded, strictly GET-only, fixed-repository GitHub REST inspector
for a future dedicated arbiter branch, using only the owner-approved GitHub App
installation token supplied by an independently authenticated server caller.

- Fixed repository: `jan2xo/bke-worker`
- Fixed ref: `refs/heads/bke/control-claims-v1`
- Fixed root manifest path: `claims-v1.json`
- Wire chain: GET ref → GET commit → GET tree → GET blob → GET ref again
- The ref is **absent** until a separately authorized owner bootstrap creates it.
  Absence must be reported as a fail-closed missing-ref state, not initialized.
- Reject redirects, arbitrary hosts/paths, malformed API payloads, oversized
  responses, tree truncation, unexpected tree members, symlinks, blob hash
  mismatch, noncanonical or duplicate-key JSON, malformed manifest and head
  movement between reads. Reject unverifiable provider responses, do not fall
  back to user credentials or a PAT.
- **Credential-bound transport boundary:** the bearer-bearing
  `GitHubAppArbiterReader` constructor does **not** accept any injected
  `opener`, URL, host or proxy. It constructs its own direct HTTPS urllib
  opener with an explicitly empty proxy configuration and a no-redirect
  handler; responses must also report exactly the original requested URL.
  A foreign final URL fails closed, and no HTTP 30x is followed. Do not
  reintroduce a pluggable transport that can receive real installation
  tokens. Tests substitute deterministic synthetic responses by patching
  the opener builder **only around construction with disposable fake tokens**
  or by injecting `fetch_json` into the pure `inspect_arbiter` parser.
  Patching the module runtime itself is not a supported credentialed API.
- A parsed result always declares `UNVERIFIED_GITHUB_REF_SNAPSHOT_ONLY` and
  `evidence_authority=NONE`, `assignment_authority=NONE`,
  `dispatch_authority=NONE`, `wake_authority=NONE`. Even mutually consistent
  fake HTTP responses remain **untrusted test evidence**, not provider identity
  proof, authenticated installation scope, remote atomicity, or a worker lease.
- No private key, token, cookies, browser state or device/session fingerprints
  are stored or emitted in results/logs.

This reader never creates commits, patches refs, labels PRs, dispatches
ChatGPT prompts, changes the serial dispatcher or modifies Cloudflare/Android
or desktop profiles. It does not grant a privileged authenticated caller;
that must come from a future separately certified server-private GitHub App
installation/scope principal. A read-twice snapshot is **not atomic** and
cannot prevent a force push or history rollback by privileged writers.

## Deployment and integration locks

Before a later writer can be activated, separately certify: independently
authenticated GitHub App installation + complete owner-approved repository
scope, real REST ref+commit+tree+blob semantics, privilege/force-write controls
and rollback protection, cross-resource PR-label authority reconciliation,
genuine live Command Center worker session binding, owner-controlled ambiguous
recovery, safe ChatGPT delivery and two-worker isolation. Do **not** use this
module as authorization for a live claim.

## Intentional certification

Only PR Guard and the focused Python adversarial inspector tests are required.
Real GitHub App access, live HTTP calls, Git ref creation, PR-label updates,
Cloudflare, Android, Chrome, PREPRODUCTION and production are **NOT_RUN**.
