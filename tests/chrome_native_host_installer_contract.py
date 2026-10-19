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
    for d in (fake, fake/"scripts", fake/"browser-extension", fake/"browser-extension/native-host"):
        d.chmod(0o700)
    shutil.copy2(script,fake/"scripts/prepare-chrome-native-host.sh")
    subprocess.run(["git","init","-q",str(fake)],check=True)
    subprocess.run(["git","-C",str(fake),"config","user.email","test@example.invalid"],check=True)
    subprocess.run(["git","-C",str(fake),"config","user.name","Installer Test"],check=True)
    subprocess.run(["git","-C",str(fake),"add","."],check=True)
    subprocess.run(["git","-C",str(fake),"commit","-qm","test fixture"],check=True)
    for name in ("entry.mjs","host.mjs","framing.mjs"):
        shutil.copy2(root/"browser-extension/native-host"/name,fake/"browser-extension/native-host"/name)
    home.mkdir(mode=0o700); sandbox.mkdir(mode=0o700)
    for d in (temp, fake, home, sandbox, sandbox/"policy"):
        if d.exists(): d.chmod(0o700)
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
    # Malformed pinned policy must be refused before any registration appears.
    policy=sandbox/"policy"; policy.mkdir(mode=0o700)
    policy_file=policy/"owner-policy.json"; policy_file.write_text('{"not":"a policy"}'); policy_file.chmod(0o600)
    bad_env={**env,"BKE_NATIVE_HOST_POLICY_PATH":str(policy_file)}
    r=subprocess.run(cmd+["install"],cwd="/",env=bad_env,input="INSTALL USER-LEVEL CHROME HOST\n",capture_output=True,text=True)
    assert r.returncode!=0 and "policy" in r.stderr.lower(),(r.stdout,r.stderr)
    assert not (sandbox/"chrome/NativeMessagingHosts/com.bke.worker.native_host.json").exists()

    # Valid shape-only owner fixture uses fixed non-secret test fingerprints.
    policy_obj={
        "version":1,"allowed_origin":env["BKE_NATIVE_HOST_EXTENSION_ORIGIN"],
        "worker_id":"test-worker","public_key_sha256":"1"*64,
        "profile_binding_sha256":"2"*64,
        "resources":{"bridge_identity_sha256":"3"*64,"browser_profile_sha256":"4"*64,"chatgpt_target_sha256":"5"*64},
        "expires_at_ms":int(__import__("time").time()*1000)+60*60*1000,
    }
    writer = """
import {writeFileSync} from "node:fs";
const p=process.argv[2], x=JSON.parse(process.argv[3]);
writeFileSync(p,JSON.stringify(x)+"\\n",{mode:0o600,flag:"w"});
"""
    r=subprocess.run(["node","--input-type=module","-e",writer,str(policy_file),__import__("json").dumps(policy_obj)],
                     cwd="/",env=env,capture_output=True,text=True)
    assert r.returncode==0,(r.stdout,r.stderr)
    good_env={**env,"BKE_NATIVE_HOST_POLICY_PATH":str(policy_file)}
    # Source-only install against sandbox, then exact manifest verification and idempotent verify.
    r=subprocess.run(cmd+["install"],cwd="/",env=good_env,input="INSTALL USER-LEVEL CHROME HOST\\n",capture_output=True,text=True)
    assert r.returncode==0,(r.stdout,r.stderr)
    manifest=sandbox/"chrome/NativeMessagingHosts/com.bke.worker.native_host.json"
    assert manifest.is_file()
    import json
    parsed=json.loads(manifest.read_text())
    assert parsed["allowed_origins"]==[env["BKE_NATIVE_HOST_EXTENSION_ORIGIN"]]
    assert parsed["type"]=="stdio"
    assert parsed["path"]==str(sandbox/"install/launch-native-host.sh")
    for name in ("entry.mjs","host.mjs","framing.mjs","owner-policy.json"):
        assert (sandbox/"install"/name).is_file(),name
    assert (sandbox/"install/launch-native-host.sh").stat().st_mode & 0o111
    r=subprocess.run(cmd+["verify"],cwd="/",env=good_env,capture_output=True,text=True)
    assert r.returncode==0,(r.stdout,r.stderr)
    # Hash-locked rollback removes only transaction-owned artifacts.
    r=subprocess.run(cmd+["rollback"],cwd="/",env=good_env,capture_output=True,text=True)
    assert r.returncode==0,(r.stdout,r.stderr)
    assert not manifest.exists()
    assert not (sandbox/"install/launch-native-host.sh").exists()
    assert not (sandbox/"install/entry.mjs").exists()
    assert not (sandbox/"install/host.mjs").exists()
    assert not (sandbox/"install/framing.mjs").exists()
    assert not (sandbox/"install/owner-policy.json").exists()
    assert not (sandbox/"state/transaction.json").exists()
    # Conflicts are not overwritten.
    chrome=sandbox/"chrome/NativeMessagingHosts"; chrome.mkdir(parents=True,exist_ok=True,mode=0o700)
    conflict=chrome/"com.bke.worker.native_host.json"; conflict.write_text('{"unrelated":true}'); conflict.chmod(0o600)
    r=subprocess.run(cmd+["inspect"],cwd="/",env=env,capture_output=True,text=True)
    assert r.returncode!=0 and conflict.read_text()=='{"unrelated":true}'
print("BKE Chrome native host installer contract: PASS")
