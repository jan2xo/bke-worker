// F1-03 local owner-policy staging: no device/server/PR/dispatch authority.
// All trust pins must originate from an independent owner review; never synthesize them.
import {createHash,randomBytes} from "node:crypto";
import {open,mkdir,lstat,realpath,link,unlink,readFile} from "node:fs/promises";
import {constants} from "node:fs";
import {homedir} from "node:os";
import {join,resolve} from "node:path";
import {validNativeHostPolicy} from "./host.mjs";

const FIELDS=["allowed_origin","worker_id","public_key_sha256",
 "profile_binding_sha256","chatgpt_target_sha256",
 "browser_profile_sha256","bridge_identity_sha256"];
const SHA=/^[0-9a-f]{64}$/u;
const DENY=code=>{throw Error("OWNER_POLICY_"+code);};
const exact=(v,keys)=>v!==null&&typeof v==="object"&&!Array.isArray(v)&&
 Object.keys(v).sort().join(",")===keys.slice().sort().join(",");
const emptyHash=createHash("sha256").update("").digest("hex");
const validPin=x=>typeof x==="string"&&SHA.test(x)&&
 !/^([0-9a-f])\1{63}$/u.test(x)&&x!==emptyHash;
export function buildReviewedOwnerPolicy(inputs,{now=Date.now(),ttlMs=7*86400000}={}){
 if(!exact(inputs,FIELDS)||!Number.isSafeInteger(now)||now<=0||
   !Number.isSafeInteger(ttlMs)||ttlMs<3600000||ttlMs>30*86400000||
   now>Number.MAX_SAFE_INTEGER-ttlMs)DENY("INPUT_INVALID");
 const hashes=FIELDS.slice(2).map(k=>inputs[k]);
 if(hashes.some(x=>!validPin(x))||new Set(hashes).size!==hashes.length)
   DENY("PINS_UNTRUSTED");
 const policy={version:1,allowed_origin:inputs.allowed_origin,
   worker_id:inputs.worker_id,public_key_sha256:inputs.public_key_sha256,
   profile_binding_sha256:inputs.profile_binding_sha256,
   resources:{
     chatgpt_target_sha256:inputs.chatgpt_target_sha256,
     browser_profile_sha256:inputs.browser_profile_sha256,
     bridge_identity_sha256:inputs.bridge_identity_sha256,
   },expires_at_ms:now+ttlMs};
 if(!validNativeHostPolicy(policy,now))DENY("SCHEMA_INVALID");
 // Both the policy and nested target/profile/bridge pins are immutable.
 // A caller must never be able to edit approved commitments after review.
 Object.freeze(policy.resources);
 return Object.freeze(policy);
}
async function ownedDir(p,uid,create=false,ownerPrivate=false){
 if(create){
   try{await mkdir(p,{mode:0o700});}
   catch(e){if(e.code!=="EEXIST")DENY("DIRECTORY_UNAVAILABLE");}
 }
 let s;
 try{s=await lstat(p);}catch{DENY("DIRECTORY_UNAVAILABLE");}
 if(!s.isDirectory()||s.isSymbolicLink()||s.uid!==uid||
   (s.mode&(ownerPrivate?0o077:0o022))!==0)
   DENY("DIRECTORY_UNTRUSTED");
}
export async function persistOwnerPolicy(policy,{
 home=homedir(),uid=process.getuid?.(),now=Date.now()
}={}){
 if(!Number.isSafeInteger(uid)||uid!==process.getuid?.()||
   typeof home!=="string"||!home.startsWith("/")||resolve(home)!==home||
   !Number.isSafeInteger(now)||!validNativeHostPolicy(policy,now))
   DENY("WRITE_DENIED");
 // This exported function must not be weaker than the interactive builder.
 // Re-validate owner-reviewed pin shape and anti-placeholder checks for
 // direct programmatic callers before touching ANY filesystem path.
 let reviewed;
 try{
   reviewed=buildReviewedOwnerPolicy({
     allowed_origin:policy.allowed_origin,worker_id:policy.worker_id,
     public_key_sha256:policy.public_key_sha256,
     profile_binding_sha256:policy.profile_binding_sha256,
     chatgpt_target_sha256:policy.resources.chatgpt_target_sha256,
     browser_profile_sha256:policy.resources.browser_profile_sha256,
     bridge_identity_sha256:policy.resources.bridge_identity_sha256,
   },{now,ttlMs:policy.expires_at_ms-now});
 }catch{DENY("PINS_UNTRUSTED");}
 // Seal the exact validated bytes before the first filesystem await.
 // Caller-owned policy objects, including nested resources, may be mutated
 // while directories are inspected: never serialize the mutable original.
 const bytes=Buffer.from(JSON.stringify(reviewed)+"\n","utf8");
 if(bytes.length>4096)DENY("OVERSIZE");
 let physical;
 try{physical=await realpath(home);}catch{DENY("HOME_UNTRUSTED");}
 if(physical!==home)DENY("HOME_UNTRUSTED");
 await ownedDir(home,uid);
 const config=join(home,".config");
 const app=join(config,"bke-worker");
 const dir=join(app,"native-host");
 // The native entry requires its immediate policy parent to have NO
 // group/other access. Reject incompatible pre-existing directories before
 // creating the policy instead of writing a file the host cannot load.
 for(const p of [config,app,dir])
   await ownedDir(p,uid,true,p===dir);
 const destination=join(dir,"owner-policy.json");
 if(!constants.O_NOFOLLOW)DENY("OS_UNSUPPORTED");
 const temporary=join(dir,".policy-"+randomBytes(16).toString("hex")+".tmp");
 let fd, linked=false;
 try{
   fd=await open(temporary,constants.O_CREAT|constants.O_EXCL|
     constants.O_WRONLY|constants.O_NOFOLLOW,0o600);
   await fd.writeFile(bytes);await fd.sync();await fd.close();fd=null;
   // Atomic hard-link refuses an existing policy, including a symlink.
   await link(temporary,destination);linked=true;
   const st=await lstat(destination);
   if(!st.isFile()||st.isSymbolicLink()||st.uid!==uid||
     (st.mode&0o077)!==0||st.size!==bytes.length||
     !(await readFile(destination)).equals(bytes))DENY("READBACK_FAILED");
 }catch(e){
   if(e.code==="EEXIST")DENY("ALREADY_EXISTS");
   if(e.message?.startsWith("OWNER_POLICY_"))throw e;
   DENY("WRITE_FAILED");
 }finally{
   if(fd)await fd.close().catch(()=>{});
   await unlink(temporary).catch(()=>{});
 }
 if(!linked)DENY("WRITE_FAILED");
 // Once the temporary hardlink has been removed, fsync the containing
 // directory. A file fsync alone does not durably record the new pathname.
 // On uncertainty retain the policy and require manual owner recovery:
 // never claim completion or clobber/retry an ambiguous write.
 let directoryFd;
 try {
   directoryFd=await open(dir,constants.O_RDONLY|constants.O_NOFOLLOW|
     constants.O_DIRECTORY);
   await directoryFd.sync();
 }catch{DENY("DURABILITY_UNCERTAIN");}
 finally{if(directoryFd)await directoryFd.close().catch(()=>{});}
 return Object.freeze({state:"OWNER_POLICY_WRITTEN_LOCAL_ONLY",
   pairing_authority:"NONE",dispatch_authority:"NONE"});
}
