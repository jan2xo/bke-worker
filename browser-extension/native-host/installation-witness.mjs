// SOURCE-ONLY read-only installation *bytes* witness for Chrome native host.
// Trust requires independently owner-reviewed external hashes. Installer state
// is NOT a cryptographic signature. Never treat output as browser/session
// attestation, pairing, worker assignment or dispatch authority.
import {open,lstat} from "node:fs/promises";
import {constants} from "node:fs";
import {createHash} from "node:crypto";
import {dirname,basename,isAbsolute,resolve} from "node:path";
import {validNativeHostPolicy} from "./host.mjs";

const HOST="bke.worker.desktop";
const ORIGIN=/^chrome-extension:\/\/[a-p]{32}\/$/u;
const SHA=/^[a-f0-9]{64}$/u;
const stateFields="created_by,entry,framing_module,host,host_module,launcher,manifest,origin,policy,sha256,version";
const hashFields="entry,framing,host,launcher,manifest,policy";
const manifestFields="allowed_origins,description,name,path,type";
const matching=(v,fields)=>v!==null&&typeof v==="object"&&!Array.isArray(v)&&Object.keys(v).sort().join(",")===fields;
const fail=()=>{throw Error("NATIVE_INSTALLATION_UNVERIFIED");};
function canonical(p){
  return typeof p==="string"&&isAbsolute(p)&&resolve(p)===p&&!p.includes("\0")&&!p.includes("//");
}
async function parentsAreSafe(p,uid){
  let d=dirname(p);
  for(let i=0;i<48;i++){
    const st=await lstat(d);
    if(!st.isDirectory()||st.isSymbolicLink())fail();
    const perms=st.mode&0o7777;
    if(st.uid!==uid&&st.uid!==0)fail();
    if(perms&0o022){
      // Only a root-owned sticky world-writable ancestor such as /tmp
      // may be shared; leaf components below are checked independently.
      if(!(st.uid===0&&(perms&0o1000)&&(perms&0o002)))fail();
    }
    if(d==="/")return;
    d=dirname(d);
  }
  fail();
}
async function safeRead(p,limit,uid){
  if(!canonical(p))fail();
  await parentsAreSafe(p,uid);
  const before=await lstat(p);
  if(!before.isFile()||before.isSymbolicLink()||before.uid!==uid||
    (before.mode&0o022)!==0||before.size<1||before.size>limit)fail();
  if(!constants.O_NOFOLLOW)fail();
  const h=await open(p,constants.O_RDONLY|constants.O_NOFOLLOW);
  try{
    const st=await h.stat();
    if(!st.isFile()||st.uid!==uid||(st.mode&0o022)!==0||st.size<1||st.size>limit||
      st.ino!==before.ino||st.dev!==before.dev)fail();
    const bytes=await h.readFile();
    if(bytes.length!==st.size)fail();
    const after=await lstat(p);
    if(!after.isFile()||after.ino!==st.ino||after.dev!==st.dev||
      after.size!==st.size||after.mtimeMs!==st.mtimeMs||after.ctimeMs!==st.ctimeMs)fail();
    await parentsAreSafe(p,uid);
    return bytes;
  }finally{await h.close();}
}
const digest=x=>createHash("sha256").update(x).digest("hex");
function parse(b){try{return JSON.parse(b.toString("utf8"));}catch{fail();}}

/**
 * trustedHostConfig MUST be supplied from operator-reviewed local config,
 * not the transaction or an extension/ChatGPT message.
 */
export async function verifyOwnerPinnedChromeInstallation({
  manifestPath,statePath,expectedOrigin,expectedWorkerId,
  ownerReviewedSha256,uid=process.getuid?.(),now=()=>Date.now(),
}={}){
  try{
    if(!canonical(manifestPath)||!canonical(statePath)||
      typeof expectedOrigin!=="string"||!ORIGIN.test(expectedOrigin)||
      typeof expectedWorkerId!=="string"||!/^[a-z0-9][a-z0-9-]{0,62}$/u.test(expectedWorkerId)||
      !Number.isSafeInteger(uid)||uid!==process.getuid?.()||
      !matching(ownerReviewedSha256,hashFields)||!Object.values(ownerReviewedSha256).every(v=>typeof v==="string"&&SHA.test(v)))
      fail();
    const st=parse(await safeRead(statePath,8192,uid));
    if(!matching(st,stateFields)||st.version!==1||st.host!==HOST||
      st.created_by!=="prepare-chrome-native-host.sh"||st.manifest!==manifestPath||
      st.origin!==expectedOrigin||!matching(st.sha256,hashFields))fail();
    const parent=dirname(st.launcher);
    const paths={manifest:manifestPath,launcher:st.launcher,entry:st.entry,
      host:st.host_module,framing:st.framing_module,policy:st.policy};
    const names={launcher:"launch-native-host.sh",entry:"entry.mjs",
      host:"host.mjs",framing:"framing.mjs",policy:"owner-policy.json"};
    for(const [k,n]of Object.entries(names)){
      if(!canonical(paths[k])||dirname(paths[k])!==parent||basename(paths[k])!==n)fail();
    }
    const all={};
    for(const [k,p]of Object.entries(paths)){
      const bytes=await safeRead(p,k==="policy"?4096:16384,uid);
      const hash=digest(bytes);
      if(hash!==st.sha256[k]||hash!==ownerReviewedSha256[k])fail();
      all[k]=bytes;
    }
    const manifest=parse(all.manifest);
    if(!matching(manifest,manifestFields)||manifest.name!==HOST||
      manifest.description!=="BKE Worker local native host (source-only preparation)"||
      manifest.type!=="stdio"||manifest.path!==st.launcher||
      !Array.isArray(manifest.allowed_origins)||manifest.allowed_origins.length!==1||
      manifest.allowed_origins[0]!==expectedOrigin)fail();
    const policy=parse(all.policy);
    if(!validNativeHostPolicy(policy,now())||policy.worker_id!==expectedWorkerId||
      policy.allowed_origin!==expectedOrigin)fail();
    return Object.freeze({
      state:"INSTALLATION_BYTES_VERIFIED",host:HOST,worker_id:expectedWorkerId,
      browser_session_authority:"NONE",device_admission_authority:"NONE",
      dispatch_authority:"NONE",
    });
  }catch{fail();}
}
