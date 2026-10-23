// F1-03 LOCAL owner-attested commitment derivation; NOT device/OS/server attestation.
// This function does not read Chrome profile contents, page state or any secret.
// Real admission and first-send authority remain NONE.
import {createHash} from "node:crypto";
const E=/^[a-p]{32}$/u;
const W=/^[a-z0-9][a-z0-9-]{0,62}$/u;
const H=/^[0-9a-f]{64}$/u;
const FIELDS=[
 "worker_id","extension_id","public_key_sha256",
 "profile_path","chrome_runtime_sha256",
 "verified_process_profile","owner_attested_single_idle_chatgpt_tab",
];
const EXACT=(x,f)=>x!==null&&typeof x==="object"&&!Array.isArray(x)&&
 Object.keys(x).sort().join(",")===f.slice().sort().join(",");
const digest=values=>createHash("sha256").update(JSON.stringify(values)).digest("hex");
const block=()=>{throw Error("OWNER_LOCAL_BINDING_UNVERIFIED");};
export function deriveOwnerAttestedLocalPins(source){
 if(!EXACT(source,FIELDS)||!W.test(source.worker_id)||
    !E.test(source.extension_id)||
    !H.test(source.public_key_sha256)||
    !H.test(source.chrome_runtime_sha256)||
    source.verified_process_profile!==true||
    source.owner_attested_single_idle_chatgpt_tab!==true||
    typeof source.profile_path!=="string"||
    !source.profile_path.startsWith("/")||
    source.profile_path.includes("\0")||
    source.profile_path.includes("//")||
    /(?:^|\/)\.\.?(?:\/|$)/u.test(source.profile_path)||
    /^(.)\1{63}$/u.test(source.public_key_sha256)||
    /^(.)\1{63}$/u.test(source.chrome_runtime_sha256))
   block();
 const {worker_id,extension_id,public_key_sha256,profile_path,chrome_runtime_sha256}=source;
 const allowed_origin="chrome-extension://"+extension_id+"/";
 // Domain separation prevents identical input strings standing for different
 // resources; shared Chrome profile/path still never becomes remote authority.
 const profile_binding_sha256=digest([
  "bke-worker/f1/owner-local-profile-binding/v1",
  worker_id,allowed_origin,public_key_sha256,
  profile_path,chrome_runtime_sha256,
 ]);
 const browser_profile_sha256=digest([
  "bke-worker/f1/owner-local-browser-profile/v1",
  profile_binding_sha256,profile_path,chrome_runtime_sha256,
 ]);
 const bridge_identity_sha256=digest([
  "bke-worker/f1/owner-local-bridge-identity/v1",
  worker_id,allowed_origin,public_key_sha256,
 ]);
 const chatgpt_target_sha256=digest([
  "bke-worker/f1/owner-local-target/v1",
  profile_binding_sha256,"https://chatgpt.com",
  "OWNER_VISUALLY_ATTESTED_ONE_AUTHENTICATED_IDLE_TAB",
 ]);
 return Object.freeze({
  input:Object.freeze({allowed_origin,worker_id,public_key_sha256,
   profile_binding_sha256,browser_profile_sha256,
   chatgpt_target_sha256,bridge_identity_sha256}),
  evidence:"OWNER_ATTESTED_LOCAL_COMMITMENTS_ONLY",
  independent_browser_attestation:"NOT_PROVEN",
  chatgpt_account_attestation:"NOT_PROVEN",
  pairing_authority:"NONE",dispatch_authority:"NONE",
 });
}
