#!/usr/bin/env python3
from pathlib import Path
import os, subprocess, shutil, tempfile, json

root = Path(__file__).resolve().parents[1]
script = root / "scripts/prepare-chrome-native-host.sh"
text = script.read_text(encoding="utf-8")
for token in (
    'HOST_NAME="com.bke.worker.native_host"', 'Darwin|Linux)', 'unsupported operating system',
    'entry.mjs', 'host.mjs', 'validNativeHostPolicy', 'allowed_origins',
    'refusing to overwrite unknown registration', 'FAIL-CLOSED', 'rollback)',
    'BKE_NATIVE_HOST_TEST_ROOT', 'INSTALL USER-LEVEL CHROME HOST',
):
    assert token in text, token
manifest_src = (root / "browser-extension/manifest.json").read_text(encoding="utf-8")
assert "nativeMessaging" not in manifest_src
assert "wrangler deploy" not in text and "gh workflow run" not in text
# Test all filesystem effects in a disposable fake repository by copying the source tree dependencies.
with tempfile.TemporaryDirectory(prefix="bke-installer-contract-") as td:
    temp = Path(td); fake = temp / "repo"; home = temp / "home"; sandbox = temp / "sandbox"
    (fake / "scripts").mkdir(parents=True)
    (fake / "browser-extension/native-host").mkdir(parents=True)
    (fake / "browser-extension").mkdir(exist_ok=True)
    (fake / "browser-extension/manifest.json").write_text(manifest_src)
    shutil.copy2(script, fake / "scripts/prepare-chrome-native-host.sh")
    for name in ("entry.mjs", "host.mjs", "framing.mjs"):
        shutil.copy2(root / "browser-extension/native-host" / name, fake / "browser-extension/native-host" / name)
    home.mkdir(mode=0o700); sandbox.mkdir(mode=0o700)
    env = {**os.environ, "HOME": str(home), "BKE_NATIVE_HOST_TEST_ROOT": str(sandbox)}
    valid_origin = "chrome-extension://" + "a" * 32 + "/"
    env["BKE_NATIVE_HOST_EXTENSION_ORIGIN"] = valid_origin
    # inspect is read-only and doesn't need a policy or registration.
    r = subprocess.run(["bash", str(fake / "scripts/prepare-chrome-native-host.sh"), "inspect"],
                       cwd="/", env=env, capture_output=True, text=True)
    assert r.returncode == 0, (r.stdout, r.stderr)
    assert not (sandbox / "chrome").exists()
    # Unknown mode and hostile origins fail closed without creating registrations.
    for args, patch in [(["unknown"], {}), (["inspect"], {"BKE_NATIVE_HOST_EXTENSION_ORIGIN":"https://invalid.example/"})]:
        e = {**env, **patch}
        r = subprocess.run(["bash", str(fake / "scripts/prepare-chrome-native-host.sh"), *args],
                           cwd="/", env=e, capture_output=True, text=True)
        assert r.returncode != 0, r.stdout
        assert "FAIL-CLOSED" in r.stderr, r.stderr
    assert not (sandbox / "chrome").exists()
    # Missing policy makes install fail closed; no Chrome registration occurs.
    r = subprocess.run(["bash", str(fake / "scripts/prepare-chrome-native-host.sh"), "install"],
                       cwd="/", env=env, input="INSTALL USER-LEVEL CHROME HOST\n",
                       capture_output=True, text=True)
    assert r.returncode != 0
    assert "owner-pinned policy" in r.stderr
    assert not (sandbox / "chrome/NativeMessagingHosts/com.bke.worker.native_host.json").exists()
print("BKE Chrome native host installer contract: PASS")
