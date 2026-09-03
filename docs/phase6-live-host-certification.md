# Phase 6 — Live Host / Production Adapter Certification

Status: **ACTIVE CANDIDATE — LIVE HOST PATH PROVEN MANUALLY; AUTOMATED REGRESSION REQUIRED**

Base branch:

`feat/chat-work-execution-surface-guardrail`

Base SHA:

`bc0076cfdcc29dc688fdd02511db67d813ed2e89`

Phase 6 branch:

`feat/phase6-live-host-certification`

## Why Phase 6 exists

Phases 2–5 certified the Linux worker, controlled Playwright runtime, closed loop, operator UI, and non-mutating ChatGPT adapter harness. They did **not** certify the authentication/runtime boundary of current production `chatgpt.com`.

The live-host exercise on an Ubuntu 26.04 ARM64 UTM VM exposed a real distinction:

- Playwright-managed Chromium can run controlled semantic tests.
- Google OAuth rejected the Playwright-managed Chromium login flow.
- The same OAuth flow succeeded in normal system Chromium on the same VM.
- Normal system Chromium can expose a loopback Chrome DevTools Protocol endpoint.
- BKE Worker can attach to that already-running browser through Playwright CDP instead of owning the browser login flow.

This changes the production browser boundary without changing the BKE orchestration model.

## Canonical live-host architecture

```text
GUI-CAPABLE UBUNTU HOST
        |
        | human starts normal system Chromium
        v
SYSTEM CHROMIUM
  dedicated persistent profile
  human OAuth / MFA / security challenges only
  CDP bound to 127.0.0.1:9222 only
        |
        | Playwright ConnectOverCDP
        v
BKE WORKER
        |
        +--> exact Chat Project
        +--> exact Conversation
        +--> semantic composer / busy guard
        +--> GitHub wake
        +--> Notion reconciliation
```

The worker does not automate login and does not launch a special browser for live `chatgpt.com`.

## Permanent authentication guardrail

```text
[GUARD] UNAUTHENTICATED
        |
        v
CHATGPT_AUTH_REQUIRED
        |
        +--> BLOCKED
        +--> NO Notion reconciliation
        +--> NO Project navigation
        +--> NO Conversation navigation
        +--> NO composer fill
        +--> NO prompt send
        +--> NO engineering continuation
        |
        v
HUMAN LOGIN / OAUTH / MFA
        |
        v
AUTHENTICATED
        |
        v
NORMAL OPERATION
```

Rules:

1. Authentication is human-only.
2. OAuth, MFA, CAPTCHA, security challenges, and credential entry are never automated.
3. `CHATGPT_AUTH_REQUIRED` is a hard stop before Notion reconciliation.
4. Live `chatgpt.com` requires CDP attach mode; Playwright launch mode is rejected as `LIVE_CHATGPT_REQUIRES_CDP_ATTACH`.
5. CDP must be loopback-only. Non-loopback endpoints fail as `BROWSER_CDP_ENDPOINT_MUST_BE_LOOPBACK`.
6. The browser is operator-owned. BKE Worker may attach/detach but must not close the live browser.
7. ChatGPT cookies, OAuth tokens, passwords, and browser storage must never be copied into GitHub, Notion, environment files, logs, or CI artifacts.
8. The dedicated browser profile persists across worker restarts and normal browser restarts. Reauthentication occurs only when the service actually requires it.
9. Current autonomous execution remains **Chat-only**. Work remains a separate unsupported execution surface and never receives fallback traffic.

## GUI requirement

The production host must be **GUI-capable** because authentication is deliberately human-only.

This does not require a heavyweight desktop environment as an architectural principle, but the host must provide a graphical Chromium session that an operator can reach when login, OAuth, MFA, or another security challenge is required.

Initial deployment can use Ubuntu Desktop. A later VPS optimization may use a lighter graphical session plus a remote desktop mechanism, provided the same human-auth and loopback-CDP guardrails remain intact.

