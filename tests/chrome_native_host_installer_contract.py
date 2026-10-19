#!/usr/bin/env python3
from pathlib import Path
import subprocess

root = Path(__file__).resolve().parents[1]
script = root / "scripts/prepare-chrome-native-host.sh"
text = script.read_text(encoding="utf-8")
for token in (
    'HOST_NAME="com.bke.worker.native_host"',
    'Darwin|Linux)',
    'unsupported operating system',
    'entry.mjs',
    'host.mjs',
    'validNativeHostPolicy',
    'allowed_origins',
    'refusing to overwrite unknown registration',
    'FAIL-CLOSED',
    'rollback)',
    'BKE_NATIVE_HOST_TEST_ROOT',
    'INSTALL USER-LEVEL CHROME HOST',
    'NATIVE_HOST',
):
    assert token in text, token
assert "nativeMessaging" not in (root / "browser-extension/manifest.json").read_text()
assert "production" not in text.lower() or "no production" in text.lower()
result = subprocess.run(["bash", str(script)], cwd="/", capture_output=True, text=True, env={
    **__import__("os").environ,
    "BKE_NATIVE_HOST_TEST_ROOT": str(root / ".bke-test-root-do-not-create"),
})
# A test root must already exist; failure is expected and must not cause writes.
assert result.returncode != 0
assert not (root / ".bke-test-root-do-not-create").exists()
print("BKE Chrome native host installer contract: PASS")
