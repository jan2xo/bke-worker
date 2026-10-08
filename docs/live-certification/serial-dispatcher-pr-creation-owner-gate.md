# Serial dispatcher PR-creation owner gate — implementation wave

## Parent mission

This dependency exists for the live single-worker Master Queue proof in #47 and
roadmap #39.

Owner direction for this wave is implementation first; certification follows
later one dependency at a time.

## Observed failure

The first live Task A materialization reached deterministic branch creation but
failed when GitHub rejected PR creation with:

`GitHub Actions is not permitted to create or approve pull requests.`

The queue algorithm itself selected the correct task.

## Implementation

The dispatcher now translates only that specific GitHub denial into the durable
owner gate:

`OWNER_GATE_ACTIONS_PR_CREATION_DISABLED`

A bounded operator helper is provided:

`scripts/enable-serial-dispatcher-pr-creation.sh`

It uses the operator's existing human-authenticated `gh` session to read and
update the repository Actions workflow-permission endpoint. It preserves the
current default workflow permission and enables the repository switch required
for Actions PR creation.

No PAT, GitHub App private key, or new credential store is introduced.

## Queue semantics after bootstrap

Once the repository setting is enabled, the existing serial dispatcher remains:

```text
A closes
-> worker FREE
-> reconcile GitHub
-> materialize B PR
-> assign android-worker-a
-> stop

B closes
-> materialize C
-> assign android-worker-a
-> stop

C closes
-> no runnable task
-> WAIT / SLEEP
```

## Later certification

Required later:

- PR Guard;
- `core`;
- human run of the owner bootstrap against PREPRODUCTION repository settings;
- live A -> B -> C -> WAIT proof.

Production remains locked.
