#!/usr/bin/env python3
from pathlib import Path

root = Path(__file__).resolve().parents[1]
workflow = (root / ".github/workflows/certify.yml").read_text(encoding="utf-8")
gradle = (root / "android-gecko/app/build.gradle.kts").read_text(encoding="utf-8")
canonical = (root / "BKE-WORKER-CANONICAL-PROJECT-EXECUTION-INSTRUCTIONS.md").read_text(encoding="utf-8")

for token in (
    "android-preproduction",
    "android_preproduction:",
    "name: Android PREPRODUCTION signed build",
    "BKE_ANDROID_PREPRODUCTION_KEYSTORE_B64",
    "BKE_ANDROID_PREPRODUCTION_STORE_PASSWORD",
    "BKE_ANDROID_PREPRODUCTION_KEY_ALIAS",
    "BKE_ANDROID_PREPRODUCTION_KEY_PASSWORD",
    "BKE_ANDROID_PREPRODUCTION_CERT_SHA256",
    "Missing required GitHub PREPRODUCTION-signing secret",
    "bke-worker-preproduction.jks",
    'gradle -p android-gecko :app:assemblePreproduction --stacktrace',
    "app-preproduction.apk",
    "apkanalyzer manifest debuggable",
    'test "$PACKAGE_NAME" = "com.bke.worker.gecko"',
    '"environment": "PREPRODUCTION"',
    '"certification_state": "preproduction-certified"',
    "bke-worker-android-preproduction-candidate",
    "Publish Android PREPRODUCTION prerelease",
    "inputs.publish_preproduction == true",
    'git merge-base --is-ancestor "$SOURCE_SHA" origin/main',
    'gh release create "$TAG"',
    "--prerelease",
):
    assert token in workflow, token

for token in (
    'providers.environmentVariable("BKE_ANDROID_PREPRODUCTION_KEYSTORE_PATH")',
    'providers.environmentVariable("BKE_ANDROID_PREPRODUCTION_STORE_PASSWORD")',
    'providers.environmentVariable("BKE_ANDROID_PREPRODUCTION_KEY_ALIAS")',
    'providers.environmentVariable("BKE_ANDROID_PREPRODUCTION_KEY_PASSWORD")',
    'create("preproduction")',
    'create("preproduction") {',
    "isDebuggable = false",
    'signingConfig = signingConfigs.getByName("preproduction")',
):
    assert token in gradle, token

# PREPRODUCTION must remain a distinct trust boundary from the production job.
pre_start = workflow.index("  android-preproduction:")
pre_end = workflow.index("  publish-android-preproduction:")
pre_job = workflow[pre_start:pre_end]
prod_start = workflow.index("  android-release:")
relay_start = workflow.index("  relay:")
prod_job = workflow[prod_start:relay_start]

for forbidden in (
    "BKE_ANDROID_SIGNING_KEYSTORE_B64",
    "BKE_ANDROID_SIGNING_STORE_PASSWORD",
    "BKE_ANDROID_SIGNING_KEY_ALIAS",
    "BKE_ANDROID_SIGNING_KEY_PASSWORD",
    "BKE_ANDROID_SIGNING_CERT_SHA256",
    "bke-worker-production.jks",
    '"certification_state": "production-candidate"',
):
    assert forbidden not in pre_job, forbidden

for forbidden in (
    "BKE_ANDROID_PREPRODUCTION_KEYSTORE_B64",
    "BKE_ANDROID_PREPRODUCTION_STORE_PASSWORD",
    "BKE_ANDROID_PREPRODUCTION_KEY_ALIAS",
    "BKE_ANDROID_PREPRODUCTION_KEY_PASSWORD",
    "BKE_ANDROID_PREPRODUCTION_CERT_SHA256",
    "bke-worker-preproduction.jks",
    "preproduction-certified",
):
    assert forbidden not in prod_job, forbidden

# Secret-bearing jobs may consume encrypted GitHub secrets but must not print or
# persist raw values into repo/artifact metadata.
for forbidden in (
    "set -x",
    'cat "$KEYSTORE_PATH"',
    'echo "$BKE_ANDROID_PREPRODUCTION_KEYSTORE_B64"',
    '"keystore_b64":',
    '"store_password":',
    '"key_password":',
):
    assert forbidden not in pre_job, forbidden

for token in (
    "encrypted GitHub Actions/Environment secrets",
    "PREPRODUCTION Android signing",
    "raw secret material",
    "production signing remains separately locked",
):
    assert token in canonical, token

print("BKE Worker Android PREPRODUCTION signing contract: PASS")
