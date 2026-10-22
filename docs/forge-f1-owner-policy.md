# F1-03 owner-policy provisioning: first source-only slice

## Real Mac blocker
F1-01's owner Mac passed SOURCE_SMOKE, but the native-host installer correctly
blocked on a missing owner-pinned policy. Never invent the private trust pins.

After independent review and merge, from clean current main, run:

    node scripts/forge-f1-owner-policy.mjs

The program verifies canonical origin, clean current main, and a terminal
operated by a non-root human. It DOES NOT read browser profile or page data.

## Evidence that must already exist
The tool accepts only independently owner-reviewed exact values:
- allowed_origin: chrome-extension:// plus the 32 a-p ID from the isolated
  Chrome chrome://extensions page plus a final slash;
- worker_id: the same worker shown/configured in the F1 extension popup;
- public_key_sha256: the actual non-exportable P-256 public thumbprint
  displayed in that same extension's device-identity popup;
- profile_binding_sha256, browser_profile_sha256, chatgpt_target_sha256 and
  bridge_identity_sha256: independently reviewed bindings from a trusted
  owner/session/controller process — NEVER placeholders, generic URL hashes
  or random/test strings.

If any owner-reviewed pin is UNKNOWN, Ctrl+C and remain BLOCKED. The
authenticated, real Chrome-to-Node F1-03 pairing process is still missing;
today there may be no valid independent sources for the four binding pins.
This provisioning tool does NOT generate or attest them.

The tool validates the exact native-host policy schema, expiry of 1–30
days, five distinct valid hashes, and a full typed owner acknowledgement.
It writes only a 0600, non-overwriting local policy under the user's
.config/bke-worker/native-host directory, refusing unsafe owners,
permissions and symlinks. It prints no source pin values.

OWNER_POLICY_WRITTEN_LOCAL_ONLY is local review of input text, not an
independent cryptographic/device/browser/session attestation. Its pairing
and dispatch authority are both NONE. It neither grants nativeMessaging,
installs a host, enrolls a device, sends ChatGPT messages, changes Github
ownership/credentials nor deploys production or PREPRODUCTION services.

Once genuine pins and the policy exist, the already tracked human-consented
F1-01 desktop readiness tool can continue user-level host registration.
Registration is NOT a live nativeMessaging handshake; the current Chrome
extension manifest deliberately lacks nativeMessaging. Real F1-03 pairing,
replay-resistant controller, Chrome-native proof, and owner acceptance are
separate incomplete acceptance gates.

## Exact-head proof
Cheap automatic PR Guard + WebExtension/native-host Node tests are the
minimum source-only graph. Test fixtures use only disposable temp homes and
synthetic hashes, never the user's installed browser/profile.

This is the FIRST F1-03 source slice in the existing Issue #124 intent.
Keep its PR draft until the full nativeMessaging/controller and real owner
Mac handshake are implemented, reviewed and certified. Do not mark live F1
readiness or autonomous sending as successful from this provisioner.
