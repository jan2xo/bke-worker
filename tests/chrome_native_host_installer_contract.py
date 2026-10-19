#!/usr/bin/env python3
from pathlib import Path
import os, subprocess, shutil, tempfile

root = Path(__file__).resolve().parents[1]
script = root / "scripts/prepare-chrome-native-host.sh"
text = script.read_text(encoding="utf-8")
for token in (
    'HOST_NAME="bke.worker.desktop"', 'Darwin|Linux)', 'unsupported OS:',
    'entry.mjs', 'host.mjs', 'validNativeHostPolicy', 'allowed_origins',
    'refusing to overwrite conflicting registration', 'FAIL-CLOSED', 'rollback)',
    'BKE_NATIVE_HOST_TEST_ROOT', 'INSTALL USER-LEVEL CHROME HOST', 'SCRIPT_PATH', 'canonical tracked entrypoint',
):
    assert token in text, token
manifest_src = (root / "browser-extension/manifest.json").read_text(encoding="utf-8")
assert "nativeMessaging" not in manifest_src
assert "wrangler deploy" not in text and "gh workflow run" not in text
for token in ('remote get-url origin', 'fetch --quiet --no-tags origin',
              'refs/remotes/origin/main', 'worktree is dirty',
              'source must run from main', 'trusted jan2xo/bke-worker repository'):
    assert token in text, token
