# ChatGPT Target Routing

BKE Worker supports two Chat execution-target modes.

## Mode A — semantic Project + Conversation

```text
Notion target
  Project = BKE Worker
  Conversation = Worker Engineering
        |
        v
BKE Worker
        |
        v
https://chatgpt.com/projects
        |
        v
exact project row
        |
        v
exact conversation
```

This mode is resilient when no stable direct link has been recorded, but it depends on current ChatGPT semantic navigation surfaces.

## Mode B — override link

```text
Notion target
  Override URL = https://chatgpt.com/.../c/<conversation-id>
        |
        v
BKE Worker
        |
        v
exact conversation URL
```

When an override URL is present, it **wins** over Project + Conversation.

The worker must not navigate arbitrary URLs. Accepted override links must:

- use HTTPS;
- use `chatgpt.com` or `www.chatgpt.com`;
- contain a `/c/<conversation-id>` path segment;
- land on the same conversation ID after navigation.

Invalid override links fail closed as:

```text
CHATGPT_OVERRIDE_URL_INVALID
```

A valid override that cannot be reached or no longer resolves to the expected conversation fails as:

```text
CONTEXT_NOT_FOUND
```

## Authentication and execution guardrails

Both target modes preserve the same permanent rules:

- Chat execution surface only;
- human-only authentication;
- `CHATGPT_AUTH_REQUIRED` stops before Notion reconciliation;
- live `chatgpt.com` uses operator-owned system Chromium + loopback CDP only;
- no cookie/session export;
- no OAuth/MFA/CAPTCHA automation;
- composer idle state must be confirmed before continuation;
- override routing must never become a fallback to Work.

## Configuration/bootstrap mapping

The current VPS bootstrap supports either:

```text
BKE_WORKER_CHATGPT_PROJECT
BKE_WORKER_CHATGPT_CONVERSATION
```

or:

```text
BKE_WORKER_CHATGPT_OVERRIDE_URL
```

If both are configured, `BKE_WORKER_CHATGPT_OVERRIDE_URL` takes precedence.

Environment configuration is a deployment/bootstrap input, not the intended long-term orchestration authority.

## Notion authority

Canonical orchestration direction:

```text
NOTION TASK
   |
   +--> selected Project + Chat
   |
   `--> Override Link
             |
             | wins when present
             v
        BKE WORKER TARGET
```

The Core and ChatGPT adapters already support this target contract. Physical Notion target ingestion is a separate wiring gate because the current `NotionWorkSource` remains scaffold-only. Do not claim Notion-driven target selection as certified until that adapter is implemented and tested.

## Live Phase 6A evidence

A real authenticated non-mutating probe succeeded against the BKE Worker project / Worker Engineering conversation on 2026-09-03:

```text
compatible = true
authenticated = true
composerAvailable = true
turnBusy = false
canSendNextTurn = true
failure = null
```

The probe sent no prompt.

This proves the live Chat adapter surface. Full Phase 6 still requires a bounded real Notion + GitHub webhook + ChatGPT loop and a green automated regression candidate.
