# Phase 4 — BKE Worker Operator Control Surface

## Mission

Add an actual operator-facing UI to the certified BKE Worker runtime without changing the orchestration architecture.

## Architecture

```text
BKE.Worker.Server
  -> existing WorkerLoop / state / wake queue
  -> existing Notion / ChatGPT / GitHub adapters
  -> operator control HTTP endpoints
  -> static web control surface served by the same process
```

## Operator surface

The UI shows:

- current runtime state;
- readiness and connection state;
- exact ChatGPT Project and Conversation target;
- Notion page and current checklist gate;
- locked continuation instruction;
- last dispatch, reconciliation, and GitHub delivery evidence;
- configuration presence without exposing credentials;
- browser profile directory;
- manual Force Reconcile control;
- direct Open ChatGPT navigation.

## Boundary

Phase 4 does not change completion truth, event ownership, or state transitions.

- Notion remains completion truth.
- GitHub push remains the primary external wake signal.
- Manual Force Reconcile is an operator recovery action using `WorkerWakeReason.Manual`.
- The UI never receives Notion tokens or GitHub webhook secrets.
- Pause/stop lifecycle remains owned by the host service manager for this phase rather than inventing a second lifecycle authority.

## Automated certification

GitHub Actions must boot the actual published server, serve the actual UI, render it in real Playwright Chromium, verify live state/target/configuration data, click Force Reconcile, prove that the manual wake reaches the real WorkerLoop, and prove secrets are absent from the browser DOM and `/control/summary` response.
