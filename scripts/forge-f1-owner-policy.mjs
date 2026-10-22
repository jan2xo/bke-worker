#!/usr/bin/env node
// F1-03 local, owner-interactive pin preflight. Does NOT create identity or grant pairing.
import {execFileSync} from "node:child_process";
import {createInterface} from "node:readline/promises";
import {resolve,dirname,join} from "node:path";
import {fileURLToPath} from "node:url";
import {lstat,realpath} from "node:fs/promises";
import {buildReviewedOwnerPolicy,persistOwnerPolicy} from
  "../browser-extension/native-host/owner-policy-provision.mjs";

const ROOT=resolve(dirname(fileURLToPath(import.meta.url)),"..");
const SCRIPT=join(ROOT,"scripts/forge-f1-owner-policy.mjs");
const PHRASE="I REVIEWED F1 DEVICE AND PROFILE PINS";
const FIELDS=["allowed_origin","worker_id","public_key_sha256",
 "profile_binding_sha256","chatgpt_target_sha256",
 "browser_profile_sha256","bridge_identity_sha256"];
const ALLOWED=new Set([
 "https://github.com/jan2xo/bke-worker",
 "https://github.com/jan2xo/bke-worker.git",
 "git@github.com:jan2xo/bke-worker.git",
 "ssh://git@github.com/jan2xo/bke-worker.git"
]);
function blocked(code){throw Error("OWNER_POLICY_"+code);}
function git(...args){
 try{
  return execFileSync("git",["-C",ROOT,...args],{
   encoding:"utf8",stdio:["ignore","pipe","ignore"],
   env:{...process.env,GIT_TERMINAL_PROMPT:"0"},timeout:20000
  }).trim();
 }catch{blocked("SOURCE_NOT_VERIFIED");}
}
async function sourcePreflight(){
 if(process.getuid?.()===0||process.argv.length!==2||
    !process.stdin.isTTY||!process.stdout.isTTY)
  blocked("OWNER_TTY_REQUIRED");
 if((await lstat(SCRIPT)).isSymbolicLink()||
    await realpath(SCRIPT)!==SCRIPT)
  blocked("ENTRYPOINT_UNTRUSTED");
 if(!ALLOWED.has(git("remote","get-url","origin"))||
    git("branch","--show-current")!=="main"||
    git("status","--porcelain","--untracked-files=all")!=="")
  blocked("SOURCE_NOT_VERIFIED");
 git("fetch","--quiet","--no-tags","origin",
    "refs/heads/main:refs/remotes/origin/main");
 if(git("rev-parse","HEAD")!==git("rev-parse","refs/remotes/origin/main"))
  blocked("STALE_MAIN");
}
async function main(){
 await sourcePreflight();
 const rl=createInterface({input:process.stdin,output:process.stdout});
 try{
  console.log("BKE F1-03: OWNER-PINNED POLICY / LOCAL-ONLY, NO ENROLLMENT.");
  console.log("Each binding below must be ALREADY verified by the owner.");
  console.log("If a trusted pin is unavailable, Ctrl+C — NEVER invent a hash.");
  console.log("Read allowed_origin from chrome://extensions and the key fingerprint");
  console.log("from the BKE extension's own device-identity popup.");
  const input={};
  for(const field of FIELDS)input[field]=(await rl.question(field+": ")).trim();
  const days=(await rl.question("Validity days (1-30, default 7): ")).trim();
  if(days&&!/^(?:[1-9]|[12][0-9]|30)$/u.test(days))blocked("TTL_INVALID");
  const policy=buildReviewedOwnerPolicy(input,{
   ttlMs:Number(days||"7")*86400000
  });
  console.log("This validates owner-provided values but does NOT independently");
  console.log("attest the browser, device, ChatGPT account or GitHub assignment.");
  if((await rl.question("Type exactly '"+PHRASE+"' to write: "))!==PHRASE)
   blocked("OWNER_APPROVAL_MISSING");
  const result=await persistOwnerPolicy(policy);
  console.log("BKE_F1_OWNER_POLICY="+result.state);
  console.log("BKE_F1_PAIRING_AUTHORITY="+result.pairing_authority);
  console.log("BKE_F1_DISPATCH_AUTHORITY="+result.dispatch_authority);
 }finally{rl.close();}
}
main().catch(e=>{
 const message=String(e?.message||"");
 const reason=message.startsWith("OWNER_POLICY_")?message:"OWNER_POLICY_BLOCKED";
 console.error("BKE_F1_OWNER_POLICY=BLOCKED reason="+reason);
 process.exitCode=2;
});
