# GitHub-Origin Webhook UTM Certification

STATUS: PENDING

Expected worker: `worker-a`

## Intent

Prove that a real GitHub-origin `pull_request` event can travel through the approved webhook-only public ingress to the local Ubuntu UTM BKE Worker and cause the assigned human-authenticated ChatGPT conversation to execute a bounded GitHub task.

This certification specifically closes the gap left by the previous Worker A smoke, where the signed GitHub payload was injected locally with `curl`.

## Success path

```text
GitHub PR label event
-> public webhook-only ingress
-> /webhooks/github on Worker A
-> signature verification
-> deterministic worker-a assignment
-> safe-to-interrupt ChatGPT check
-> ownership-locked prompt
-> ChatGPT reads canonical instructions from current main
-> ChatGPT recovers this PR + exact head + label
-> bounded status change + checkpoint
```

## Assistant-owned execution checklist

The owner may observe this checklist but should not manually mark items complete.

- [ ] Confirm current `main` and this PR exact head before local execution.
- [ ] Confirm Worker A is unassigned and no stale Worker process owns its runtime resources.
- [ ] Start Worker A from current canonical `main` with the existing dedicated persistent Chromium profile.
- [ ] Configure or reuse a Cloudflare Tunnel that exposes only `/webhooks/github` to Worker A at `127.0.0.1:5084`.
- [ ] Verify public `/control/*`, `/health/*`, root, and Chromium CDP remain unreachable through the tunnel.
- [ ] Verify the GitHub repository webhook points to the webhook-only public URL and uses the configured Worker webhook secret for `pull_request` and `push` events.
- [ ] Assign this PR with exactly one label: `bke-worker:worker-a`.
- [ ] Observe a real GitHub-origin delivery wake Worker A without a locally injected synthetic webhook.
- [ ] Observe Worker A dispatch the ownership-locked prompt to the correct ChatGPT conversation.
- [ ] Verify ChatGPT changes only `STATUS: PENDING` to `STATUS: GITHUB_WEBHOOK_LIVE`.
- [ ] Verify ChatGPT adds exactly: `BKE LIVE HOST CHECKPOINT — GITHUB ORIGIN WEBHOOK GREEN`.
- [ ] Revoke the Worker A assignment after proof.
- [ ] Record exact-head certification evidence and merge only if the declared graph is complete.

## Assigned bounded worker task

When and only when this PR is assigned to `worker-a`, the worker ChatGPT conversation must:

1. read `BKE-WORKER-CANONICAL-PROJECT-EXECUTION-INSTRUCTIONS.md` from current `main`;
2. recover live GitHub state for this PR;
3. verify this PR is open and assigned only to `bke-worker:worker-a`;
4. verify the exact PR head supplied in the Worker ownership lock;
5. change only `STATUS: PENDING` to `STATUS: GITHUB_WEBHOOK_LIVE`;
6. add a PR comment: `BKE LIVE HOST CHECKPOINT — GITHUB ORIGIN WEBHOOK GREEN`;
7. stop.

Do not modify any other file.
Do not merge until certification is complete.
Do not deploy anything.
Do not automate ChatGPT, GitHub, or Cloudflare authentication/security challenges.

## Certification boundary

Required:
- real GitHub-origin webhook delivery;
- webhook signature verification by Worker;
- webhook-only public ingress;
- persistent human-authenticated Chromium/ChatGPT;
- bounded GitHub mutation by the assigned ChatGPT;
- exact-head evidence.

Not sufficient:
- locally synthesized webhook payload;
- controlled fixture-only browser tests;
- manual prompt entry.

Production remains locked.