with tempfile.TemporaryDirectory(prefix="bke-installer-contract-") as td:
    temp=Path(td); fake=temp/"repo"; home=temp/"home"; sandbox=temp/"sandbox"
    (fake/"scripts").mkdir(parents=True); (fake/"browser-extension/native-host").mkdir(parents=True)
    (fake/"browser-extension/manifest.json").write_text(manifest_src)
    for d in (fake, fake/"scripts", fake/"browser-extension", fake/"browser-extension/native-host"):
        d.chmod(0o700)
    shutil.copy2(script,fake/"scripts/prepare-chrome-native-host.sh")
    for name in ("entry.mjs","host.mjs","framing.mjs"):
        shutil.copy2(root/"browser-extension/native-host"/name,fake/"browser-extension/native-host"/name)
    subprocess.run(["git","init","-q","-b","main",str(fake)],check=True)
    subprocess.run(["git","-C",str(fake),"config","user.email","test@example.invalid"],check=True)
    subprocess.run(["git","-C",str(fake),"config","user.name","Installer Test"],check=True)
    subprocess.run(["git","-C",str(fake),"add","."],check=True)
    subprocess.run(["git","-C",str(fake),"commit","-qm","test fixture"],check=True)
    home.mkdir(mode=0o700); sandbox.mkdir(mode=0o700)
    for d in (temp, fake, home, sandbox, sandbox/"policy"):
        if d.exists(): d.chmod(0o700)
    env={**os.environ,"HOME":str(home),"BKE_NATIVE_HOST_TEST_ROOT":str(sandbox),
         "BKE_NATIVE_HOST_TEST_OS":"Linux",
         "BKE_NATIVE_HOST_EXTENSION_ORIGIN":"chrome-extension://"+"a"*32+"/"}
    registration_dir=sandbox/"xdg/google-chrome/NativeMessagingHosts"
    manifest_path=registration_dir/"bke.worker.desktop.json"
    cmd=["bash",str(fake/"scripts/prepare-chrome-native-host.sh")]
    # A symlink alias must not execute the entrypoint outside its canonical tracked path.
    alternate=fake/"scripts/alternate-entry.sh"; alternate.symlink_to("prepare-chrome-native-host.sh")
    alias_env={**os.environ,"HOME":str(home),
               "BKE_NATIVE_HOST_EXTENSION_ORIGIN":"chrome-extension://"+"a"*32+"/"}
    r=subprocess.run(["bash",str(alternate),"inspect"],cwd="/",env=alias_env,capture_output=True,text=True)
    assert r.returncode!=0 and "canonical tracked entrypoint" in r.stderr
    alternate.unlink()
    # Outside test mode, an untrusted remote is rejected before even read-only inspection.
    provenance_env={**os.environ,"HOME":str(home),
                    "BKE_NATIVE_HOST_EXTENSION_ORIGIN":"chrome-extension://"+"a"*32+"/"}
    subprocess.run(["git","-C",str(fake),"remote","add","origin","https://example.invalid/not-bke.git"],check=True)
    r=subprocess.run(cmd+["inspect"],cwd="/",env=provenance_env,capture_output=True,text=True)
    assert r.returncode!=0 and "trusted jan2xo/bke-worker repository" in r.stderr
    # Correct URL but a non-main checkout fails before any remote fetch.
    subprocess.run(["git","-C",str(fake),"remote","set-url","origin","https://github.com/jan2xo/bke-worker.git"],check=True)
    subprocess.run(["git","-C",str(fake),"checkout","-qb","feature/not-main"],check=True)
    r=subprocess.run(cmd+["inspect"],cwd="/",env=provenance_env,capture_output=True,text=True)
    assert r.returncode!=0 and "source must run from main" in r.stderr
    # A dirty main checkout also fails before fetch and without modifying browser paths.
    subprocess.run(["git","-C",str(fake),"checkout","-q","main"],check=True)
    (fake/"untracked-source-probe").write_text("dirty\\n")
    r=subprocess.run(cmd+["inspect"],cwd="/",env=provenance_env,capture_output=True,text=True)
    assert r.returncode!=0 and "worktree is dirty" in r.stderr
    (fake/"untracked-source-probe").unlink()
    subprocess.run(["git","-C",str(fake),"remote","remove","origin"],check=True)
    r=subprocess.run(cmd+["inspect"],cwd="/",env=env,capture_output=True,text=True)
    assert r.returncode==0,(r.stdout,r.stderr)
    assert str(manifest_path) in r.stdout
    assert not manifest_path.exists()
    r=subprocess.run(cmd+["dry-run"],cwd="/",env=env,capture_output=True,text=True)
    assert r.returncode==0 and str(manifest_path) in r.stdout,(r.stdout,r.stderr)
    assert not manifest_path.exists()
    assert not (sandbox/"chrome").exists()
    # Unsafe Node executable paths are rejected before any operator state is prepared.
    real_node=subprocess.check_output(["node","-p",'require("node:fs").realpathSync(process.execPath)'],text=True).strip()
    node_link=sandbox/"node-link"; node_link.symlink_to(real_node)
    for node_candidate in (str(sandbox/"node-does-not-exist"),str(node_link)):
        node_env={**env,"BKE_NATIVE_HOST_TEST_NODE_PATH":node_candidate}
        r=subprocess.run(cmd+["inspect"],cwd="/",env=node_env,capture_output=True,text=True)
        assert r.returncode!=0 and "Node executable validation failed" in r.stderr
        assert not manifest_path.exists()
    # A symlinked native-host module is rejected before registration.
    framing=fake/"browser-extension/native-host/framing.mjs"
    framing.unlink(); framing.symlink_to(root/"browser-extension/native-host/framing.mjs")
    r=subprocess.run(cmd+["inspect"],cwd="/",env=env,capture_output=True,text=True)
    assert r.returncode!=0 and "symlinked" in r.stderr.lower()
    framing.unlink(); shutil.copy2(root/"browser-extension/native-host/framing.mjs",framing)
    # macOS and Linux must select distinct canonical user-profile paths; unsupported systems fail closed.
    mac_env={**env,"BKE_NATIVE_HOST_TEST_OS":"Darwin"}
    r=subprocess.run(cmd+["inspect"],cwd="/",env=mac_env,capture_output=True,text=True)
    expected_mac=sandbox/"home/Library/Application Support/Google/Chrome/NativeMessagingHosts/bke.worker.desktop.json"
    assert r.returncode==0 and str(expected_mac) in r.stdout,(r.stdout,r.stderr)
    unsupported_env={**env,"BKE_NATIVE_HOST_TEST_OS":"FreeBSD"}
    r=subprocess.run(cmd+["inspect"],cwd="/",env=unsupported_env,capture_output=True,text=True)
    assert r.returncode!=0 and "unsupported OS: FreeBSD" in r.stderr
    root_link=temp/"sandbox-link"; root_link.symlink_to(sandbox,target_is_directory=True)
    symlink_root_env={**env,"BKE_NATIVE_HOST_TEST_ROOT":str(root_link)}
    r=subprocess.run(cmd+["inspect"],cwd="/",env=symlink_root_env,capture_output=True,text=True)
    assert r.returncode!=0 and "test root" in r.stderr.lower()
    broad_root=temp/"broad-root"; broad_root.mkdir(mode=0o755); broad_root.chmod(0o755)
    broad_env={**env,"BKE_NATIVE_HOST_TEST_ROOT":str(broad_root)}
    r=subprocess.run(cmd+["inspect"],cwd="/",env=broad_env,capture_output=True,text=True)
    assert r.returncode!=0 and "private owner-only" in r.stderr.lower()
    assert list(broad_root.iterdir())==[]
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
    assert not manifest_path.exists()
    missing_policy_env={**env,"BKE_NATIVE_HOST_POLICY_PATH":str(sandbox/"policy/missing-owner-policy.json")}
    r=subprocess.run(cmd+["install"],cwd="/",env=missing_policy_env,input="INSTALL USER-LEVEL CHROME HOST\n",capture_output=True,text=True)
    assert r.returncode!=0 and "policy" in r.stderr.lower()
    assert not manifest_path.exists()

    # Valid shape-only owner fixture uses fixed non-secret test fingerprints.
    policy_obj={
        "version":1,"allowed_origin":env["BKE_NATIVE_HOST_EXTENSION_ORIGIN"],
        "worker_id":"test-worker","public_key_sha256":"1"*64,
        "profile_binding_sha256":"2"*64,
        "resources":{"bridge_identity_sha256":"3"*64,"browser_profile_sha256":"4"*64,"chatgpt_target_sha256":"5"*64},
        "expires_at_ms":int(__import__("time").time()*1000)+60*60*1000,
    }
    import json
    policy_file.write_text(json.dumps(policy_obj) + chr(10))
    policy_file.chmod(0o600)
    good_env={**env,"BKE_NATIVE_HOST_POLICY_PATH":str(policy_file)}
    # A valid policy with a different pinned origin is rejected.
    valid_bytes=policy_file.read_bytes()
    wrong_origin={**policy_obj,"allowed_origin":"chrome-extension://"+"b"*32+"/"}
    policy_file.write_text(json.dumps(wrong_origin)+chr(10)); policy_file.chmod(0o600)
    r=subprocess.run(cmd+["install"],cwd="/",env=good_env,input="INSTALL USER-LEVEL CHROME HOST\n",capture_output=True,text=True)
    assert r.returncode!=0 and "policy" in r.stderr.lower()
    assert not manifest_path.exists()
    policy_file.write_bytes(valid_bytes); policy_file.chmod(0o600)
    # Source-only install against sandbox, then exact manifest verification and idempotent verify.
    # Unsafe policy symlinks, writable modes and relative paths must all be rejected.
    symlink_policy=policy/"policy-symlink.json"; symlink_policy.symlink_to(policy_file)
    for patch in (
        {"BKE_NATIVE_HOST_POLICY_PATH":str(symlink_policy)},
        {"BKE_NATIVE_HOST_POLICY_PATH":str(policy_file)},
    ):
        bad={**good_env,**patch}
        original_mode=policy_file.stat().st_mode & 0o777
        if patch["BKE_NATIVE_HOST_POLICY_PATH"]==str(policy_file): policy_file.chmod(0o666)
        r=subprocess.run(cmd+["install"],cwd="/",env=bad,input="INSTALL USER-LEVEL CHROME HOST\n",capture_output=True,text=True)
        assert r.returncode!=0,(r.stdout,r.stderr)
        assert not manifest_path.exists()
        policy_file.chmod(original_mode)
    relative_env={**good_env,"BKE_NATIVE_HOST_POLICY_PATH":"policy/owner-policy.json"}
    r=subprocess.run(cmd+["install"],cwd="/",env=relative_env,input="INSTALL USER-LEVEL CHROME HOST\n",capture_output=True,text=True)
    assert r.returncode!=0 and not manifest_path.exists()

    # Inject a failure after two no-clobber links; cleanup must remove only this transaction's files.
    fault_env={**good_env,"BKE_NATIVE_HOST_TEST_FAIL_AFTER_LINK":"2"}
    r=subprocess.run(cmd+["install"],cwd="/",env=fault_env,capture_output=True,text=True)
    assert r.returncode!=0 and "injected" in r.stderr.lower(),(r.stdout,r.stderr)
    assert not manifest_path.exists()
    assert list((sandbox/"install").iterdir())==[]
    assert list((sandbox/"state").iterdir())==[]
    assert list(registration_dir.iterdir())==[]

    r=subprocess.run(cmd+["install"],cwd="/",env=good_env,input="INSTALL USER-LEVEL CHROME HOST\n",capture_output=True,text=True)
    assert r.returncode==0,(r.stdout,r.stderr)
    manifest=manifest_path
    assert manifest.is_file()
    import json
    parsed=json.loads(manifest.read_text())
    assert parsed["allowed_origins"]==[env["BKE_NATIVE_HOST_EXTENSION_ORIGIN"]]
    assert parsed["type"]=="stdio"
    assert parsed["path"]==str(sandbox/"install/launch-native-host.sh")
    for name in ("entry.mjs","host.mjs","framing.mjs","owner-policy.json"):
        assert (sandbox/"install"/name).is_file(),name
    assert (sandbox/"install/launch-native-host.sh").stat().st_mode & 0o111
    launcher=sandbox/"install/launch-native-host.sh"
    assert 'exec "$NODE_BIN" "$ENTRY" "$POLICY" "$1"' in launcher.read_text()
    assert 'NODE_BIN=' in launcher.read_text()
    subprocess.run(["bash","-n",str(launcher)],check=True)
    r=subprocess.run([str(launcher),"https://invalid.example/"],cwd="/",env=good_env,capture_output=True,text=True)
    assert r.returncode==2 and not r.stdout
    r=subprocess.run(cmd+["verify"],cwd="/",env=good_env,capture_output=True,text=True)
    assert r.returncode==0,(r.stdout,r.stderr)
    # Matching second install is an idempotent no-op.
    r=subprocess.run(cmd+["install"],cwd="/",env=good_env,input="INSTALL USER-LEVEL CHROME HOST\n",capture_output=True,text=True)
    assert r.returncode==0 and "idempotent no-op" in r.stdout,(r.stdout,r.stderr)
    # A modified launcher must fail verification and never be treated as an idempotent registration.
    original_launcher=launcher.read_bytes()
    launcher.write_bytes(original_launcher+b"\n# tamper probe\n"); launcher.chmod(0o700)
    r=subprocess.run(cmd+["verify"],cwd="/",env=good_env,capture_output=True,text=True)
    assert r.returncode!=0 and "artifact hashes mismatch" in r.stderr,(r.stdout,r.stderr)
    r=subprocess.run(cmd+["install"],cwd="/",env=good_env,input="INSTALL USER-LEVEL CHROME HOST\n",capture_output=True,text=True)
    assert r.returncode!=0 and "refusing to overwrite conflicting" in r.stderr,(r.stdout,r.stderr)
    assert manifest.exists()
    launcher.write_bytes(original_launcher); launcher.chmod(0o700)
    r=subprocess.run(cmd+["verify"],cwd="/",env=good_env,capture_output=True,text=True)
    assert r.returncode==0,(r.stdout,r.stderr)
    # Changed module content makes rollback fail closed and preserves all artifacts.
    host_file=sandbox/"install/host.mjs"; original_host=host_file.read_bytes()
    host_file.write_bytes(original_host+b"\\n// tamper probe")
    r=subprocess.run(cmd+["rollback"],cwd="/",env=good_env,capture_output=True,text=True)
    assert r.returncode!=0 and manifest.exists(),(r.stdout,r.stderr)
    host_file.write_bytes(original_host); host_file.chmod(0o600)
    # Hash-locked rollback removes only byte-identical transaction-owned artifacts.
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
    chrome=registration_dir; chrome.mkdir(parents=True,exist_ok=True,mode=0o700)
    conflict=chrome/"bke.worker.desktop.json"; conflict.write_text('{"unrelated":true}'); conflict.chmod(0o600)
    r=subprocess.run(cmd+["inspect"],cwd="/",env=env,capture_output=True,text=True)
    assert r.returncode!=0 and conflict.read_text()=='{"unrelated":true}'
print("BKE Chrome native host installer contract: PASS")