## Browser runtime split

### Controlled CI / fixture testing

```text
Playwright-managed Chromium
-> local controlled fixture only
-> semantic regression
-> no production ChatGPT authentication
```

### Live host

```text
normal Ubuntu system Chromium
-> dedicated persistent profile
-> human authentication
-> localhost CDP
-> BKE Worker attaches with ConnectOverCDP
```

This split prevents live OAuth from becoming part of the autonomous worker contract.

## Operator scripts

The manual UTM discovery steps are converted into repository scripts:

- `scripts/bootstrap-linux-host.sh`
  - verifies Ubuntu/architecture;
  - installs Git, curl, jq, .NET 10, system Chromium, and PowerShell;
  - installs the pinned Playwright browser used by controlled tests;
  - creates protected config/profile/state directories;
  - runs Core and ChatGPT regression tests.

- `scripts/start-chatgpt-browser.sh`
  - starts normal system Chromium;
  - uses a dedicated BKE browser profile;
  - binds CDP to `127.0.0.1` only;
  - opens `https://chatgpt.com`;
  - leaves authentication entirely to the human operator.

- `scripts/verify-live-host.sh`
  - verifies Chromium, .NET, profile, CDP metadata, a ChatGPT tab, and loopback-only debugger exposure;
  - does not inspect or export browser credentials.

- `scripts/run-worker.sh`
  - loads the protected local environment file;
  - validates required non-browser configuration;
  - verifies the live browser first;
  - starts BKE Worker in CDP-attach mode.

- `scripts/bke-worker.env.example`
  - documents configuration keys without storing real secrets.

## Live evidence observed during Phase 6 discovery

Host:

```text
UTM on Apple Silicon
Ubuntu Desktop 26.04 ARM64
.NET 10
```

Playwright browser installation observed:

```text
chromium-1234
chromium_headless_shell-1234
ffmpeg-1011
```

System Chromium CDP evidence observed:

```text
Browser: Chrome/151.0.7922.173
Protocol-Version: 1.3
CDP endpoint: http://127.0.0.1:9222
webSocketDebuggerUrl: ws://127.0.0.1:9222/devtools/browser/...
```

Authentication evidence:

```text
Firefox on same Ubuntu VM             -> OAuth worked
normal Ubuntu system Chromium         -> OAuth worked
Playwright-managed Chromium OAuth     -> rejected by Google browser-security check
system Chromium + persistent profile  -> authenticated live browser path
system Chromium + localhost CDP       -> available for BKE Worker attach
```

These are operator-observed live-host facts, not GitHub Actions proof.

## Phase 6 automated certification goals

GitHub Actions must prove at minimum:

- Core auth hard-stop occurs before Notion reconciliation.
- Work execution surface remains fail-closed before browser/Notion activity.
- Controlled Playwright semantic regression remains green.
- Live `chatgpt.com` cannot use Playwright browser-launch mode.
- Non-loopback CDP endpoints are rejected.
- Server readiness is false for live `chatgpt.com` without loopback CDP configuration.
- Operator scripts are shell-syntax valid.
- Repository scripts never add `--no-sandbox`.

GitHub Actions cannot certify a real authenticated ChatGPT account. The final live adapter probe remains an operator-host certification step.

## Phase 6 completion boundary

Phase 6 may be called **LIVE HOST CERTIFIED** only when all of the following are recorded together:

1. exact candidate SHA;
2. green automated regression runs for that SHA;
3. live GUI host OS/architecture/browser evidence;
4. loopback CDP evidence;
5. real authenticated `chatgpt.com` adapter probe against the exact Project and Conversation;
6. probe sends no prompt;
7. one bounded live loop is completed with real Notion + GitHub webhook + ChatGPT;
8. no authentication secret is stored in GitHub, Notion, CI, or logs.

Until then, Phase 6 remains an active candidate and earlier certified phases remain preserved unchanged.
