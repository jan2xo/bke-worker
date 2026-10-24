# F1-03 controller source stage — current capabilities and held activation

**Scope:** `jan2xo/bke-worker` [F1-03 PR #146](https://github.com/jan2xo/bke-worker/pull/146), experimental desktop Chrome WebExtension ↔ Node native messaging. **DRAFT / NOT MERGED / NOT PHYSICALLY CONTROLLER-CERTIFIED.** Source and synthetic CI results are not evidence of owner-machine installation, permitted Chrome messaging or an authenticated ChatGPT account.

## Implemented source — distinguish primitive from activation

1. `controller-admission.mjs` validates an **independently owner-pinned Ed25519 public controller principal**, a strictly typed one-use challenge/response and domain-separated signature over the original local P-256 client/server nonces, fresh controller nonce, expiry, worker, Chrome origin, bridge, dedicated browser profile and ChatGPT target commitments. Bad/effectful frames deny. Four `O_EXCL`, `O_NOFOLLOW`, fsync'd owner-private local worker/profile/target/bridge reservation fences persist after crash/timeout and require explicit reviewed human recovery; no automatic takeover.
2. `controller-transport.mjs` carries that challenge over one owner-private Unix-domain socket; it authenticates the independent controller signature rather than trusting the socket pathname. Node-to-Node socket tests run the transport and adversarial cases. **No GitHub lease or real target/account attestation is established.**
3. `host.mjs` now has a **test-injectable** `controller_probe` branch, but only after the same-channel genuine local P-256 proof and strictly typed `LOCAL_READ_ONLY_PING/PONG` exchange. Without trusted controller options the branch explicitly rejects. It returns `CONTROLLER_AUTH_READ_ONLY_ACK` with `dispatch_authority=NONE` and `message_send_authority=NONE`. Do not mistake this for a ChatGPT controller with send privileges.
4. `controller-config.mjs` checks owner-private, non-symlinked, digest-pinned controller policy bytes against the existing host policy, worker, owner-pinned extension origin and profile/target/bridge resource commitments; it accepts an independent **public** Ed25519 key. `entry.mjs` accepts only a launcher-supplied third argument containing the pinned SHA-256 for the sibling config.
5. `scripts/prepare-chrome-native-host.sh` transactionally stages, hashes, verifies and rolls back the controller modules and controller-config file; **the only config installed today is** `{"enabled":false,"version":1}` (with a newline) and therefore evaluates to **no controller options**. The pre-existing popup/service worker/native proof client only initiate **local P-256 + read-only echo**, not `controller_probe`.

## What remains blocked

- **Controller owner provisioning:** no installed, enabled, owner-reviewed Ed25519 principal+socket+fence config, trusted runtime controller signer, or consent-based verified transition from disabled to enabled. The current installer cannot itself perform that transition.
- **Browser integration:** the installed local native-host controller branch is not initiated by the existing popup/service worker. A proposed browser-activation source write was safety-blocked before mutation; **do not bypass or repackage that blocked code edit**.
- **Physical proof:** no current-head signed owner-Chrome ↔ Node authenticated nativeMessaging controller session, controller challenge or adversarial MV3 suspend/restart replay/exclusivity test. The separately verified owner-Mac signed Chrome PID/private profile at older PR head `3408af7e…` proves only its read-only prerequisite, not the current integration.
- **Independent audit and release:** no separate-actor final exact-head source/security audit; no complete F1-03 live certification; no approved merge. Clean/current-`main` provenance, explicit owner consent, human-controlled ChatGPT authentication, and production/PREPRODUCTION locks remain mandatory.

## Current source test entrypoints

`cd browser-extension && node --test native-host/tests/controller-admission.test.mjs native-host/tests/controller-transport.test.mjs native-host/tests/controller-config.test.mjs native-host/tests/host.test.mjs`

The source graph is automatically checked by PR Guard on exact head; prior green CI cannot certify a changed head. Synthetic test success must be labeled separately from real owner Chrome acceptance. There is **no authorized GitHub assignment, ChatGPT send, production or cloud mutation** in F1-03.
