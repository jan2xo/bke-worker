#!/usr/bin/env python3
from pathlib import Path

root = Path(__file__).resolve().parents[1]
workflow = (root / ".github/workflows/certify.yml").read_text(encoding="utf-8")
gradle = (root / "android-gecko/app/build.gradle.kts").read_text(encoding="utf-8")
canonical = (root / "BKE-WORKER-CANONICAL-PROJECT-EXECUTION-INSTRUCTIONS.md").read_text(encoding="utf-8")
pinned_signer = (root / "android-gecko/preproduction-signing-cert.sha256").read_text(encoding="utf-8").strip().lower()
assert len(pinned_signer) == 64 and all(ch in "0123456789abcdef" for ch in pinned_signer)

for token in (
    "android-recovery",
    "android-recovery-github",
    "android_recovery:",
    "android_recovery_github:",
    "name: Android recovery local contract",
    "name: Android recovery GitHub signed APK build",
    "BKE_ANDROID_PREPRODUCTION_KEYSTORE_B64",
    "BKE_ANDROID_PREPRODUCTION_STORE_PASSWORD",
    "BKE_ANDROID_PREPRODUCTION_KEY_ALIAS",
    "BKE_ANDROID_PREPRODUCTION_KEY_PASSWORD",
    "BKE_ANDROID_PREPRODUCTION_CERT_SHA256",
    "bke-worker-recovery-preproduction.jks",
    "BKE_ANDROID_RECOVERY_KEYSTORE_PATH",
    "BKE_ANDROID_RECOVERY_STORE_PASSWORD",
    "BKE_ANDROID_RECOVERY_KEY_ALIAS",
    "BKE_ANDROID_RECOVERY_KEY_PASSWORD",
    "python3 tests/android_recovery_signing_contract.py",
    "python3 tests/android_recovery_operator_contract.py",
    "gradle -p android-gecko :app:assembleRecovery --stacktrace",
    "app-recovery.apk",
    "android-gecko/preproduction-signing-cert.sha256",
    'test "$SECRET_SIGNER" = "$EXPECTED_SIGNER"',
    'test "$SIGNER_SHA256" = "$EXPECTED_SIGNER"',
    'test "$DEBUGGABLE" = "true"',
    'test "$PACKAGE_NAME" = "com.bke.worker.gecko.recoverycert"',
    '"workflow_run_id": int(os.environ["GITHUB_RUN_ID"])',
    '"package_name": "com.bke.worker.gecko.recoverycert"',
    '"signing_authority": "PREPRODUCTION"',
    '"certification_state": "recovery-cert-certified"',
    "bke-worker-android-recovery-sidecar",
    "ANDROID_RECOVERY_REQUIRED:",
    "ANDROID_RECOVERY_RESULT:",
    "ANDROID_RECOVERY_GITHUB_REQUIRED:",
    "ANDROID_RECOVERY_GITHUB_RESULT:",
):
    assert token in workflow, token

for token in (
    'create("recovery")',
    'applicationIdSuffix = ".recoverycert"',
    'versionNameSuffix = "-recoverycert"',
    'manifestPlaceholders["appLabel"] = "BKE Worker Recovery Cert"',
    "isDebuggable = true",
    'create("recovery")',
    'providers.environmentVariable("BKE_ANDROID_RECOVERY_KEYSTORE_PATH")',
    'providers.environmentVariable("BKE_ANDROID_RECOVERY_STORE_PASSWORD")',
    'providers.environmentVariable("BKE_ANDROID_RECOVERY_KEY_ALIAS")',
    'providers.environmentVariable("BKE_ANDROID_RECOVERY_KEY_PASSWORD")',
    'signingConfig = signingConfigs.getByName("recovery")',
):
    assert token in gradle, token

local_start = workflow.index("  android-recovery:")
github_start = workflow.index("  android-recovery-github:")
end = workflow.index("  android-preproduction:")
local_job = workflow[local_start:github_start]
job = workflow[github_start:end]

for token in (
    "name: Android recovery local contract",
    "python3 tests/android_gecko_probe_contract.py",
    "python3 tests/android_recovery_operator_contract.py",
    "python3 tests/android_recovery_signing_contract.py",
    "git diff --check",
):
    assert token in local_job, token

for forbidden in (
    "setup-java",
    "setup-android",
    "sdkmanager",
    "setup-gradle",
    "assembleRecovery",
    "upload-artifact",
    "BKE_ANDROID_PREPRODUCTION_",
):
    assert forbidden not in local_job, forbidden

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
