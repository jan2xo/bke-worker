import test from "node:test";
import assert from "node:assert/strict";
import {mkdtemp,mkdir,writeFile,readFile,chmod,rm,symlink} from "node:fs/promises";
import {createHash} from "node:crypto";
import {tmpdir} from "node:os";
import {join,dirname} from "node:path";
import {readFileSync} from "node:fs";
import {verifyOwnerPinnedChromeInstallation} from "../installation-witness.mjs";

const HOST="bke.worker.desktop",ORIGIN="chrome-extension://"+"a".repeat(32)+"/";
const H=x=>x.repeat(64),sha=b=>createHash("sha256").update(b).digest("hex");
const later=()=>Date.now()+3600000;
const keys=["manifest","launcher","entry","host","framing","policy"];
async function fixture(t){
 const dir=await mkdtemp(join(tmpdir(),"bke-witness-"));
 t.after(async()=>rm(dir,{recursive:true,force:true}));
 const install=join(dir,"install"),stateDir=join(dir,"state"),chrome=join(dir,"chrome");
 for(const p of [install,stateDir,chrome])await mkdir(p,{mode:0o700});
 const paths={
  manifest:join(chrome,HOST+".json"),
  launcher:join(install,"launch-native-host.sh"),
  entry:join(install,"entry.mjs"),
  host:join(install,"host.mjs"),
  framing:join(install,"framing.mjs"),
  policy:join(install,"owner-policy.json"),
 };
 const policy={version:1,allowed_origin:ORIGIN,worker_id:"worker-a",
  public_key_sha256:H("1"),profile_binding_sha256:H("2"),
  resources:{chatgpt_target_sha256:H("3"),browser_profile_sha256:H("4"),
    bridge_identity_sha256:H("5")},expires_at_ms:later()};
 const manifest={name:HOST,description:"BKE Worker local native host (source-only preparation)",
  path:paths.launcher,type:"stdio",allowed_origins:[ORIGIN]};
 const bytes={
  manifest:JSON.stringify(manifest)+"\n",
  launcher:"#!/usr/bin/env bash\nexit 0\n",
  entry:"// source-locked entry\n",
  host:"// source-locked host\n",
  framing:"// source-locked framing\n",
  policy:JSON.stringify(policy)+"\n",
 };
 const hashes={};
 for(const k of keys){
  await writeFile(paths[k],bytes[k],{mode:k==="launcher"?0o700:0o600});
  hashes[k]=sha(Buffer.from(bytes[k]));
 }
 const statePath=join(stateDir,"transaction.json");
 const state={version:1,host:HOST,manifest:paths.manifest,launcher:paths.launcher,
  entry:paths.entry,host_module:paths.host,framing_module:paths.framing,policy:paths.policy,
  origin:ORIGIN,created_by:"prepare-chrome-native-host.sh",sha256:hashes};
 await writeFile(statePath,JSON.stringify(state)+"\n",{mode:0o600});
 const opts={manifestPath:paths.manifest,statePath,expectedOrigin:ORIGIN,
  expectedWorkerId:"worker-a",ownerReviewedSha256:structuredClone(hashes)};
 return {dir,install,chrome,stateDir,paths,statePath,opts,hashes,state,policy};
}
const check=opts=>verifyOwnerPinnedChromeInstallation(opts);
const denied=async opts=>assert.rejects(check(opts),e=>
  e instanceof Error&&e.message==="NATIVE_INSTALLATION_UNVERIFIED");
