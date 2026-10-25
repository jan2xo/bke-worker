# BKE Worker personal pilot — same repository, PR #148

This is a **temporary one-worker experiment** using existing Linux/.NET + Playwright/CDP SendSmoke. No new GitHub repo, server, native controller, relay, F1-02 arbiter or production change.

**Exact assignment:** `jan2xo/bke-worker` draft [PR #148](https://github.com/jan2xo/bke-worker/pull/148), branch `pilot/one-worker-two-real-turns`, label `bke-worker:pilot-f1`.

**Only target file:** `experiments/pilot-one-worker/turns.json` on that PR branch. First autonomous turn makes `completed_turns=1`, commits, comments; second separate autonomous turn makes `completed_turns=2`, commits, comments. Never merge. No other PR/source/credential/production edits.

The runner polls GitHub every 60s, requires exactly this PR and label (no competing labels), rechecks before dispatch, uses an atomic local PENDING send journal, waits at least 30 minutes between sends, and stops after two sends. Removing its label is the kill switch for future dispatches. A crash or uncertain send requires owner recovery, not blind retry.

## Human-controlled Linux host activation

1. Use a separate human-authenticated Chromium ChatGPT profile—not your normal profile—and a dedicated existing ChatGPT conversation. Login/MFA/CAPTCHA are human-only. The host needs `gh`, `chromium`, `dotnet`, and owner-authenticated GitHub CLI read permissions.
2. On the host set `BKE_WORKER_BROWSER_CDP_ENDPOINT` to an **isolated loopback** address, e.g. `http://127.0.0.1:9222`; `BKE_WORKER_CHATGPT_PROFILE` to that actual Chromium profile folder (path includes `pilot`); `BKE_WORKER_CHATGPT_OVERRIDE_URL` to `https://chatgpt.com/c/<conversation-id>`. Use `scripts/start-chatgpt-browser.sh` to start dedicated browser with the same profile and CDP. Never commit secrets.
3. From checkout of source [PR #147](https://github.com/jan2xo/bke-worker/pull/147), run `python3 tests/sandbox_single_worker_contract.py`, then `python3 scripts/sandbox_single_worker.py --once` for no-send dry run.
4. When real browser/target and PR label are verified, set `BKE_SANDBOX_LIVE_SEND_ENABLED=YES` in this shell, run `python3 scripts/sandbox_single_worker.py --live`.

## Real acceptance (not proven by source CI)

- Two separate ChatGPT-originated commits on PR #148 (0→1 then 1→2) plus corresponding PR comments, without manual second prompt.
- Owner-observed restart, missed poll and no duplicate dispatch; later 24h soak.
- No third send and no writes outside the one file. Correct observed faults rather than add speculative features.

**Important limitation:** a GitHub connector with broad write access is not technically file-scoped by a prompt. The owner chose the existing repo; this temporary experiment is isolated by branch and exact runner checks, **not by GitHub credential scope**. Halt on unexpected mutations; don't authorize an unnecessarily privileged token. F1-03 tool-denied source remediation remains untouched.
