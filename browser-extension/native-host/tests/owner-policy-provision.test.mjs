import test from "node:test";
import assert from "node:assert/strict";
import {createHash} from "node:crypto";
import {mkdtemp,realpath,readFile,stat,lstat,symlink,rm,mkdir} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {buildReviewedOwnerPolicy,persistOwnerPolicy} from "../owner-policy-provision.mjs";
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
