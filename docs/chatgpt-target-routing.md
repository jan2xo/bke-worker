# ChatGPT target routing

BKE Worker routes each worker instance to exactly one configured Chat execution target.

Target configuration is runtime/bootstrap configuration. It is not task authority. GitHub PR assignment labels determine which engineering PR a worker is allowed to advance.

## Mode A — semantic Project + Conversation

```text
worker-a
  BKE_WORKER_CHATGPT_PROJECT=BKE Worker
  BKE_WORKER_CHATGPT_CONVERSATION=Worker Engineering A
        |
        v
persistent Chromium profile A
        |
        v
exact project + exact conversation A
```

The worker resolves the exact Project and Conversation through the current ChatGPT UI.

## Mode B — direct conversation override

```text
worker-b
  BKE_WORKER_CHATGPT_OVERRIDE_URL=https://chatgpt.com/.../c/<conversation-id>
        |
        v
persistent Chromium profile B
        |
        v
exact conversation URL
```

Accepted override links must:

- use HTTPS;
- use `chatgpt.com` or `www.chatgpt.com`;
- contain a `/c/<conversation-id>` path segment;
- resolve to the same conversation ID after navigation.

Invalid links fail closed as `CHATGPT_OVERRIDE_URL_INVALID`. A valid but unreachable target fails as `CONTEXT_NOT_FOUND`.

Project/Conversation and Override Link are mutually exclusive. Ambiguous or partial target configuration fails closed.

## Multi-worker isolation

Concurrent workers must use distinct ChatGPT targets. They also require distinct writable Chromium profiles, loopback CDP endpoints, state files, and runtime listen ports.

A shared host-local resource-lock directory prevents two processes on the same host from simultaneously claiming the same:

- `worker_id`;
- ChatGPT target;
- browser profile;
- state file;
- CDP endpoint.

This protects process isolation; it does not replace GitHub assignment authority.

Each engineering prompt includes the current `worker_id` and cached assigned PR number and instructs ChatGPT to recover live GitHub before acting. ChatGPT must verify the PR's single `bke-worker:<worker_id>` label and that the worker owns no second open PR.

## Authentication and execution guardrails

- Chat execution surface only;
- human-only authentication;
- `CHATGPT_AUTH_REQUIRED` blocks execution;
- live `chatgpt.com` uses operator-owned system Chromium + loopback CDP only;
- no cookie/session export;
- no OAuth/MFA/CAPTCHA automation;
- composer idle state must be positively confirmed before continuation;
- routing never falls back to Work.

## Configuration

Each worker has its own environment file. Example:

```text
BKE_WORKER_ID=worker-a
BKE_WORKER_CHATGPT_PROJECT="BKE Worker"
BKE_WORKER_CHATGPT_CONVERSATION="Worker Engineering A"
BKE_WORKER_CHATGPT_OVERRIDE_URL=""
BKE_WORKER_BROWSER_CDP_ENDPOINT=http://127.0.0.1:9222
BKE_WORKER_CHATGPT_PROFILE=/var/lib/bke-worker/profiles/worker-a
BKE_WORKER_STATE_FILE=/var/lib/bke-worker/state/worker-a.json
```

A second worker must not reuse that target/profile/CDP/state tuple.

## Authority boundary

GitHub owns engineering delegation and execution truth. Worker only routes/livens the assigned conversation. No Notion-backed target authority or secondary task database participates in canonical execution.
