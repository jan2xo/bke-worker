# Autonomous engineering contract

## Durable state

BKE Worker does not duplicate repository or task state.

GitHub is the durable execution memory:

- current `main` = merged implementation truth;
- open PR = current engineering intent/ledger;
- PR template = human-readable intent contract;
- PR comments = implementation/certification/merge checkpoints;
- GitHub Actions = exact-head certification truth;
- issues or other explicit GitHub queue entries = future engineering intents.

## Continuation algorithm

On startup, signed push, manual continuation, or heartbeat, Worker may send one locked continuation instruction only after ChatGPT is positively safe to interrupt.

ChatGPT then performs:

```text
read canonical Project Source
-> inspect live GitHub
-> active PR?
     yes -> continue same intent
     no  -> next explicitly queued intent?
              yes -> current main -> fresh branch -> NEW PR from template
              no  -> remain idle; do not invent work
-> implement
-> certify exact head
-> SHA-lock merge
-> durable checkpoint
```

## Heartbeat

Default: 30 minutes.

The heartbeat exists only to recover liveness when:

- no GitHub push arrived;
- a push arrived while ChatGPT was busy;
- a worker/browser/network interruption occurred;
- ChatGPT completed work without producing another wake event.

The heartbeat is not an execution timeout and never authorizes abandoning the current PR.

## PR rule

One independent intent belongs in one PR.

A new independent engineering wave must:

1. read current `main`;
2. create a new branch from that exact current main;
3. open a new PR using `.github/pull_request_template.md`;
4. declare the minimum complete certification graph;
5. keep operational execution details in checkpoint comments;
6. exact-head certify;
7. SHA-lock merge;
8. verify main.

Old/merged feature branches are never reused for a new intent.