test("owner-reviewed exact hashes plus installer receipt witness installed bytes only",async t=>{
 const f=await fixture(t);
 const r=await check(f.opts);
 assert.deepEqual(r,{state:"INSTALLATION_BYTES_VERIFIED",host:HOST,worker_id:"worker-a",
  browser_session_authority:"NONE",device_admission_authority:"NONE",dispatch_authority:"NONE"});
 assert.equal(Object.isFrozen(r),true);
});
test("changed code and rehashed installer state still fail against INDEPENDENT owner pins",async t=>{
 const f=await fixture(t);
 await writeFile(f.paths.host,"// replaced by same user\n");
 await denied(f.opts);
 f.state.sha256.host=sha(await readFile(f.paths.host));
 await writeFile(f.statePath,JSON.stringify(f.state)+"\n");
 await denied(f.opts);
});
test("incorrect independent policy and manifest hashes fail closed",async t=>{
 const f=await fixture(t);
 await denied({...f.opts,ownerReviewedSha256:{...f.opts.ownerReviewedSha256,policy:H("f")}});
 await denied({...f.opts,ownerReviewedSha256:{...f.opts.ownerReviewedSha256,manifest:H("f")}});
 await denied({...f.opts,ownerReviewedSha256:f.state.sha256,expectedOrigin:"https://example.invalid/"});
});
test("wrong worker, conflicting origin and manifest schema are rejected",async t=>{
 const f=await fixture(t);
 await denied({...f.opts,expectedWorkerId:"worker-b"});
 const m=JSON.parse(await readFile(f.paths.manifest,"utf8"));m.allowed_origins=[ORIGIN,"chrome-extension://"+"b".repeat(32)+"/"];
 await writeFile(f.paths.manifest,JSON.stringify(m)+"\n");
 f.state.sha256.manifest=sha(await readFile(f.paths.manifest));
 await writeFile(f.statePath,JSON.stringify(f.state)+"\n");
 await denied({...f.opts,ownerReviewedSha256:{...f.opts.ownerReviewedSha256,manifest:f.state.sha256.manifest}});
});
test("symlinked launcher, manifest or ancestor always fail without deleting it",async t=>{
 const f=await fixture(t);
 const link=join(f.install,"new-launcher");
 await symlink(f.paths.launcher,link);
 const st={...f.state,launcher:link};
 await writeFile(f.statePath,JSON.stringify(st)+"\n");
 await denied({...f.opts,ownerReviewedSha256:f.hashes});
 await writeFile(f.statePath,JSON.stringify(f.state)+"\n");
 const forgedManifest=join(f.dir,"alias-manifest");
 await symlink(f.paths.manifest,forgedManifest);
 await denied({...f.opts,manifestPath:forgedManifest});
 const parentLink=join(f.dir,"linked-installer");
 await symlink(f.install,parentLink);
 await denied({...f.opts,statePath:join(parentLink,"..","state","transaction.json")});
});
test("writable policy, nonexecutable launcher and unsafe parent mode fail closed",async t=>{
 const f=await fixture(t);
 await chmod(f.paths.policy,0o666);await denied(f.opts);await chmod(f.paths.policy,0o600);
 await chmod(f.paths.launcher,0o600);await denied(f.opts);await chmod(f.paths.launcher,0o700);
 await chmod(f.install,0o777);await denied(f.opts);
});
test("invalid origin, noncanonical expected path and transaction keys cannot be trusted",async t=>{
 const f=await fixture(t);
 await denied({...f.opts,manifestPath:f.paths.manifest+"/../"+HOST+".json"});
 await denied({...f.opts,expectedOrigin:"chrome-extension://"+"a".repeat(31)+"/"});
 f.state.created_by="unknown";await writeFile(f.statePath,JSON.stringify(f.state)+"\n");await denied(f.opts);
});
test("expired or overlong worker policy refuses a positive snapshot",async t=>{
 const f=await fixture(t);
 await denied({...f.opts,now:()=>f.policy.expires_at_ms+1});
});
test("witness remains unwired from Chrome runtime, installer and private attestor",()=>{
 const entry=readFileSync(new URL("../entry.mjs",import.meta.url),"utf8");
 const host=readFileSync(new URL("../host.mjs",import.meta.url),"utf8");
 const signer=readFileSync(new URL("../private-peer-attestor.mjs",import.meta.url),"utf8");
 const manifest=readFileSync(new URL("../../manifest.json",import.meta.url),"utf8");
 const installer=readFileSync(new URL("../../../scripts/prepare-chrome-native-host.sh",import.meta.url),"utf8");
 for(const s of [entry,host,signer,installer])
  assert.doesNotMatch(s,/verifyOwnerPinnedChromeInstallation|installation-witness/u);
 assert.deepEqual(JSON.parse(manifest).permissions,["storage"]);
});
