#!/usr/bin/env node
// F1-03 owner-attested local pin creation, NEVER browser/server admission.
import {execFileSync} from "node:child_process";
import {createInterface} from "node:readline/promises";
import {existsSync} from "node:fs";
import {realpath,lstat} from "node:fs/promises";
import {resolve,dirname,join} from "node:path";
import {fileURLToPath} from "node:url";
import {homedir} from "node:os";
import {deriveOwnerAttestedLocalPins} from
 "../browser-extension/native-host/owner-local-bindings.mjs";
import {buildReviewedOwnerPolicy,persistOwnerPolicy} from
 "../browser-extension/native-host/owner-policy-provision.mjs";

const ROOT=resolve(dirname(fileURLToPath(import.meta.url)),"..");
const SCRIPT=join(ROOT,"scripts/forge-f1-owner-policy.mjs");
const PHRASE="I REVIEWED THIS DEDICATED F1 CHROME PROFILE AND ONE IDLE CHATGPT TAB";
const ALLOWED=new Set([
 "https://github.com/jan2xo/bke-worker",
 "https://github.com/jan2xo/bke-worker.git",
 "git@github.com:jan2xo/bke-worker.git",
 "ssh://git@github.com/jan2xo/bke-worker.git"
]);
const H=/^[0-9a-f]{64}$/;
const block=code=>{throw Error("OWNER_POLICY_"+code);};
function exec(cmd,args,timeout=20000){
 try{return execFileSync(cmd,args,{
   encoding:"utf8",stdio:["ignore","pipe","ignore"],
   env:{...process.env,GIT_TERMINAL_PROMPT:"0"},timeout
  }).trim();}
 catch{block("PREFLIGHT_FAILED");}
}
const git=(...args)=>exec("git",["-C",ROOT,...args]);
async function sourcePreflight(){
 if(process.getuid?.()===0||process.argv.length!==2||
   !process.stdin.isTTY||!process.stdout.isTTY||
   Number(process.versions.node.split(".")[0])<22)
   block("OWNER_TTY_NODE22_REQUIRED");
 if((await lstat(SCRIPT)).isSymbolicLink()||
    await realpath(SCRIPT)!==SCRIPT)block("ENTRYPOINT_UNTRUSTED");
 if(!ALLOWED.has(git("remote","get-url","origin"))||
    git("branch","--show-current")!=="main"||
    git("status","--porcelain","--untracked-files=all")!=="")
   block("SOURCE_NOT_VERIFIED");
 git("fetch","--quiet","--no-tags","origin",
    "refs/heads/main:refs/remotes/origin/main");
 if(git("rev-parse","HEAD")!==git("rev-parse","refs/remotes/origin/main"))
   block("STALE_MAIN");
}
async function chromePreflight(){
 // Restrict first physical proof to the owner Mac's official Google Chrome.
 // Other Chromium brands require their own certified process/manifest contract.
 if(process.platform!=="darwin")block("DARWIN_ONLY_OWNER_CERT");
 const home=await realpath(homedir());
 const profile=join(home,".bke-worker","f1","chrome-profile");
 const python=join(ROOT,"scripts","forge_f1_chrome_readiness.py");
 const chain=exec("python3",[python,"--check-profile-chain",home,profile]);
 if(chain!=="PROFILE_CHAIN_PRIVATE_OWNER_VERIFIED")
   block("PRIVATE_PROFILE_NOT_VERIFIED");
 const installed=[
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  join(home,"Applications","Google Chrome.app","Contents","MacOS","Google Chrome")
 ].filter(existsSync);
 if(installed.length!==1)block("GOOGLE_CHROME_IDENTITY_AMBIGUOUS");
 // Verify the publisher before executing ANY bytes of the selected binary.
 // Apple signed-bundle integrity, Google bundle ID and pinned Google Team ID
 // are enforced by macOS codesign, NOT self-reported --version text.
 const signer=join(ROOT,"scripts","forge_f1_chrome_publisher.py");
 let attestation;
 try{attestation=exec("/usr/bin/python3",["-I",signer,installed[0]],95000);}
 catch{block("GOOGLE_CHROME_PUBLISHER_UNVERIFIED");}
 if(attestation!=="BKE_CHROME_GOOGLE_SIGNER_VERIFIED")
   block("GOOGLE_CHROME_PUBLISHER_UNVERIFIED");
 const binary=await realpath(installed[0]);
 if(binary!==installed[0])block("GOOGLE_CHROME_PUBLISHER_UNVERIFIED");
 const m=/^Google Chrome (\d+\.\d+\.\d+\.\d+)$/u.exec(exec(binary,["--version"]));
 if(!m)block("OFFICIAL_CHROME_VERSION_INVALID");
 const digest=exec("python3",[
  python,"--check-process","Darwin",binary,profile,m[1]
 ]);
 if(!H.test(digest)||/^(.)\1{63}$/u.test(digest))
   block("ISOLATED_CHROME_PROCESS_UNVERIFIED");
 return Object.freeze({home,profile,binary,version:m[1],digest,python});
}
async function main(){
 await sourcePreflight();
 const verified=await chromePreflight();
 const rl=createInterface({input:process.stdin,output:process.stdout});
 try{
  console.log("BKE F1-03 / OWNER-ATTESTED LOCAL SETUP / NOT WORKER ENROLLMENT.");
  console.log("Official Chrome dedicated F1 process/profile: SOURCE CHECK PASSED.");
  console.log("Manually open chrome://extensions in THAT profile and inspect");
  console.log("the single enabled BKE Worker Browser Bridge from canonical source.");
  const extension_id=(await rl.question(
   "Extension ID (exactly 32 lowercase a-p chars): ")).trim();
  console.log("Check the BKE extension popup, local device identity.");
  console.log("If needed click Create device identity ONLY in this F1 profile.");
  const worker_id=(await rl.question("Exact F1 worker ID: ")).trim();
  const public_key_sha256=(await rl.question(
   "Displayed P-256 public key SHA-256 (64 lowercase hex): ")).trim();
  console.log("Verify no other worker uses this profile. Open exactly one");
  console.log("manually authenticated, idle chatgpt.com tab; no challenges.");
  const statement=await rl.question("Type exactly '"+PHRASE+"': ");
  if(statement!==PHRASE)block("OWNER_ATTESTATION_REQUIRED");
  // Re-read the actual process after the human review to avoid a stale
  // pre-prompt Chrome identity. Browser runtime is never a remote proof.
  const fresh=await chromePreflight();
  if(fresh.profile!==verified.profile||fresh.binary!==verified.binary||
     fresh.digest!==verified.digest||fresh.version!==verified.version)
   block("PROCESS_CHANGED_DURING_REVIEW");
  const bundle=deriveOwnerAttestedLocalPins({
   worker_id,extension_id,public_key_sha256,
   profile_path:verified.profile,chrome_runtime_sha256:verified.digest,
   verified_process_profile:true,
   owner_attested_single_idle_chatgpt_tab:true,
  });
  const policy=buildReviewedOwnerPolicy(bundle.input);
  console.log("Local-only domain-separated commitments derived.");
  console.log("Not independent Chrome/ChatGPT account attestation; no authority.");
  const approve=await rl.question(
   "Type exactly 'WRITE OWNER-REVIEWED LOCAL POLICY' to persist: ");
  if(approve!=="WRITE OWNER-REVIEWED LOCAL POLICY")
   block("OWNER_WRITE_APPROVAL_REQUIRED");
  // Check again immediately before creating the no-clobber owner file.
  const last=await chromePreflight();
  if(last.digest!==verified.digest||last.profile!==verified.profile||
     last.version!==verified.version)
   block("PROCESS_CHANGED_BEFORE_WRITE");
  const result=await persistOwnerPolicy(policy,{home:verified.home});
  console.log("BKE_F1_OWNER_POLICY="+result.state);
  console.log("BKE_F1_BINDING_EVIDENCE="+bundle.evidence);
  console.log("BKE_F1_INDEPENDENT_BROWSER_ATTESTATION=NOT_PROVEN");
  console.log("BKE_F1_PAIRING_AUTHORITY="+result.pairing_authority);
  console.log("BKE_F1_DISPATCH_AUTHORITY="+result.dispatch_authority);
 }finally{rl.close();}
}
main().catch(e=>{
 const message=String(e?.message||"");
 const reason=message.startsWith("OWNER_POLICY_")?message:
  message.startsWith("OWNER_LOCAL_BINDING_")?message:"OWNER_POLICY_BLOCKED";
 console.error("BKE_F1_OWNER_POLICY=BLOCKED reason="+reason);
 process.exitCode=2;
});
