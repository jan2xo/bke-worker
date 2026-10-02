# Chat vs Work execution-surface guardrail

BKE Worker treats Chat and Work as different execution semantics.

## CHAT

Chat is the canonical surface for the current autonomous engineering loop.

- Continue an exact existing Project conversation.
- Conversation history is part of engineering continuity.
- The locked continuation instruction remains `CONTINUE FROM THE NOTION CHECKLIST.`.
- The worker must match the exact Project and exact Conversation.

## WORK

Work is a separate agentic execution surface.

- It may use Project context, but BKE Worker must not assume it is equivalent to an existing Chat conversation.
- It requires its own explicit execution contract before support is implemented.
- It is not a fallback when Chat navigation fails.

## Permanent fail-closed rule

Every ChatGPT execution target carries an explicit `ChatGptExecutionSurface`.

The current worker and `ChatGPTWebDriver` support `Chat` only. If a target requests `Work`, execution stops with:

`CHATGPT_EXECUTION_SURFACE_MISMATCH`

The mismatch is detected before Notion reconciliation in a new dispatch and before browser navigation in the Chat adapter. No prompt is sent.

Never silently switch:

- Chat -> Work
- Work -> Chat

A future Work adapter must be implemented and certified independently rather than weakening this guardrail.
