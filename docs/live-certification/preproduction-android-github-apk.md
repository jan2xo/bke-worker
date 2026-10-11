# PREPRODUCTION Android GitHub APK Build Intent

This branch owns one bounded engineering intent:

> Make the BKE Worker Android PREPRODUCTION APK reproducibly buildable and downloadable from GitHub without requiring the operator's Mac to perform future APK builds.

## User authorization

The owner explicitly authorizes PREPRODUCTION Android signing material to be stored only in GitHub's encrypted Actions/Environment secret store for this repository.

This authorization does **not** permit:
- committing the JKS, base64 keystore, passwords, aliases, certificate material, relay tokens, webhook secrets, browser profile contents, or other credentials into repository files or Git history;
- printing secret values into logs, PR comments, artifacts, provenance files, or ChatGPT prompts;
- using or modifying production signing material;
- production deployment or production credential cutover.

Production remains locked.

## Existing local PREPRODUCTION identity

The operator already created and used this permanent PREPRODUCTION signing identity locally:

`~/.bke-secrets/signing/preproduction/android/bke-worker/bke-android-preproduction.jks`

Alias:

`bke-android-preproduction`

The existing local helper env contains these values:
- `ANDROID_KEYSTORE_B64`
- `ANDROID_KEYSTORE_PASSWORD`
- `ANDROID_KEY_ALIAS`
- `ANDROID_KEY_PASSWORD`
- `ANDROID_CERT_SHA256`

Do not copy their values into GitHub source, PR text, comments, logs, or ChatGPT.

## Required implementation

1. Preserve the existing permanent PREPRODUCTION signing identity. Do not generate a replacement key unless the owner explicitly authorizes rotation.
2. Add a PREPRODUCTION-specific GitHub Actions signing/build path, separate from production.
3. Prefer the existing intentional certification architecture in `.github/workflows/certify.yml`; do not add a third always-on CI workflow unless genuinely required.
4. Introduce a distinct certification module such as `android-preproduction` rather than misusing `android-release` / production semantics.
5. Use distinct encrypted GitHub secret names for PREPRODUCTION signing, for example:
   - `BKE_ANDROID_PREPRODUCTION_KEYSTORE_B64`
   - `BKE_ANDROID_PREPRODUCTION_STORE_PASSWORD`
   - `BKE_ANDROID_PREPRODUCTION_KEY_ALIAS`
   - `BKE_ANDROID_PREPRODUCTION_KEY_PASSWORD`
   - `BKE_ANDROID_PREPRODUCTION_CERT_SHA256`
6. Reconstruct the keystore only inside the GitHub runner temporary directory with restrictive permissions and delete/let runner teardown remove it afterward.
7. Configure a non-debuggable Android release build signed by the PREPRODUCTION identity. Keep production signing configuration isolated.
8. Verify the built APK with Android tooling:
   - APK exists;
   - `debuggable=false`;
   - signer certificate SHA-256 exactly matches the declared PREPRODUCTION certificate fingerprint secret;
   - package/application identity remains the existing BKE Worker Android identity;
   - architecture remains arm64 unless the current source intentionally supports more.
9. Produce provenance containing only non-secret metadata:
   - exact source SHA;
   - version name/code;
   - APK SHA-256;
   - signer certificate SHA-256 fingerprint;
   - environment = PREPRODUCTION.
10. Upload the signed APK and provenance to GitHub as a downloadable artifact with a practical retention period.
11. Also provide a durable GitHub-hosted way to retrieve a certified PREPRODUCTION APK later without rebuilding locally. Prefer a PREPRODUCTION prerelease/release asset or an equivalently durable GitHub-native mechanism. It must be clearly marked PREPRODUCTION and must not be represented as production.
12. Keep the pipeline manually/explicitly invoked. Do not publish signed APKs from every ordinary PR event.
13. Update the canonical Worker security wording only as narrowly as necessary to state that encrypted GitHub Actions/Environment secrets are an authorized storage boundary for PREPRODUCTION signing material, while raw secret material remains forbidden in source/history/logs/comments/artifacts/prompts.
14. Add/adjust focused contract tests so CI proves:
   - PREPRODUCTION and PRODUCTION signing names/configurations cannot be confused;
   - missing PREPRODUCTION signing secrets fail closed;
   - raw signing material is not committed or emitted;
   - production remains locked.

## Owner-only secret provisioning

If the encrypted GitHub PREPRODUCTION signing secrets are not yet present, checkpoint the PR as:

`BKE EXECUTION CHECKPOINT — OWNER BLOCKED — PREPRODUCTION SIGNING SECRETS REQUIRED`

Then release the active worker assignment rather than leaking or inventing credentials.

The owner will perform the one-time secret provisioning from the existing local PREPRODUCTION env/JKS. After the secrets exist, resume this PR and complete exact-head certification.

## Certification

Minimum complete graph:
- `android`
- new PREPRODUCTION release/signing module
- any workflow/security contract tests required by the implementation

Do not run production deployment or production signing certification.

## Completion

When implementation is complete:
1. record `BKE EXECUTION CHECKPOINT — IMPLEMENTED` with exact SHA;
2. run the minimum complete exact-head certification graph;
3. record `BKE EXECUTION CHECKPOINT — CERTIFIED` with run IDs and non-secret artifact/provenance hashes;
4. mark ready if appropriate;
5. SHA-lock squash merge only if all required proof is green;
6. verify resulting main;
7. record `BKE EXECUTION CHECKPOINT — MERGED`;
8. stop.

No unrelated refactors.
