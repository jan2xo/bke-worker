#!/usr/bin/env python3
from pathlib import Path
import os
import subprocess
import shutil

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
):
    assert token in text, token
assert "nativeMessaging" not in (root / "browser-extension/manifest.json").read_text(encoding="utf-8")
assert "wrangler deploy" not in text and "gh workflow run" not in text
assert "PRODUCTION" not in text
missing = root / ".bke-test-root-not-created"
env = {**os.environ, "BKE_NATIVE_HOST_TEST_ROOT": str(missing),
       "BKE_NATIVE_HOST_EXTENSION_ORIGIN": "chrome-extension://" + "a" * 32 + "/"}
r = subprocess.run(["bash", str(script), "inspect"], cwd="/", env=env,
                   stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
assert r.returncode != 0, r.stdout
assert not missing.exists()
tmp = Path(os.environ.get("TMPDIR", "/tmp")) / ("bke-installer-contract-" + str(os.getpid()))
tmp.mkdir(mode=0o700)
try:
    env["BKE_NATIVE_HOST_TEST_ROOT"] = str(tmp)
    env["BKE_NATIVE_HOST_EXTENSION_ORIGIN"] = "https://invalid.example/"
    r = subprocess.run(["bash", str(script), "inspect"], cwd="/", env=env,
                       stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
    assert r.returncode != 0
    assert "FAIL-CLOSED" in r.stderr
    assert not (tmp / "chrome").exists()
finally:
    shutil.rmtree(tmp)
print("BKE Chrome native host installer contract: PASS")
