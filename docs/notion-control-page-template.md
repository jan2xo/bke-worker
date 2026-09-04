# BKE Worker — ENGINEERING Page Contract

BKE Worker discovers operator-controlled engineering pages from the Notion workspace visible to the configured integration.

A page becomes discoverable only when its title starts with:

```text
ENGINEERING:
```

Examples:

```text
ENGINEERING: BKE Worker
ENGINEERING: Air Stack
ENGINEERING: Digital Solutions V2
```

The title is discovery/display metadata only. At START, Worker locks the exact selected Notion page ID and exact selected TODO block ID.

Core rule:

```text
NAMES DISCOVER.
IDS EXECUTE.
```

## Selected-page content

Each `ENGINEERING:` page contains both:

1. normal Notion `to_do` blocks — executable tasks;
2. one or more normal Notion tables — durable instruction templates.

BKE Worker does not cross into child pages or child databases while discovering tasks or instruction templates for the selected page.

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

Any normal Notion table on the same selected page is treated as an instruction table only when its header row is exactly:

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
Notion integration token
        ↓
shared page discovery
        ↓
filter title starts with ENGINEERING:
        ↓
Engineering project dropdown
        ↓
exact selected page ID
        ↓
Task dropdown        <- verified unchecked to_do blocks
Instruction dropdown <- same-page KEY | NAME | INSTRUCTION rows
        ↓
START
        ↓
lock page ID + TODO block ID
        ↓
fixed ChatGPT URL
        ↓
watch exact current block ID
```

At START, Worker revalidates that:

```text
selected page still starts with ENGINEERING:
selected TODO is currently unchecked
selected TODO belongs to that exact page
selected instruction key exists on that exact page
```

Watchdog behavior:

```text
current TODO unchecked + ChatGPT busy
-> wait

current TODO unchecked + ChatGPT idle
-> continue SAME TODO after retry guard

current TODO checked
-> read only the locked page
-> choose first verified unchecked TODO
-> dispatch it when ChatGPT is safe

no unchecked TODOs remain on the locked page
-> COMPLETE
-> no more prompts
```

## Operator refresh behavior

Normal operation does not require manual refresh.

The operator UI refreshes:

```text
watchdog summary        -> every 1.5 seconds
selected page options   -> every 8 seconds
ENGINEERING page list   -> every 30 seconds while the project selector is unlocked
```

The `Refresh Notion lists` button remains as an explicit manual/debug refresh.

Project discovery does not alter an active run. Once START is pressed, the exact page ID stored in Worker state remains runtime authority until STOP or COMPLETE.

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
- a fixed Notion page environment variable is not project authority;
- Notion does not choose the ChatGPT conversation;
- Project/Conversation semantic browser routing is not autonomous orchestration truth;
- child Notion pages/databases are not traversed for selected-page control data.

The fixed ChatGPT conversation URL remains Worker configuration.
