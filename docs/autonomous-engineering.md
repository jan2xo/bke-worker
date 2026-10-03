# Autonomous engineering contract

## Durable state

BKE Worker does not duplicate repository or task state.

GitHub is the durable execution memory:

- current `main` = merged implementation truth;
- open PR = independent engineering intent + execution ledger;
- exactly one `bke-worker:<worker_id>` label = durable active worker assignment;
- PR comments = implementation/certification/merge/reassignment checkpoints;
- GitHub Actions = exact-head certification truth;
- explicit GitHub queue entries = future engineering intents.

Worker state caches only what is needed for liveness and deterministic routing. It is not a task queue.

## Multi-worker ownership

```text
one worker instance -> one active PR assignment at a time
one PR -> one active worker
```

A worker does not select arbitrary open PRs. GitHub assignment is explicit.

Assignment states:

- no `bke-worker:` label -> unassigned;
- exactly one `bke-worker:<worker_id>` label -> assigned;
- multiple `bke-worker:` labels -> ambiguous, fail closed;
- same worker assigned a second open PR -> conflict, fail closed.

The locked prompt includes the worker ID and assigned PR number, but cached assignment is never sufficient authority. Before engineering action, ChatGPT re-reads live GitHub and verifies the PR is open, the single assignment label matches the current worker, and the worker owns no second open PR.

## Continuation algorithm

```text
signed PR assignment
-> worker caches assigned PR head for routing
-> ChatGPT safe to interrupt?
     no  -> defer
     yes -> send worker/pr ownership-locked continuation
-> ChatGPT reads BKE-WORKER-CANONICAL-PROJECT-EXECUTION-INSTRUCTIONS.md from jan2xo/bke-worker current main
-> recover live GitHub PR + exact head + assignment label
-> ownership unambiguous?
     no  -> stop
     yes -> continue only this PR
-> implement
-> minimum complete exact-head certification
-> SHA-lock merge when authorized
-> durable checkpoint
```

An assigned-branch push is an immediate wake. A push for another branch is ignored by that worker. Heartbeat is recovery only and runs while an assignment is active.

## Browser/runtime isolation

Each concurrent worker is a separate runtime process with a distinct ChatGPT target, writable Chromium profile, loopback CDP endpoint, state file, and listen port.

Workers sharing a host use a common resource-lock directory. Duplicate worker IDs or shared ChatGPT/browser/state resources fail closed before the server starts.

Authentication remains human-owned. Worker never automates OAuth, MFA, CAPTCHA, or security challenges.

## Crash and reassignment

Restart from a persisted `DISPATCHING` or `CONTINUING` state is crash-ambiguous, so Worker enters `BLOCKED` instead of risking duplicate prompt delivery.

Safe reassignment requires an explicit GitHub label transition and operator recovery whenever prior dispatch outcome is uncertain.

Removing the assigned worker label or closing the assigned PR clears the cached assignment and stops automatic continuation.

## PR rule

One independent intent belongs in one PR.

A new engineering wave must:

1. read current `main`;
2. create a fresh branch from that exact main;
3. open a new PR using `.github/pull_request_template.md`;
4. assign one worker with `bke-worker:<worker_id>`;
5. declare the minimum complete certification graph;
6. keep chronological execution details in PR comments;
7. exact-head certify;
8. SHA-lock merge;
9. verify resulting `main`;
10. write the durable merged checkpoint.

Old or merged feature branches are never reused for a new intent.
