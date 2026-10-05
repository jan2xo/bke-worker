# Android PREPRODUCTION signing certification bootstrap

## Parent authority

Parent lane: PR #40 — GitHub-hosted PREPRODUCTION Android APK signing.

PR #40 is owner-blocked on one-time provisioning of the already-existing
PREPRODUCTION signing identity into GitHub encrypted Actions/Environment
secrets. No secret values are copied into this dependency PR.

This dependency exists because the live Android Worker was certified with an
ephemeral GitHub debug signer, while later debug builds use different ephemeral
certificates. A stable PREPRODUCTION signing path is required before future APK
updates can have deterministic signing identity.

## Intent

Bootstrap the reusable GitHub-native certification and packaging path required
by the parent lane:

- add an isolated Android `preproduction` Gradle variant;
- add explicit `android-preproduction` certification;
- require the permanent PREPRODUCTION JKS only through encrypted GitHub secrets;
- fail closed when any required secret is absent;
- verify non-debuggable APK, package identity and signer fingerprint;
- emit non-secret provenance and a signed artifact;
- allow durable GitHub prerelease publication only through explicit
  `workflow_dispatch` after the exact source is already merged into `main`;
- keep production signing names, keys, jobs and semantics isolated and locked.

## Secret names

Only these PREPRODUCTION GitHub secrets are accepted by the new module:

- `BKE_ANDROID_PREPRODUCTION_KEYSTORE_B64`
- `BKE_ANDROID_PREPRODUCTION_STORE_PASSWORD`
- `BKE_ANDROID_PREPRODUCTION_KEY_ALIAS`
- `BKE_ANDROID_PREPRODUCTION_KEY_PASSWORD`
- `BKE_ANDROID_PREPRODUCTION_CERT_SHA256`

Their values are never valid PR/comment/log/artifact/prompt content.

## Certification for this bootstrap dependency

Required before merge:

- PR Guard, including `tests/android_preproduction_signing_contract.py`;
- `core`, because the certification controller and canonical security contract change;
- `android`, because the Android Gradle variant changes and must still compile.

Not yet runnable in this dependency:

- `android-preproduction` signed build, because the owner-only encrypted
  PREPRODUCTION signing secrets are not provisioned yet.

After this bootstrap merges, the parent signing lane can invoke
`android-preproduction` on an exact head once those secrets exist.

## Installation safety

Do not uninstall the currently authenticated Android Worker merely to install an
APK signed by a different certificate. Signature continuity or an explicitly
authorized migration/re-authentication plan is required.

Production remains locked.
