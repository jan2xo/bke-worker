#!/usr/bin/env python3
from pathlib import Path
import os, subprocess, shutil, tempfile

root = Path(__file__).resolve().parents[1]
script = root / "scripts/prepare-chrome-native-host.sh"
text = script.read_text(encoding="utf-8")
for token in (
    'HOST_NAME="com.bke.worker.native_host"', 'Darwin|Linux)', 'unsupported OS:',
    'entry.mjs', 'host.mjs', 'validNativeHostPolicy', 'allowed_origins',
    'refusing to overwrite conflicting registration', 'FAIL-CLOSED', 'rollback)',
    'BKE_NATIVE_HOST_TEST_ROOT', 'INSTALL USER-LEVEL CHROME HOST',
):
    assert token in text, token
manifest_src = (root / "browser-extension/manifest.json").read_text(encoding="utf-8")
assert "nativeMessaging" not in manifest_src
assert "wrangler deploy" not in text and "gh workflow run" not in text
with tempfile.TemporaryDirectory(prefix="bke-installer-contract-") as td:
    temp=Path(td); fake=temp/"repo"; home=temp/"home"; sandbox=temp/"sandbox"
    (fake/"scripts").mkdir(parents=True); (fake/"browser-extension/native-host").mkdir(parents=True)
    (fake/"browser-extension/manifest.json").write_text(manifest_src)
    shutil.copy2(script,fake/"scripts/prepare-chrome-native-host.sh")
    subprocess.run(["git","init","-q",str(fake)],check=True)
    subprocess.run(["git","-C",str(fake),"config","user.email","test@example.invalid"],check=True)
    subprocess.run(["git","-C",str(fake),"config","user.name","Installer Test"],check=True)
    subprocess.run(["git","-C",str(fake),"add","."],check=True)
    subprocess.run(["git","-C",str(fake),"commit","-qm","test fixture"],check=True)
    for name in ("entry.mjs","host.mjs","framing.mjs"):
        shutil.copy2(root/"browser-extension/native-host"/name,fake/"browser-extension/native-host"/name)
    home.mkdir(mode=0o700); sandbox.mkdir(mode=0o700)
    env={**os.environ,"HOME":str(home),"BKE_NATIVE_HOST_TEST_ROOT":str(sandbox),
         "BKE_NATIVE_HOST_EXTENSION_ORIGIN":"chrome-extension://"+"a"*32+"/"}
    cmd=["bash",str(fake/"scripts/prepare-chrome-native-host.sh")]
    r=subprocess.run(cmd+["inspect"],cwd="/",env=env,capture_output=True,text=True)
    assert r.returncode==0,(r.stdout,r.stderr)
    assert not (sandbox/"chrome").exists()
    for args,patch in [(["unknown"],{}),(["inspect"],{"BKE_NATIVE_HOST_EXTENSION_ORIGIN":"https://invalid.example/"})]:
        r=subprocess.run(cmd+args,cwd="/",env={**env,**patch},capture_output=True,text=True)
        assert r.returncode!=0,r.stdout
        assert "FAIL-CLOSED" in r.stderr,r.stderr
    assert not (sandbox/"chrome").exists()
    # Test owner policy enforcement without creating any registration.
    policy=sandbox/"policy"; policy.mkdir(mode=0o700)
    policy_file=policy/"owner-policy.json"; policy_file.write_text('{"not":"a policy"}'); policy_file.chmod(0o600)
    bad_env={**env,"BKE_NATIVE_HOST_POLICY_PATH":str(policy_file)}
    r=subprocess.run(cmd+["install"],cwd="/",env=bad_env,input="INSTALL USER-LEVEL CHROME HOST\n",capture_output=True,text=True)
    assert r.returncode!=0 and "policy" in r.stderr.lower(),(r.stdout,r.stderr)
    assert not (sandbox/"chrome/NativeMessagingHosts/com.bke.worker.native_host.json").exists()
    # Conflicts are not overwritten.
    chrome=sandbox/"chrome/NativeMessagingHosts"; chrome.mkdir(parents=True,mode=0o700)
    conflict=chrome/"com.bke.worker.native_host.json"; conflict.write_text('{"unrelated":true}'); conflict.chmod(0o600)
    r=subprocess.run(cmd+["inspect"],cwd="/",env=env,capture_output=True,text=True)
    assert r.returncode!=0 and conflict.read_text()=='{"unrelated":true}'
print("BKE Chrome native host installer contract: PASS")
