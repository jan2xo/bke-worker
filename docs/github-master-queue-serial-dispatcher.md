# GitHub-native Master Queue — Serial Dispatcher v1

## Intent

Implement the first executable replacement for the old Notion checklist loop using GitHub as the only durable queue and execution truth.

This wave is intentionally **single-worker only**.

Worker:

`android-worker-a`

Parallel workers are out of scope.

## Durable model

- the dispatcher idempotently bootstraps its bounded control labels before reconciliation;\n- one issue labeled `bke-queue:master` is the ordered human-facing checklist;
- task issues referenced by that checklist are queued work;
- a task issue becomes runnable only when it is open, authored by a trusted GitHub association (`OWNER`, `MEMBER`, or `COLLABORATOR`), and labeled `bke-task:ready`;
- `bke-task:blocked` makes a task non-runnable;
- a materialized PR is the active execution contract and ledger;
- `bke-worker:android-worker-a` is the worker ownership lock;
- GitHub state is sufficient to reconstruct the queue after restart.

## Worker availability

Count open PRs with `bke-worker:android-worker-a`:

- 0 -> FREE;
- 1 -> BUSY;
- 2+ -> conflict, fail closed.

Transport/browser liveness does not release ownership.

## Deterministic selection

When FREE:

1. recover exactly one open Master Issue;
2. parse its checklist in body order;
3. inspect each referenced task issue;
4. skip closed, blocked, non-ready, or already-materialized tasks;
5. choose the first runnable task;
6. materialize exactly one fresh draft PR from current main;
7. attach `bke-worker:android-worker-a`;
8. stop.

When BUSY, assign nothing.

When no runnable task exists, do nothing.

## Materialization

The dispatcher creates a deterministic task branch from current main and opens a draft PR whose body embeds the task issue contract and closes the task issue on successful merge.

The initial branch commit must be metadata-only/no product behavior; actual engineering is performed by the assigned Worker.

## Triggers

Serial reconciliation is GitHub-native and should run on bounded queue/PR events plus manual dispatch for recovery.

The control-plane workflow must execute trusted default-branch dispatcher code, not arbitrary PR-head code.

## Security

- no production deployment;
- no auth automation;
- no secret material in queue/task/PR content;
- no task authority in Cloudflare/Android;
- public issue content alone is insufficient authority: Master/task Issues must also have a trusted GitHub author association, and READY/master labels remain maintainer-controlled gates;
- ambiguous master queue or worker ownership fails closed.

## Certification

Required: `core`.

Prove at minimum:

- master checklist parsing preserves order;
- exactly-one master queue requirement;
- FREE/BUSY/CONFLICT worker derivation;
- first runnable deterministic selection;
- blocked/non-ready/closed tasks are skipped;
- no runnable task means WAIT;
- BUSY means no assignment;
- 2+ assigned PRs fail closed;
- materialization is idempotent;
- workflow uses trusted-main dispatcher code;
- no parallel-worker allocation exists in v1.

Production remains locked.
