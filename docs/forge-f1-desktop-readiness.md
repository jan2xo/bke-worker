# FORGE F1-01 — desktop Chrome readiness

## Purpose

The one-command owner entrypoint is:

    bash scripts/forge-f1-desktop-readiness.sh

Run it from a clean checkout of the canonical jan2xo/bke-worker main. It verifies source provenance, builds and validates the Manifest V3 extension, runs the existing source-only native subprocess smoke, then checks a dedicated real Google Chrome profile. Browser setup and authentication remain under human control.

## What it checks

- Canonical repository origin, clean main, current origin/main SHA, source-smoke SHA, Node runtime SHA-256, and official Google Chrome version/runtime SHA-256.
- One private user-controlled profile at ~/.bke-worker/f1/chrome-profile and a Chrome process attached to that exact profile. It will not attach to or read the default browser profile.
- Exactly one enabled extension loaded from the canonical browser-extension folder, at the manifest version and with the intentionally narrow storage and chatgpt.com host permissions. Extension ID/path/version are explicitly owner-verified through chrome://extensions; the script never reads Chrome Preferences or other profile metadata.
- Exact native-host registration name bke.worker.desktop, extension-origin binding and the existing owner-pinned policy verification.
- Human visual attestations for profile exclusivity, exactly one open chatgpt.com tab, and a manually authenticated idle ChatGPT UI. It does not read cookies, local storage, page text or login secrets.

When no isolated profile exists, creating and launching one requires the exact in-script owner acknowledgement CREATE_AND_LAUNCH_ISOLATED_CHROME_PROFILE. The operator authenticates manually and loads the unpacked extension from chrome://extensions. If a matching native-host registration is absent, the existing transactional installer is offered only after PREPARE_USER_LEVEL_CHROME_NATIVE_HOST; its own install acknowledgement and a pre-existing valid owner policy are required. It never invents identity pins or overwrites conflicting files.

## Result meanings

- SOURCE_SMOKE_PASS is source build/manifest validation and the synthetic Node native-subprocess suite passing on the exact current main SHA.
- REAL_CHROME_READY is an operator-side readiness checkpoint: the live Chrome executable, dedicated profile/process, extension ID/version/path, native-host registration/policy, one chatgpt.com target, and human authentication/idle attestations met the checks.
- BLOCKED includes stable reason codes. Do not interpret it as a pass or bypass it.

The manifest deliberately still has only storage permission and https://chatgpt.com/* host permission. Consequently, this task does not prove a Chrome-launched native-messaging handshake: nativeMessaging remains absent by design and the report explicitly labels the live connection NOT_TESTED. Pairing/transport, GitHub assignment authority, first-message submission, conversation-ID reconciliation, autonomous wake and enrollment remain absent.

## Privacy and authority

The private local report stores commit SHA, executable SHA-256 hashes, extension ID/version, status codes, and hashes of the selected profile/source paths; it does not serialize raw paths, cookies, page content, prompts, credentials, extension storage or ChatGPT conversation IDs. It records NOT_CREATED_NO_SEND_OCCURRED. The script never sends a message, grants permissions, invokes CDP/Playwright, registers a worker, or deploys cloud resources.

REAL_CHROME_READY is not worker enrollment, authenticated GitHub attempt/fence, send permission, unattended wake, or production/PREPRODUCTION activation. Production remains locked.
