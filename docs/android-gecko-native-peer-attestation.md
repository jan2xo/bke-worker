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

The service keeps security-relevant state on the main-thread owner. GeckoView top-level navigation-start requests and trusted location-change callbacks both advance a navigation epoch and invalidate the prior observation. Each extension status report carries a monotonically increasing `reportSequence`; the shared `PeerTargetObservationGate` ignores out-of-order reports and accepts a target observation only when its timestamp is newer than the latest trusted navigation callback, its sequence is current, the trusted Gecko URL and reported URL both resolve to the exact HTTPS ChatGPT origin, and its age is between zero and 10 seconds. A delayed report from a prior page therefore cannot repopulate a target cleared by navigation. A disconnected/replaced native port resets the report stream and clears the observation.

Native Keystore key creation, attestation-certificate retrieval and signing run on a dedicated single-thread executor rather than the UI/main thread. Before signing, the service captures an immutable snapshot of the port, bridge, worker, session, state, navigation/target observation and recovery/readiness generations. The executor returns evidence only to a main-thread release barrier; the future resolves to evidence only if that same complete snapshot is still current and the target gate is still valid. Navigation/recovery callbacks can run while the signer is working, and any changed binding causes evidence to be discarded. The service API returns a `CompletableFuture`; callers must not block the main thread waiting for it. The private key is never exported. Software-only keys, malformed bindings, missing/incomplete attestation chains and uncertain local state fail closed.

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

- The repository contract script checks service wiring and invokes the Android JVM test task when the Android 37.1 SDK is available.
- `PeerTargetObservationGateTest` executes the same pure Kotlin state gate used by the service, covering delayed reports after cross-origin and same-origin navigation, out-of-order status, stale/future observations and a navigation transition while a signing snapshot is outstanding.
- The Android CI debug build verifies Kotlin compilation and APK assembly. The JVM reducer tests do not simulate the GeckoView OS event loop or a physical Keystore operation; physical-device acceptance is still required.
- Real-device acceptance must verify hardware-backed key generation, actual certificate chain/root/attested package digest, challenge replay rejection, key persistence/rotation, port/session replacement and wrong-worker/target rejection on a physical supported Android device.
- Human-only owner pin provisioning/revocation and live pairing remain BLOCKED / NOT RUN. No credential issuance, relay mutation, worker wake, Cloudflare deployment or production action is authorized.
