// F1-03 source-only, one-shot read-only envelope boundary.
// NEVER import into an unattended worker until actual native proof + target
// session admission is independently verified. Public digests are NOT MACs,
// bearer tokens, or proof of OS/Chrome/ChatGPT account identity.
import {createHash} from "node:crypto";
import {validNativeHostPolicy} from "./host.mjs";

const HASH=/^[0-9a-f]{64}$/u;
const FIELD_KEYS=[
 "bridge_identity_sha256","client_nonce","expires_at_ms",
 "profile_binding_sha256","proof_binding_sha256","sequence",
 "server_nonce","type","version","worker_id","chatgpt_target_sha256",
];
const RECEIPT_KEYS=[
 "admission_authority","dispatch_authority","public_key_sha256",
 "type","version","worker_id",
];
const exact=(v,fields)=>v!==null&&typeof v==="object"&&!Array.isArray(v)&&
 Object.keys(v).sort().join(",")===fields.slice().sort().join(",");
const deny=code=>Object.freeze({state:"BLOCKED",code});
function verifiedShape(value,policy){
 return exact(value,RECEIPT_KEYS)&&
  value.type==="LOCAL_PROOF_OK"&&value.version===1&&
  value.worker_id===policy.worker_id&&
  value.public_key_sha256===policy.public_key_sha256&&
  value.admission_authority==="NONE"&&value.dispatch_authority==="NONE";
}
function digest(values){
 return createHash("sha256").update(JSON.stringify(values)).digest("hex");
}
/**
 * Pure gate for a proposed LOCAL read-only control envelope after a
 * cryptographically verified host receipt. Receipt SHAPE alone is spoofable:
 * this module cannot issue a trusted controller session or dispatch grant.
 *
 * IMPORTANT: no I/O, no sender, no Chrome connection, no authority.
 * A future host transport MUST bind the caller to the actual signed proof
 * and durably refuse duplicates across MV3/native-host restarts.
 */
export function createLocalReadOnlyEnvelopeGate({
 policy,localReceipt,clientNonce,serverNonce,
 clock=()=>Date.now(),ttlMs=5000,
}={}){
 let issued;
 try{issued=clock();}catch{throw Error("LOCAL_CONTROL_CLOCK_UNAVAILABLE");}
 if(!Number.isSafeInteger(issued)||issued<=0||
   !validNativeHostPolicy(policy,issued)||
   !verifiedShape(localReceipt,policy)||
   typeof clientNonce!=="string"||!HASH.test(clientNonce)||
   typeof serverNonce!=="string"||!HASH.test(serverNonce)||
   clientNonce===serverNonce||
   !Number.isSafeInteger(ttlMs)||ttlMs<100||ttlMs>5000)
  throw Error("LOCAL_CONTROL_PROOF_OR_POLICY_UNVERIFIED");
 const expires=Math.min(policy.expires_at_ms,issued+ttlMs);
 if(expires<=issued)throw Error("LOCAL_CONTROL_EXPIRED");
 const proofBinding=digest([
  "bke-worker/desktop/local-controller/read-only/v1",
  policy.worker_id,policy.allowed_origin,policy.public_key_sha256,
  policy.profile_binding_sha256,
  policy.resources.chatgpt_target_sha256,
  policy.resources.bridge_identity_sha256,
  clientNonce,serverNonce,expires,
 ]);
 let consumed=false;
 return Object.freeze({
  // For synthetic wire fixtures ONLY; public hashes are not credentials.
  proposal:Object.freeze({
   type:"LOCAL_READ_ONLY_PING",version:1,sequence:1,
   worker_id:policy.worker_id,
   profile_binding_sha256:policy.profile_binding_sha256,
   chatgpt_target_sha256:policy.resources.chatgpt_target_sha256,
   bridge_identity_sha256:policy.resources.bridge_identity_sha256,
   client_nonce:clientNonce,server_nonce:serverNonce,
   proof_binding_sha256:proofBinding,expires_at_ms:expires,
  }),
  accept(frame){
   // Spend even malformed attempts. No retry or second delivery.
   if(consumed)return deny("LOCAL_CONTROL_REPLAY_OR_ALREADY_CONSUMED");
   consumed=true;
   let at;
   try{at=clock();}catch{return deny("LOCAL_CONTROL_CLOCK_UNAVAILABLE");}
   if(!Number.isSafeInteger(at)||at<issued||at>=expires)
    return deny("LOCAL_CONTROL_EXPIRED_OR_CLOCK_REWOUND");
   if(!exact(frame,FIELD_KEYS)||frame.type!=="LOCAL_READ_ONLY_PING"||
      frame.version!==1||frame.sequence!==1||
      frame.worker_id!==policy.worker_id||
      frame.profile_binding_sha256!==policy.profile_binding_sha256||
      frame.chatgpt_target_sha256!==policy.resources.chatgpt_target_sha256||
      frame.bridge_identity_sha256!==policy.resources.bridge_identity_sha256||
      frame.client_nonce!==clientNonce||
      frame.server_nonce!==serverNonce||
      frame.proof_binding_sha256!==proofBinding||
      frame.expires_at_ms!==expires)
    return deny("LOCAL_CONTROL_ENVELOPE_DENIED");
   return Object.freeze({
    state:"LOCAL_READ_ONLY_PONG",
    worker_id:policy.worker_id,
    admission_authority:"NONE",
    dispatch_authority:"NONE",
    message_send_authority:"NONE",
    controller_authentication:"NOT_ESTABLISHED",
    live_transport:"NOT_CONNECTED",
   });
  },
  close(){consumed=true;},
 });
}
