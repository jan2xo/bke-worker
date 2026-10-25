# Personal single-worker sandbox pilot (experimental)

**One worker, one PR, one isolated Chromium profile.** This is an intentional, temporary Linux/.NET + Playwright/CDP experiment, **not** activation of the desktop WebExtension F1-03 code, production, Android, or the dormant F1 claim ref. GitHub remains the engineering authority.

## Actual user outcome

After one-time human setup, the owner assigns exactly one OPEN PR in **jan2xo/bke-worker-sandbox** with label `bke-worker:pilot-f1`. This pilot polls GitHub once per minute. It checks exactly one assigned PR and head; no GitHub mutation occurs in the runner. When eligible it invokes the **existing** `scripts/send-chatgpt-live.sh` tool against a dedicated **existing ChatGPT conversation** that the human authenticated. Once dispatched, it waits at least 30 minutes before a further turn; new commits can be considered at the next eligible turn. The fixed prompt tells ChatGPT to write and checkpoint only that sandbox PR using its existing connected GitHub app.

This is a first live experiment, **not a certified unattended system**. ChatGPT itself may not execute the requested PR. The first real commit/checkpoint and later continuation must be witnessed; do not claim success from a shell dispatch alone.

## One-time human setup (Linux host with existing dotnet/chromium/gh)

1. Create the throwaway private repository `jan2xo/bke-worker-sandbox` using your authenticated GitHub account, and open a tiny disposable PR in it. The connected GitHub tool cannot create new repositories; no such repository is claimed to exist yet.
2. Install/authenticate `gh` normally, with **read access only required by this polling runner**. Authenticate ChatGPT **manually** in a dedicated existing Chromium profile, and open **one dedicated conversation**; never use your normal default browser profile or automate OAuth/MFA/CAPTCHA.
3. Configure these owner-machine environment variables, in the same shell (never commit their values):
   - `BKE_WORKER_BROWSER_CDP_ENDPOINT`: loopback HTTP CDP for the dedicated profile, e.g. `http://127.0.0.1:9222`.
   - `BKE_WORKER_CHATGPT_PROFILE`: the actual isolated profile path containing `sandbox` or `pilot` in its name.
   - `BKE_WORKER_CHATGPT_OVERRIDE_URL`: dedicated, manually authenticated `https://chatgpt.com/c/<conversation-id>` URL.
   - `BKE_SANDBOX_LIVE_SEND_ENABLED=YES`: explicit human opt-in to actual sandbox messages.
4. From a clean checked-out release that includes this source, verify `python3 tests/sandbox_single_worker_contract.py`, then `python3 scripts/sandbox_single_worker.py --once` (read-only dry run). Only after the owner verified profile/target and a disposable PR bears exactly one `bke-worker:pilot-f1` label, start `python3 scripts/sandbox_single_worker.py --live`. This calls the unchanged Linux `send-chatgpt-live.sh`; it **does not** work on this ChatGPT cloud session or without the owner's running Chrome.
5. Kill switch: **remove `bke-worker:pilot-f1` from the sandbox PR or stop the pilot process**. Removing the label prevents the next send, but cannot recall an already-submitted ChatGPT turn.

## Minimal bounded constraints

- Repository is hard-coded to the sandbox. The pilot refuses forks, ambiguous worker labels, multiple matching PRs, unreadable GitHub inventory and changed assignment.
- No HMAC webhook needed for v0: polling catches a missed event and makes no public listener. No additional Cloudflare worker, server, PR claim ref or task database. The local journal only tracks uncertain sends and rate/heartbeat, **not work assignments**.
- Journal defaults to `~/.local/state/bke-worker/sandbox-f1.json`; first send is durably marked PENDING before browser I/O. Crash/nonzero browser dispatch leaves an **owner-recovery block**: no automatic resend. There is no secret or ChatGPT profile content in the journal. A local process lock prevents duplicate pilot processes.
- Maximum **3 submissions/hour**, minimum **30 minutes between sends**; no automatic merge, secret change or production action.
- The existing SendSmoke adapter checks an idle ChatGPT composer before sending; browser-side outcomes can still be ambiguous. This experiment must be treated as **owner-observed**, not ready for unattended production use.

## Definition of done, NOT YET MET

- One sandbox PR receives a real commit and causal checkpoint from a worker-initiated ChatGPT turn.
- At least one autonomous follow-up turn occurs without manual prompting and advances the same PR.
- Browser restart / missed webhook recovery is observed without duplicate prompt submission; then a 24-hour owner-observed soak.
- If any step fails, record the first causal blocker in this pilot PR, fix only that observed problem, and rerun the narrow proof. **Do not resume expanding F1-02 or F1-03 as a prerequisite for this sandbox experiment.**

The previous F1-03 controller source-write security denial remains binding. This pilot uses a separate pre-existing legacy send-smoke adapter only, with no attempt to rewire or bypass that denied controller implementation.
