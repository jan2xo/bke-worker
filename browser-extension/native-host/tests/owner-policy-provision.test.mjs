import test from "node:test";
import assert from "node:assert/strict";
import {createHash} from "node:crypto";
import {mkdtemp,realpath,readFile,stat,lstat,symlink,rm,mkdir,chmod,writeFile,link,unlink} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {buildReviewedOwnerPolicy,persistOwnerPolicy,verifyOwnerPolicyFile} from "../owner-policy-provision.mjs";
import {validNativeHostPolicy} from "../host.mjs";
const h=x=>createHash("sha256").update("synthetic BKE fixture only "+x).digest("hex");
const values=()=>({
 allowed_origin:"chrome-extension://"+"a".repeat(32)+"/",
 worker_id:"worker-f1",
 public_key_sha256:h("key"),profile_binding_sha256:h("profile"),
 chatgpt_target_sha256:h("target"),
 browser_profile_sha256:h("browser"),
 bridge_identity_sha256:h("bridge"),
});
test("verified-shape owner pins produce only a valid local policy, not auth",()=>{
 const now=Date.now();
 const policy=buildReviewedOwnerPolicy(values(),{now});
 assert.equal(validNativeHostPolicy(policy,now),true);
 assert.equal(policy.expires_at_ms,now+7*86400000);
 assert.equal(policy.resources.browser_profile_sha256,h("browser"));
 assert.equal("admission_authority" in policy,false);
});
test("fail closed on extra/missing keys, origin, wrong worker, placeholders, duplicates, expiry",()=>{
 const v=values();
 for(const invalid of [
  {...v,extra:"bad"},{...v,worker_id:"WRONG"},
  {...v,allowed_origin:"https://chatgpt.com"},
  {...v,public_key_sha256:"1".repeat(64)},
  {...v,profile_binding_sha256:h("target")},
 ])assert.throws(()=>buildReviewedOwnerPolicy(invalid),/OWNER_POLICY_/);
 const missing=values();delete missing.worker_id;
 assert.throws(()=>buildReviewedOwnerPolicy(missing),/OWNER_POLICY_/);
 for(const ttlMs of [0,-1,3600001.3,31*86400000])
  assert.throws(()=>buildReviewedOwnerPolicy(values(),{ttlMs}),/OWNER_POLICY_/);
});
test("create owner-private no-clobber policy and read back bytes",async t=>{
 const home=await realpath(await mkdtemp(join(tmpdir(),"bke-f1-policy-")));
 t.after(()=>rm(home,{recursive:true,force:true}));
 const policy=buildReviewedOwnerPolicy(values());
 const result=await persistOwnerPolicy(policy,{home});
 assert.deepEqual(result,{state:"OWNER_POLICY_WRITTEN_LOCAL_ONLY",
  pairing_authority:"NONE",dispatch_authority:"NONE"});
 const path=join(home,".config/bke-worker/native-host/owner-policy.json");
 assert.equal((await stat(path)).mode&0o077,0);
 assert.deepEqual(JSON.parse(await readFile(path,"utf8")),policy);
 await assert.rejects(persistOwnerPolicy(policy,{home}),/OWNER_POLICY_ALREADY_EXISTS/);
 assert.deepEqual(JSON.parse(await readFile(path,"utf8")),policy);
});
test("symlinked directory or existing policy symlink is never replaced",async t=>{
 const home=await realpath(await mkdtemp(join(tmpdir(),"bke-f1-negative-")));
 t.after(()=>rm(home,{recursive:true,force:true}));
 const outside=join(home,"outside");await mkdir(outside,{mode:0o700});
 await symlink(outside,join(home,".config"));
 const policy=buildReviewedOwnerPolicy(values());
 await assert.rejects(persistOwnerPolicy(policy,{home}),/OWNER_POLICY_DIRECTORY_UNTRUSTED/);
 await rm(join(home,".config"));
 const config=join(home,".config");
 const app=join(config,"bke-worker");
 const dir=join(app,"native-host");
 for(const p of [config,app,dir])await mkdir(p,{mode:0o700});
 const linkPath=join(dir,"owner-policy.json");
 await symlink(join(outside,"nonexistent"),linkPath);
 await assert.rejects(persistOwnerPolicy(policy,{home}),/OWNER_POLICY_ALREADY_EXISTS/);
 assert.equal((await lstat(linkPath)).isSymbolicLink(),true);
});
test("pre-existing group-accessible policy parent is rejected before file creation",async t=>{
 const home=await realpath(await mkdtemp(join(tmpdir(),"bke-f1-dir-mode-")));
 t.after(()=>rm(home,{recursive:true,force:true}));
 const config=join(home,".config"),app=join(config,"bke-worker");
 const dir=join(app,"native-host");
 for(const parent of [config,app,dir])await mkdir(parent,{mode:0o700});
 await chmod(dir,0o750);
 const policy=buildReviewedOwnerPolicy(values());
 await assert.rejects(persistOwnerPolicy(policy,{home}),/OWNER_POLICY_DIRECTORY_UNTRUSTED/);
 await assert.rejects(stat(join(dir,"owner-policy.json")) ,/ENOENT/);
 await chmod(dir,0o700);
 assert.equal((await persistOwnerPolicy(policy,{home})).state,
   "OWNER_POLICY_WRITTEN_LOCAL_ONLY");
 assert.equal((await stat(dir)).mode&0o077,0);
 assert.equal((await stat(join(dir,"owner-policy.json"))).nlink,1);
});
test("owner-reviewed pins are deep frozen and async persistence ignores later caller mutations",async t=>{
 const home=await realpath(await mkdtemp(join(tmpdir(),"bke-f1-pin-snapshot-")));
 t.after(()=>rm(home,{recursive:true,force:true}));
 const original=buildReviewedOwnerPolicy(values());
 assert.equal(Object.isFrozen(original),true);
 assert.equal(Object.isFrozen(original.resources),true);
 assert.throws(()=>{original.resources.chatgpt_target_sha256=h("unreviewed");},TypeError);
 // Simulate an embedding program supplying a mutable policy object. The
 // synchronous validation happens before the first awaited realpath/mkdir.
 const mutable=structuredClone(original);
 const writing=persistOwnerPolicy(mutable,{home});
 mutable.resources.chatgpt_target_sha256=h("substituted after validation");
 mutable.resources.browser_profile_sha256=h("other browser");
 mutable.worker_id="another-worker";
 const result=await writing;
 assert.equal(result.state,"OWNER_POLICY_WRITTEN_LOCAL_ONLY");
 const saved=JSON.parse(await readFile(join(home,".config/bke-worker/native-host/owner-policy.json"),"utf8"));
 assert.deepEqual(saved,original);
 assert.equal(validNativeHostPolicy(saved),true);
 assert.notEqual(saved.resources.chatgpt_target_sha256,mutable.resources.chatgpt_target_sha256);
 assert.notEqual(saved.worker_id,mutable.worker_id);
});
test("owner policy file witness refuses extra hardlinks, public mode and changed bytes",async t=>{
 const home=await realpath(await mkdtemp(join(tmpdir(),"bke-f1-link-witness-")));
 t.after(()=>rm(home,{recursive:true,force:true}));
 const file=join(home,"owner-policy.json"),extra=join(home,"other-link.json");
 const bytes=Buffer.from(JSON.stringify(buildReviewedOwnerPolicy(values()))+"\n","utf8");
 await writeFile(file,bytes,{mode:0o600});
 assert.equal(await verifyOwnerPolicyFile(file,bytes),true);
 await link(file,extra);
 await assert.rejects(verifyOwnerPolicyFile(file,bytes),/OWNER_POLICY_READBACK_FAILED/);
 assert.equal(await verifyOwnerPolicyFile(file,bytes,process.getuid(),2),true);
 await unlink(extra);
 await chmod(file,0o644);
 await assert.rejects(verifyOwnerPolicyFile(file,bytes),/OWNER_POLICY_READBACK_FAILED/);
 await chmod(file,0o600);
 const changed=Buffer.from(bytes);
 changed[changed.length-2]^=1;
 await assert.rejects(verifyOwnerPolicyFile(file,changed),/OWNER_POLICY_READBACK_FAILED/);
 assert.equal(await verifyOwnerPolicyFile(file,bytes),true);
});
test("programmatic writer cannot bypass anti-placeholder and duplicate pin checks",async t=>{
 const home=await realpath(await mkdtemp(join(tmpdir(),"bke-f1-writer-")));
 t.after(()=>rm(home,{recursive:true,force:true}));
 const good=buildReviewedOwnerPolicy(values());
 const placeholder={...good,public_key_sha256:"a".repeat(64)};
 const duplicate={...good,resources:{...good.resources,
   browser_profile_sha256:good.resources.chatgpt_target_sha256}};
 await assert.rejects(persistOwnerPolicy(placeholder,{home}),/OWNER_POLICY_PINS_UNTRUSTED/);
 await assert.rejects(persistOwnerPolicy(duplicate,{home}),/OWNER_POLICY_PINS_UNTRUSTED/);
 await assert.rejects(stat(join(home,".config")),/ENOENT/);
});
test("never creates policy or parent directory from invalid binding",async t=>{
 const home=await realpath(await mkdtemp(join(tmpdir(),"bke-f1-untrusted-")));
 t.after(()=>rm(home,{recursive:true,force:true}));
 await assert.rejects(persistOwnerPolicy({version:1},{home}),/OWNER_POLICY_WRITE_DENIED/);
 await assert.rejects(persistOwnerPolicy(buildReviewedOwnerPolicy(values()),{home:home+"/../wrong"}),/OWNER_POLICY_WRITE_DENIED/);
 await assert.rejects(stat(join(home,".config")),/ENOENT/);
});
