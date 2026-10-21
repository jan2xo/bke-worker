# Android GeckoView native peer attestation — source contract

## What the device can produce

`AndroidPeerAttestor` owns a non-exportable P-256 signing key in Android Keystore. Key creation requests an Android key-attestation certificate chain bound to an initial 32-byte challenge, which is persisted separately as `initialAttestationChallengeBase64Url`. Each later proof carries that same initial challenge as provenance metadata and signs a separate fresh 32-byte server proof challenge as `challengeBase64Url`. The two values are intentionally distinct: Android embeds the initial challenge in the key-attestation certificate only at key creation, while every proof signature binds the current server nonce. The v1 signature is over a deterministic, length-prefixed binding containing:

1. protocol version;
2. fresh 32-byte server challenge;
3. worker ID;
4. current Android service/GeckoSession instance UUID;
5. app-install profile binding UUID;
6. current native extension-port UUID;
7. exact target origin `https://chatgpt.com`.

The service withholds evidence unless invoked on the service/main thread with its current GeckoSession, connected built-in extension native port, a fresh exact-ChatGPT HTTPS observation, READY/BUSY worker state, and no uncertain wake delivery. Observations must have a parseable ISO-8601 timestamp no more than 10 seconds old; malformed, future-dated and stale observations fail closed. Proof creation snapshots the port, bridge, worker, session, target observation and recovery/readiness generations, then revalidates them after signing and discards the evidence if any binding changed. A disconnected/replaced native port clears its binding. The private key is never exported. Software-only keys, malformed bindings, missing/incomplete attestation chains and uncertain local state fail closed.

## Required server verification (not implemented by this PR)

The result is **untrusted evidence until the server**:
- validates the complete Android key-attestation chain against an approved root, verifies the attested package name and signing-certificate digest, and checks the certificate's embedded attestation challenge against `initialAttestationChallengeBase64Url` and the server's original enrollment record;
- validates the proof `challengeBase64Url` as fresh, single-use, server-issued and scoped to the intended owner-approved proof request; maintain a separate one-time server record for the initial key-attestation challenge;
- verifies the P-256 signature over the documented v1 binary format;
- pins the resulting public key only after the existing human Admin consent/pairing flow;
- compares worker, session, profile, bridge and target bindings against server-owned assignment/session state;
- handles revocation, rotation, replay, duplicate pairing, expiry, outage and uncertain delivery without granting authority.

No browser/device-supplied `trusted` flag is accepted. A valid signature proves possession of the attested key, not owner consent or current GitHub assignment. The Android-side API is an in-process service capability; this PR does not add a public route or a relay message type and does not activate enrollment.

## Certification boundaries

- The repository contract test verifies the source wiring and fail-closed checks.
- The Android CI build verifies compilation and APK assembly only.
- Real-device acceptance must verify hardware-backed key generation, actual certificate chain/root/attested package digest, challenge replay rejection, key persistence/rotation, port/session replacement and wrong-worker/target rejection on a physical supported Android device.
- Human-only owner pin provisioning/revocation and live pairing remain BLOCKED / NOT RUN. No credential issuance, relay mutation, worker wake, Cloudflare deployment or production action is authorized.
