import test from "node:test";
import assert from "node:assert/strict";
import {spawn} from "node:child_process";
import {createHash} from "node:crypto";
import {readFileSync,realpathSync} from "node:fs";
import {fileURLToPath} from "node:url";
import {parseLinuxProcStat} from "../linux-parent-provenance.mjs";

const linux=process.platform==="linux"&&typeof process.getuid==="function";
const fixture=fileURLToPath(new URL("./fixtures/linux-parent-child.mjs",import.meta.url));
const binary=realpathSync("/usr/bin/bash");
const host=realpathSync(process.execPath);
const sha=createHash("sha256").update(readFileSync(binary)).digest("hex");
const config=()=>({
  ownerPinnedBrowserExecutablePath:binary,
  ownerPinnedBrowserExecutableSha256:sha,
  ownerPinnedHostExecutablePath:host,
  expectedUid:process.getuid?.(),
});
async function invoke(c,diagnostics=false){
 return await new Promise((resolve,reject)=>{
   // Keep root-installed Bash alive as the immediate OS parent.
   const cp=spawn("/usr/bin/bash",["-c",'"$1" "$2"; exit $?',"bke-test",process.execPath,fixture],
      {stdio:["pipe","pipe","pipe"],env:{...process.env,BKE_PRIVATE_PROC_TEST_DIAGNOSTICS:diagnostics?"1":"0"}});
   let stdout="",stderr="";
   cp.stdout.setEncoding("utf8");
   cp.stderr.setEncoding("utf8");
   cp.stdout.on("data",x=>{stdout+=x;if(stdout.length>2048)cp.kill();});
   cp.stderr.on("data",x=>{stderr+=x;if(stderr.length>2048)cp.kill();});
   cp.on("error",reject);
   cp.on("close",(status,signal)=>resolve({status,signal,stdout,stderr}));
   cp.stdin.end(JSON.stringify(c));
 });
}
test("real /proc kernel: host's immediate hardened Bash parent matches independently pinned SHA256", {skip:!linux},async()=>{
 const r=await invoke(config(),true);
 assert.equal(r.status,0,JSON.stringify(r));
 assert.equal(r.stderr,"");
 assert.deepEqual(JSON.parse(r.stdout),{
   state:"NATIVE_PARENT_EXECUTABLE_MATCHED",
   browser_session_authority:"NONE",profile_authority:"NONE",
   device_admission_authority:"NONE",dispatch_authority:"NONE",
 });
});
test("wrong owner SHA, different binary path or host executable pin reject real proc evidence",{skip:!linux},async()=>{
 const candidates=[
  {ownerPinnedBrowserExecutableSha256:"f".repeat(64)},
  {ownerPinnedBrowserExecutableSha256:"invalid"},
  {ownerPinnedBrowserExecutablePath:"/bin/false"},
  {ownerPinnedHostExecutablePath:"/bin/false"},
  {expectedUid:process.getuid()+1},
  {ownerPinnedBrowserExecutablePath:"/tmp/../usr/bin/node"},
 ];
 for(const override of candidates){
   const r=await invoke({...config(),...override});
   assert.notEqual(r.status,0,JSON.stringify({override,result:r}));
   assert.equal(r.stdout,"");
   assert.equal(r.stderr,"LINUX_PARENT_PROVENANCE_UNVERIFIED");
 }
});
test("malformed inputs fail closed; untrusted pid/root/command line cannot select process",{skip:!linux},async()=>{
 for(const override of [
  {ownerPinnedBrowserExecutableSha256:undefined},
  {ownerPinnedHostExecutablePath:undefined},
  {expectedUid:undefined},
  {ownerPinnedBrowserExecutablePath:"/proc/self/exe"},
 ]){
   const r=await invoke({...config(),...override});
   assert.notEqual(r.status,0);
 }
 // Extra caller JSON cannot override process.pid or /proc; the module has no
 // API for them. This is a Node fixture, not live Chrome authorization.
 const r=await invoke({...config(),pid:1,procRoot:"/tmp/forged",browserProfile:"fake"});
 assert.equal(r.status,0);
 assert.equal(JSON.parse(r.stdout).browser_session_authority,"NONE");
});
test("proc stat parser handles embedded parentheses, and rejects truncated/bad PID/start ticks",()=>{
 const fields=["S","17",...Array(17).fill("0"),"999",...Array(10).fill("0")];
 const s=`42 (my (Chrome) launcher) ${fields.join(" ")}`;
 assert.deepEqual(parseLinuxProcStat(s),{pid:42,ppid:17,start_ticks:"999"});
 assert.equal(parseLinuxProcStat("garbage"),null);
 assert.equal(parseLinuxProcStat("42 (unclosed S 17"),null);
 assert.equal(parseLinuxProcStat("42 (chrome) S 17"),null);
 assert.equal(parseLinuxProcStat(s.replace("S 17","S -1")),null);
 assert.equal(parseLinuxProcStat(s.replace("999","oops")),null);
 assert.equal(parseLinuxProcStat(s.replace("42 (","999999999999999999999 (")),null);
});
test("kernel witness stays dormant in native entrypoint, signer, installer and extension",()=>{
 const entry=readFileSync(new URL("../entry.mjs",import.meta.url),"utf8");
 const host=readFileSync(new URL("../host.mjs",import.meta.url),"utf8");
 const signer=readFileSync(new URL("../private-peer-attestor.mjs",import.meta.url),"utf8");
 const installer=readFileSync(new URL("../../../scripts/prepare-chrome-native-host.sh",import.meta.url),"utf8");
 const manifest=JSON.parse(readFileSync(new URL("../../manifest.json",import.meta.url),"utf8"));
 for(const source of [entry,host,signer,installer]){
   assert.doesNotMatch(source,/witnessLinuxImmediateBrowserParent|linux-parent-provenance/u);
 }
 assert.deepEqual(manifest.permissions,["storage"]);
});
