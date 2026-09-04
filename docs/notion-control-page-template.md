# BKE Worker — ENGINEERING Page Contract

BKE Worker discovers operator-controlled engineering pages from the Notion workspace visible to the current in-memory Notion session.

The operator enters the Notion integration secret in the Worker UI. The secret is validated and retained only in process memory; disconnect or process restart discards it.

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

Each `ENGINEERING:` page contains both normal Notion `to_do` blocks as executable tasks and one or more normal Notion tables as durable instruction templates. Worker does not cross into child pages or child databases while discovering selected-page tasks or instructions.

## TODO contract

```text
☐ Add exact current-TODO watching
☐ Certify unchecked + busy waits
☐ Certify checked advances exactly once
☐ Certify all checked stops the worker
```

The Notion block ID is task identity. Completion truth is exact block state:

```text
checked = false  -> task is not complete
checked = true   -> task is complete
```

Worker never infers completion from GitHub pushes, elapsed time, or a finished ChatGPT response.

## Durable instruction table contract

A normal table on the selected page is an instruction table only when its header row is exactly:

| KEY | NAME | INSTRUCTION |
| --- | --- | --- |
| engineering | Engineering Canonical | Establish canonical project/repository reality first. Work only on the selected TODO. Preserve architecture unless the TODO explicitly changes it. Do not merge without owner authorization. Run relevant tests. Mark the exact selected Notion TODO checked only when complete and verified. If blocked, leave it unchecked and report why. |
| audit | Audit / Read Only | Inspect canonical reality only. Do not mutate repositories, production systems, databases, or Notion state unless explicitly authorized by the selected TODO. Leave the TODO unchecked if the requested evidence cannot be established. |
| surgical | Surgical Fix | Make the smallest correct change required by the selected TODO. Do not perform unrelated cleanup or redesign. Run targeted tests. Mark the exact selected TODO checked only after the acceptance condition is satisfied. |

Multiple matching tables may exist on the same page. `KEY` values must be unique across all matching tables. Tables with other headers are ignored.

## Runtime contract

```text
Notion secret entered in UI
        ↓
in-memory Notion session
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

At START, Worker revalidates:

```text
selected page still starts with ENGINEERING:
selected TODO is currently unchecked
selected TODO belongs to that exact page
selected instruction key exists on that exact page
```

Changing or disconnecting the Notion session while the watchdog is active is rejected.

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

```text
watchdog summary        -> every 1.5 seconds
selected page options   -> every 8 seconds while idle
ENGINEERING page list   -> every 30 seconds while idle
```

The `Refresh Notion lists` button remains as an explicit manual/debug refresh. Project discovery never redirects an active run.

## Secret boundary

The Notion integration secret is not persisted by Worker. It must not be written to host environment files, state JSON, GitHub, Notion pages, logs, browser storage, or build artifacts.

The fixed ChatGPT conversation remains host configuration. The logged-in Chromium profile determines the ChatGPT account and therefore the connectors available to the engineering executor.

## Task-writing contract

Durable instructions define behavior and boundaries. TODOs define one bounded outcome.

Weak:

```text
☐ Fix BKE Worker
```

Better:

```text
☐ Make BKE Worker retrieve the exact active Notion TODO by block ID and advance only after that block reports checked=true.
```
