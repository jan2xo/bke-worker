# BKE Worker personal pilot — Mac, existing repo, PR #148

**Run on your Mac, not Linux.** GeckoView remains the selected Android surface. The BKE WebExtension is the selected desktop architecture but is still probe-only. This throwaway two-turn experiment temporarily reuses the old .NET Playwright/CDP sender **on Mac**, and does not change the selected architecture or activate the F1-03 held controller.

## One Mac operator command

Once you have a checkout of implementation [PR #147](https://github.com/jan2xo/bke-worker/pull/147):

```bash
bash scripts/pilot-macos.sh
```

The script checks GitHub CLI, Python, jq, .NET 10 SDK and installed Google Chrome, uses the official **interactive human** GitHub CLI login only if needed, opens Chrome in a separate Mac profile under `~/Library/Application Support/BKE-Worker/pilot-f1-profile`, asks you to sign in to ChatGPT manually, and prompts for the dedicated conversation URL. It runs focused tests and a no-send dry run; only typing `SEND` initiates real messages.

If prerequisites are missing: `brew install gh jq python` and `brew install --cask dotnet-sdk`. No extra `chromium` binary or GeckoView Mac app required.

## Scope and success

- Only `jan2xo/bke-worker` draft [PR #148](https://github.com/jan2xo/bke-worker/pull/148), exact branch `pilot/one-worker-two-real-turns`, sole label `bke-worker:pilot-f1`.
- Only experimental JSON file `experiments/pilot-one-worker/turns.json` on that PR branch. First real ChatGPT→GitHub turn must increment 0→1 with commit+checkpoint; a later independent autonomous turn increments 1→2 with new commit+checkpoint.
- Poll every 60 seconds, minimum 30-minute cooldown, at most two submitted prompts, no merge. Removing label or stopping process prevents subsequent sends. Crash or unknown browser result blocks instead of blind retry.
- No new repo, Cloudflare service, WebExtension controller activation, Android changes, production action or secret handling.

## Acceptance is LIVE / NOT_RUN

CI does not prove ChatGPT can perform the task. Actual PR #148 commits and comments, browser restart, and no-duplicate behavior must be observed. A broadly authorized ChatGPT GitHub connector is not technically file-scoped by the prompt; stop if it edits other files. Existing F1-03 source-write safety denial is unchanged.
