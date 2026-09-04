# BKE Worker — ENGINEERING Page Contract

BKE Worker discovers operator-controlled engineering pages from the Notion workspace visible to the current in-memory Notion session.

The operator enters the Notion integration secret in the Worker UI. The secret is validated and retained only in process memory; disconnect or process restart discards it.

The operator also enters the exact deterministic ChatGPT conversation URL in the Worker UI. It must be HTTPS on `chatgpt.com` and contain `/c/<conversation-id>`. Project conversation URLs are valid because the exact `/c/<id>` path remains the execution target. The URL is held only in process memory and is discarded on clear or restart.

A page becomes discoverable only when its title starts with:

```text
ENGINEERING:
```

The title is discovery/display metadata only. At START, Worker locks the exact selected Notion page ID and exact selected TODO block ID.

```text
NAMES DISCOVER.
IDS EXECUTE.
URLS TARGET EXACTLY.
```

## Selected-page content

Each `ENGINEERING:` page contains normal Notion `to_do` blocks as executable tasks and normal Notion tables as durable instruction templates. Worker does not cross into child pages or child databases for selected-page task or instruction control data.

Completion truth is exact block state:

```text
checked = false  -> task is not complete
checked = true   -> task is complete
```

A normal table is an instruction table only when its header is exactly:

| KEY | NAME | INSTRUCTION |
| --- | --- | --- |
| engineering | Engineering Canonical | Establish canonical project/repository reality first. Work only on the selected TODO. Run relevant tests. Mark the exact TODO checked only when complete and verified. |
| audit | Audit / Read Only | Inspect only. Do not mutate systems unless explicitly authorized. |
| surgical | Surgical Fix | Make the smallest correct change required by the selected TODO. |

## Runtime contract

```text
Notion secret entered in UI
        ↓
in-memory Notion session
        ↓
ENGINEERING: discovery
        ↓
exact selected page ID
        ↓
exact TODO block ID + durable instruction
        ↓
exact ChatGPT /c/<conversation-id> URL entered in UI
        ↓
START
        ↓
watch exact Notion block + execute exact browser conversation
```

At START, Worker revalidates the selected page prefix, exact unchecked TODO membership, and same-page instruction key. Changing/disconnecting either the Notion session or ChatGPT target while active is rejected.

## Watchdog behavior

```text
current TODO unchecked + ChatGPT busy
-> wait

current TODO unchecked + ChatGPT idle
-> continue SAME TODO after retry guard

current TODO checked
-> read only the locked page
-> choose first verified unchecked TODO
-> dispatch it when ChatGPT is safe

no unchecked TODOs remain
-> COMPLETE
```

## Operator refresh behavior

```text
watchdog summary        -> every 1.5 seconds
selected page options   -> every 8 seconds while idle
ENGINEERING page list   -> every 30 seconds while idle
```

The `Refresh Notion lists` button remains as an explicit manual/debug refresh.

## Session boundary

Neither the Notion integration secret nor the exact ChatGPT target URL belongs in host environment files. Worker keeps both in process memory only. The ChatGPT target URL is deliberately absent from Worker state JSON; persistent state retains only Notion/project/task execution identity.

The logged-in persistent Chromium profile determines the ChatGPT account and therefore the GitHub/Notion connectors available to the engineering executor. Keep Chromium CDP loopback-only.
