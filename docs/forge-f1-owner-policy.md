# F1-03 — owner-attested local Chrome binding and native policy

## Physical Mac blocker and supported entrypoint

The owner Mac passed source smoke but native-host installation blocked on missing
owner-policy.json. This PR adds an owner-operated source-only setup preflight.

After full review, certification and merge, from a clean current main checkout:

    node scripts/forge-f1-owner-policy.mjs

This MUST NOT be run from this unmerged draft or another worker's shared Chrome
profile. The command checks canonical origin, clean fetched exact current main,
Node 22+ and an interactive non-root Mac owner. **Before invoking Chrome**
(even for `--version`), it verifies the selected non-symlinked Google
Chrome.app bundle and its executable with Apple's `/usr/bin/codesign`:
Apple-generic trust anchor, exact `com.google.Chrome` code identifier,
pinned Google Team ID `EQHXZ8M8AV`, strict signed-bundle integrity and
independent metadata readback. Unsigned, wrong-signer, broken-seal, aliased,
unavailable or ambiguous app identity blocks without executing the browser.
It then validates the actual running Google Chrome process/version and
dedicated private profile chain. **Publisher signature is not OS-level
process or ChatGPT account/tab attestation.**

It reuses scripts/forge_f1_chrome_readiness.py to verify that the private
~/.bke-worker/f1/chrome-profile directory chain is safe and an actual Chrome
process uses that exact dedicated user-data-dir. It does not read browser
profile contents, Preferences, cookies, ChatGPT page text, account identifiers
or private device keys.

## Human attestation — LOCAL ONLY

In that isolated profile, the owner visually checks one enabled BKE Worker
Browser Bridge from the canonical source, finds its 32-letter extension ID,
and reads the worker ID and nonexportable P-256 *public* key SHA-256 from the
BKE extension popup. If the identity is not created, its creation is a
separate human-controlled popup action inside this dedicated profile.

The owner must confirm no other worker uses that profile, that exactly one
chatgpt.com tab is manually authenticated and idle, and that no login/MFA
or other challenges are pending. All confirmations are explicit typed input.
The script rechecks the actual Chrome process before policy creation.
If any condition is unavailable, STOP / Ctrl+C; never paste test hashes.

The owner-local-bindings.mjs helper generates four domain-separated SHA-256
local commitments for this owner-attested profile, browser profile, bridge
identity and target using the owner-supplied public extension ID, worker ID
and key thumbprint, the verified executable digest and dedicated profile path.
The Chrome profile path is used in-memory only, never written to policy or
terminal output. The target commitment proves ONLY the site and owner's
claim of one idle tab — it does NOT attest the ChatGPT account, specific
conversation, tab, browser device hardware or exclusive GitHub PR assignment.
Copying a full browser profile may copy IndexedDB CryptoKey and is not
prevented by these local hashes.

After a second explicit owner approval, the existing secure writer validates
host schema, bounded 1–30 day validity, distinct nonplaceholder hashes,
safe private directories, no symlinks, owner-only 0600 file mode, no overwrite
of prior policies and byte-for-byte readback. Chrome version/key/profile
changes require operator-led reconciliation; no silent overwrite/rekey.

The only possible success status is OWNER_POLICY_WRITTEN_LOCAL_ONLY with
OWNER_ATTESTED_LOCAL_COMMITMENTS_ONLY, independence NOT_PROVEN, pairing
authority NONE and dispatch authority NONE. It is NOT a trusted OS or server
attestation, not real native Chrome proof, and NOT REAL_CHROME_READY by itself.

## Unfinished F1-03 live gates

The PR now declares nativeMessaging only in optional_permissions, not as a
required installation permission. A Chrome extension popup action lets the
human select the owner-reviewed owner-policy.json with a file picker,
explicitly request the optional permission through Chrome's own dialog, and
then perform the existing P-256 challenge/response via native host ONLY after
the service worker verifies the popup origin, worker ID, extension origin,
public thumbprint, policy pins/expiry, one chatgpt.com tab and granted
permission. The service worker never opens the host on startup, from a web
page, from GitHub tasks, or without the owner popup action. Installation permission,
actual Chrome-to-Node signed proof, authenticated typed controller, device
binding, nonce/replay and MV3 suspend/reconnect safety, human Chrome smoke,
GitHub assignment and first ChatGPT send remain distinct unproved tasks.
No profile migration, MFA, cookie access, deployment, credentials or GitHub
worker labels are authorized by local source-only validation.

The cheap automatic exact-head PR Guard/Node tests use synthetic inputs and
disposable homes only. Keep PR #146 in DRAFT until F1-03 Issue #124 scope
is actually complete and audited; do not treat CI as physical browser proof.

## New owner opt-in Chrome-to-Node key proof (still NOT live-certified)

When independently reviewed, certified and merged, the dedicated owner Chrome
extension popup provides a local JSON file picker for the policy file created
by the owner script. Only the owner-selected file is read by the popup; the
extension never browses the OS filesystem or Chrome private profile. Clicking
Verify local native host asks Chrome for OPTIONAL nativeMessaging permission
from within a direct user gesture. Refusing permission is a safe no-op.

If permission is granted, the trusted extension popup sends only the local
policy to the service worker, which checks identity, worker, 30-day maximum
expiry, exact source pins, one matching target tab, and then attempts a single
bounded signed native-host proof using the previously implemented client.
No command execution, page JavaScript, ChatGPT prompt, server enrollment,
GitHub worker assignment, autonomous wake, credential, or real ChatGPT send
is exposed. On error, mismatch, timeout, disconnect or uncertain outcome it
fails closed. Chrome remains human-authenticated only. The real Chrome-to-Node
handshake is NOT certified by synthetic source tests and must have a separate
owner-run Mac proof. No genuine controller session exists yet; further F1-03
work and eventual final security/merge review remain required.
