# BKE Worker — Single-Page Notion Control Contract

BKE Worker uses exactly one configured Notion page for operator-controlled work.

## Page content allowed

The same page contains both:

1. normal Notion `to_do` blocks — executable tasks;
2. one or more normal Notion tables — durable instruction templates.

BKE Worker does not cross into child pages or child databases while discovering tasks or instruction templates.

## TODO contract

Each executable task is a normal Notion checkbox block.

Example:

```text
☐ Add exact current-TODO watching
☐ Certify unchecked + busy waits
☐ Certify checked advances exactly once
☐ Certify all checked stops the worker
```

The Notion block ID is task identity. Task text is descriptive and may be edited; the block ID remains the runtime key for the active task.

Completion truth:

```text
checked = false  -> task is not complete
checked = true   -> task is complete
```

Worker never infers completion from GitHub pushes, elapsed time, or a finished ChatGPT response.

## Durable instruction table contract

Any normal Notion table on the same page is treated as an instruction table only when its header row is exactly:

| KEY | NAME | INSTRUCTION |
| --- | --- | --- |
| engineering | Engineering Canonical | Establish canonical project/repository reality first. Work only on the selected TODO. Preserve architecture unless the TODO explicitly changes it. Do not merge without owner authorization. Run relevant tests. Mark the exact selected Notion TODO checked only when complete and verified. If blocked, leave it unchecked and report why. |
| audit | Audit / Read Only | Inspect canonical reality only. Do not mutate repositories, production systems, databases, or Notion state unless explicitly authorized by the selected TODO. Leave the TODO unchecked if the requested evidence cannot be established. |
| surgical | Surgical Fix | Make the smallest correct change required by the selected TODO. Do not perform unrelated cleanup or redesign. Run targeted tests. Mark the exact selected TODO checked only after the acceptance condition is satisfied. |

Multiple matching tables may exist on the same page. `KEY` values must be unique across all matching tables.

Tables with other headers are ignored.

## Runtime contract

The normal operator flow is:

```text
Task dropdown        <- unchecked Notion to_do blocks
Instruction dropdown <- same-page KEY | NAME | INSTRUCTION rows
                         |
                         v
                      START
                         |
                         v
                  fixed ChatGPT URL
                         |
                         v
              watch exact current block ID
```

Watchdog behavior:

```text
current TODO unchecked + ChatGPT busy
-> wait

current TODO unchecked + ChatGPT idle
-> continue SAME TODO after retry guard

current TODO checked
-> read checklist
-> choose first unchecked TODO
-> dispatch it when ChatGPT is safe

no unchecked TODOs remain
-> COMPLETE
-> no more prompts
```

## Task-writing contract

Durable instructions define behavior and boundaries. TODOs define one bounded outcome.

A strong TODO states what must become true and has an observable completion condition.

Weak:

```text
☐ Fix BKE Worker
```

Better:

```text
☐ Make BKE Worker retrieve the exact active Notion TODO by block ID and advance only after that block reports checked=true.
```

Keep repository names, branch rules, mutation boundaries, testing requirements, merge authorization, and stop conditions in the durable instruction when they apply broadly. Keep the TODO focused on the current outcome.

## Explicitly retired from orchestration

On the checkbox-watchdog architecture:

- GitHub push is not a wake authority;
- repository selection is not an operator UI field;
- Notion does not choose the ChatGPT conversation;
- Project/Conversation semantic browser routing is not autonomous orchestration truth;
- child Notion pages/databases are not traversed for control data.

The fixed ChatGPT conversation URL remains Worker configuration.
