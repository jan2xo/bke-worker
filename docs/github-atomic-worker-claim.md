# GitHub-native atomic worker reservation — source-only contract

## Status and authority

**Not activated.** This is a necessary control-plane dependency, not a
new live scheduler, assignment authority, or browser-delivery mechanism.
`scripts/github_atomic_claim.py` defines a bounded reservation protocol
that can be certified with adversarial fixtures. Its callbacks and snapshots
are **not proof** that an actual GitHub App token or OS/browser session was
authenticated.

Current `bke-worker:<worker_id>` PR labels remain the **authoritative
delegation record**. A separate, single Git ref is proposed only as a
serialization barrier for cooperative assignment writers, not as a second
queue or independent planner. The reservation manifest has no task body,
ordering, plan, credentials, or browser/session fingerprints.

## Proposed single-writer serialization point

Reserve `refs/heads/bke/control-claims-v1` in
`jan2xo/bke-worker` as the **one shared arbitration branch** for the
entire approved GitHub App repository scope. Keep one validated bounded
manifest in its commit tree. Never create or advance this ref as part of
this source-only certification.

A trusted future actor would:

1. Authenticate the provider GitHub App installation, its **complete**
   owner-approved repository scope, current live worker session and control
   principal; recover the PR head and labels and the complete ownership
   inventory. Reuse the existing preclaim only as a consistency check.
2. Read the arbiter ref + manifest at its exact commit; validate all
   reservations and reject collisions including expired or uncertain claims.
3. Build exactly **one child commit** with the observed arbiter head as
   sole parent and an updated bounded manifest. No rebases, multi-parent
   commits, branch rewrites, or force updates.
4. Advance the shared ref through GitHub REST **PATCH git/refs with
   `force:false`**. A contender whose proposed commit is a sibling,
   not a descendant of the new current ref, cannot fast-forward it.
   This is the only proposed serialization point; GitHub PR-label
   mutation is not part of that atomic ref update.
5. Verify the exact resulting arbiter ref and manifest. Treat a lost
   response as unknown, never as success. Reconcile rather than blindly
   retrying, assigning or waking a worker.
6. Separately reconcile/confirm the authoritative PR label and current
   head. Until separate cross-resource authority, session and delivery
   gates are certified, the result is **RESERVATION_RECORDED_ONLY**,
   with assignment, wake and dispatch authority `NONE`.

GitHub documents `force:false` as a non-overwriting fast-forward
update: https://docs.github.com/en/rest/git/refs#update-a-reference .
This guarantees competing sibling commits cannot **both** fast-forward
the same ref when GitHub applies its normal reference rules; it does not
prove a multi-object transaction over independent PR labels.

## Crash, lease and recovery boundary

- A reservation is exclusive by worker ID and PR identity across all
  repositories; separate workers may reserve different PRs concurrently
  through successive commits to the **same** serialized ref.
- Write an explicit `DELIVERY_UNCERTAIN` fence **before** an external
  prompt could be submitted. If the fence write/response is uncertain,
  delivery must **not** start.
- Lease deadlines signal recovery review; they **never automatically
  release** a reservation or permit replay/reassignment. A stale,
  expired or delivery-uncertain reservation still occupies its resources.
- Identical retries are denied without side effects; webhook replays do
  not generate a new claim or delivery. An actual prompt-delivery
  idempotency/receipt system is a different certification boundary.
- A crash before ref publication leaves no durable reservation; a crash
  after publication or an uncertain API response is reconciled from the
  shared ref, not from a worker cache. An uncertain ChatGPT send requires
  explicit owner recovery evidence. Operator-controlled release/handoff
  is deliberately not implemented here.
- Unverified registration, shared targets/profiles, stale PR head,
  changed labels, unauthorized ref writers, GitHub API outages, partial
  repository scope, missing arbiter or manifest, and conflicting serial
  dispatcher mutations **must fail closed**. Do not activate this
  protocol while the v1 serial dispatcher or a human can bypass its
  reservation gate for a worker/PR in scope.

## Operational trust gaps (deliberately unresolved)

1. Command Center cannot yet supply the independently verified live
   `session_binding_sha256` or a live-authorized private reader.
2. A protected, authenticated GitHub App **single arbiter authority**
   and per-installation scope binding have not been deployed or tested.
3. PR-label writes and arbiter-branch writes are separate transactions,
   so authority must reconcile both and prohibit bypasses.
4. The desktop browser/native-host trust chain is not live-certified.
5. Crash-ambiguous ChatGPT delivery, explicit owner recovery and two
   real simultaneously enrolled workers have not been proven.

**No new workflow, GitHub ref, PR label, token, production deployment,
or browser dispatch is activated by this PR.** The protected
`serial-dispatcher.yml` stays unchanged.

## Minimum certification

- Required: PR Guard's existing Python contracts plus
  `python3 tests/github_atomic_claim_contract.py` at exact head;
  review changed source/docs and verify no runner activation.
- Core certification is appropriate if a future intent wires the
  primitive into orchestration or changes active runtime behavior.
- Not required here: Android APK, relay, server, Playwright ChatGPT,
  native-host smoke or production rollout; no code in those boundaries.

Adversarial fixture coverage includes same-PR races, same-worker/different
PR races, valid independent workers, stale PR heads/labels, crash points,
timeout/retry/replay, expiration, uncertain prompt delivery, caller-trust
limits and non-fast-forward/API failure.
