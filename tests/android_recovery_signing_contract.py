#!/usr/bin/env python3
from pathlib import Path

root = Path(__file__).resolve().parents[1]
workflow = (root / ".github/workflows/certify.yml").read_text(encoding="utf-8")
gradle = (root / "android-gecko/app/build.gradle.kts").read_text(encoding="utf-8")
canonical = (root / "BKE-WORKER-CANONICAL-PROJECT-EXECUTION-INSTRUCTIONS.md").read_text(encoding="utf-8")

for token in (
    "android-recovery",
    "android_recovery:",
    "name: Android recovery sidecar stable signed build",
    "BKE_ANDROID_PREPRODUCTION_KEYSTORE_B64",
    "BKE_ANDROID_PREPRODUCTION_STORE_PASSWORD",
    "BKE_ANDROID_PREPRODUCTION_KEY_ALIAS",
    "BKE_ANDROID_PREPRODUCTION_KEY_PASSWORD",
    "BKE_ANDROID_PREPRODUCTION_CERT_SHA256",
    "bke-worker-recovery-preproduction.jks",
    "python3 tests/android_recovery_signing_contract.py",
    "gradle -p android-gecko :app:assembleRecovery --stacktrace",
    "app-recovery.apk",
    'test "$DEBUGGABLE" = "true"',
    'test "$PACKAGE_NAME" = "com.bke.worker.gecko.recoverycert"',
    '"signing_authority": "PREPRODUCTION"',
    '"certification_state": "recovery-cert-certified"',
    "bke-worker-android-recovery-sidecar",
    "ANDROID_RECOVERY_REQUIRED:",
    "ANDROID_RECOVERY_RESULT:",
):
    assert token in workflow, token

for token in (
    'create("recovery")',
    'applicationIdSuffix = ".recoverycert"',
    'versionNameSuffix = "-recoverycert"',
    'manifestPlaceholders["appLabel"] = "BKE Worker Recovery Cert"',
    "isDebuggable = true",
    'signingConfig = signingConfigs.getByName("preproduction")',
):
    assert token in gradle, token

start = workflow.index("  android-recovery:")
end = workflow.index("  android-preproduction:")
job = workflow[start:end]

for forbidden in (
    "BKE_ANDROID_SIGNING_KEYSTORE_B64",
    "BKE_ANDROID_SIGNING_STORE_PASSWORD",
    "BKE_ANDROID_SIGNING_KEY_ALIAS",
    "BKE_ANDROID_SIGNING_KEY_PASSWORD",
    "BKE_ANDROID_SIGNING_CERT_SHA256",
    "bke-worker-production.jks",
    '"certification_state": "production-candidate"',
    "set -x",
    'cat "$KEYSTORE_PATH"',
    'echo "$BKE_ANDROID_PREPRODUCTION_KEYSTORE_B64"',
    '"keystore_b64":',
    '"store_password":',
    '"key_password":',
):
    assert forbidden not in job, forbidden

for token in (
    "encrypted GitHub Actions/Environment secrets",
    "PREPRODUCTION Android signing",
    "raw secret material",
    "production signing remains separately locked",
):
    assert token in canonical, token

print("BKE Worker Android recovery stable signing contract: PASS")
