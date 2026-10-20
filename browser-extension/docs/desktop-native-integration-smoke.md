# Desktop WebExtension ↔ native-host integration smoke

## Scope

This source-only smoke harness composes the merged WebExtension P-256 identity/proof client with the merged Node native-host executable in a real child process. The client is provided a narrow, injected connectNative-shaped test adapter that transports actual Chrome-native-messaging-compatible length-prefixed JSON over the child's stdin/stdout. The private device key is a disposable non-exportable WebCrypto P-256 CryptoKey in an isolated in-memory test store; test policy files are disposable owner-only temporary files.

It exercises the wire and proof contract across a process boundary, not a real installed extension. The eight protocol cases prove the happy-path nonce/signature exchange and fail-closed rejection of an invalid extension origin, forged launch-origin argument, challenge tampering, signature tampering, proof replay across process sessions, duplicate HELLO delivery, and host disconnect. The boundary test also asserts that the extension manifest still omits nativeMessaging and the client remains unwired from the service worker and popup.

## Owner-controlled one-command smoke

From any worktree of the canonical repository, run:

**bash scripts/smoke-desktop-native-integration.sh**

Use this entrypoint after the smoke harness has merged to main. The entrypoint validates the canonical origin, fetches current origin/main, creates a disposable detached worktree at that exact SHA, and runs the Node 22 smoke suite there. It does not modify tracked source files in the caller's checkout. It writes only the ignored JSON evidence report under artifacts/desktop-native-smoke/, does not open a browser or inspect a browser profile, and does not edit an extension manifest, register a Chrome host, enable permissions, or perform any network/device enrollment. Node packages are installed in the disposable worktree with install scripts disabled. Before merge, the PR Guard runs the same suite directly against the exact PR head.

The JSON evidence report is written under:

**artifacts/desktop-native-smoke/**

It includes source SHA, Node/platform identity, named test results, PASS/FAIL status, and explicit trust-boundary fields. Reports never include private keys, browser data, environment secrets, raw message payloads, or test stderr. The build/test exit status determines PASS/FAIL. Even a PASS always records real Chrome acceptance as NOT_RUN.

## What the evidence does—and does not—mean

| Evidence layer | What is exercised | What it does not establish |
| --- | --- | --- |
| Native-host installation integrity (Worker #110) | Separate source component checks externally owner-pinned installed bytes/transaction state | It does not authenticate a running browser or session. This smoke report does not claim the installed Chrome host was verified. |
| Process provenance (Worker #111) | Separate Linux-only source component checks an immediate parent executable against owner-pinned path/SHA256 evidence | This smoke does not claim its parent is Chrome, does not prove macOS behavior, and does not authenticate an extension or profile. |
| Extension/native protocol | A genuine Node host child process validates framing, challenge fields, non-exportable P-256 key-possession signature and replay/tamper boundaries using an injected port adapter | The adapter is not chrome.runtime.connectNative; Chrome has not launched the extension or host. |
| Browser-session authentication | Not exercised | No active Chrome profile, authenticated ChatGPT tab/session, or live extension runtime is proved. |
| Command Center authority | Explicitly NONE | No paired/active worker, authenticated server session, consent, GitHub assignment, wake, or dispatch authority is issued. |

The host's LOCAL_PROOF_OK receipt means only that the process accepted one local proof under the disposable policy supplied to the test. It is not OS/Chrome attestation or Command Center admission.

## Live acceptance blocker

**Real Chrome acceptance is owner-blocked and intentionally not run by this intent.** The extension's Manifest V3 permission list remains ["storage"], with no nativeMessaging; the host remains unregistered. The task authorization forbids real Chrome registration or permission changes without separate explicit authorization and certification. Never reinterpret a Node subprocess/injected-port PASS as an installed or authenticated Chrome session.

A future live-acceptance intent must separately define and authorize the owner-controlled Chrome registration/permission steps, supported OS/browser, a real isolated test profile, and independently verified installation/process/session/Command Center trust gates. It must retain human-owned authentication and must not read or share any other worker's profile.

## Reproduction and CI

The package command **npm run smoke:native -- --report <absolute-report-path>** builds TypeScript and runs only this dedicated integration suite with Node's TAP reporter, writing a machine-readable JSON result even on failure. The existing npm run check continues to run the full WebExtension and native-host adversarial suites. The PR Guard stores the dedicated report as an Actions artifact for exact-head evidence.

No real Chrome, nativeMessaging grant, host registration, credentials, browser-profile access, Cloudflare deployment, production/PREPRODUCTION activation, or Worker assignment/dispatcher change is performed.
