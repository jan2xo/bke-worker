// Chrome native-message host verifies possession of an owner-pinned device
// key; it does NOT issue Command Center authority, worker assignments or JWTs.
import { createHash, createPublicKey, randomBytes, verify } from "node:crypto";
import { nativeFrameReader,writeFrame } from "./framing.mjs";
import { createLocalReadOnlyEnvelopeGate } from "./local-read-only-controller.mjs";

const HOST_AUD = "bke-worker/desktop/native-key-proof/v1";
const WORKER = /^[a-z0-9][a-z0-9-]{0,62}$/u;
const HASH = /^[0-9a-f]{64}$/u;
const COORD = /^[A-Za-z0-9_-]{43}$/u;
const ORIGIN = /^chrome-extension:\/\/[a-p]{32}\/$/u;
const FIELDS = "bridge_identity_sha256,browser_profile_sha256,chatgpt_target_sha256";
const POLICY = "allowed_origin,expires_at_ms,profile_binding_sha256,public_key_sha256,resources,version,worker_id";
const HELLO = "client_nonce,public_key,resources,type,version,worker_id";
const PROBE_HELLO = "client_nonce,public_key,read_only_probe,resources,type,version,worker_id";
const CONTROL_HELLO = "client_nonce,controller_probe,public_key,read_only_probe,resources,type,version,worker_id";
const PROOF = "client_nonce,device_signature,server_nonce,type,version";
export const HOST_PROOF_AUDIENCE = HOST_AUD;
const exact=(x,fields)=>x&&typeof x==="object"&&!Array.isArray(x)&&
  Object.keys(x).sort().join(",")===fields;
const isHash=x=>typeof x==="string"&&HASH.test(x);
function validResources(x) {
  return exact(x,FIELDS)&&Object.values(x).every(isHash);
}
function validPublic(x){
  return exact(x,"crv,kty,x,y")&&x.crv==="P-256"&&x.kty==="EC"&&
    typeof x.x==="string"&&COORD.test(x.x)&&
    typeof x.y==="string"&&COORD.test(x.y);
}
function publicThumbprint(jwk){
  return createHash("sha256").update(JSON.stringify({
    crv:"P-256",kty:"EC",x:jwk.x,y:jwk.y,
  })).digest("hex");
}
export function validNativeHostPolicy(p,at=Date.now()){
  return exact(p,POLICY)&&p.version===1&&
    typeof p.allowed_origin==="string"&&ORIGIN.test(p.allowed_origin)&&
    typeof p.worker_id==="string"&&WORKER.test(p.worker_id)&&
    isHash(p.public_key_sha256)&&isHash(p.profile_binding_sha256)&&
    validResources(p.resources)&&
    Number.isSafeInteger(p.expires_at_ms)&&p.expires_at_ms>at&&
    p.expires_at_ms<=at+90*24*60*60*1000;
}
function sameResources(a,b){
  return Object.keys(a).length===3&&FIELDS.split(",").every(k=>a[k]===b[k]);
}
export function nativeProofMessage({origin,worker_id,public_key_sha256,
  profile_binding_sha256,resources,client_nonce,server_nonce,expires_at_ms}) {
  return JSON.stringify([HOST_AUD,"prove",origin,worker_id,
    public_key_sha256,profile_binding_sha256,
    resources.chatgpt_target_sha256,resources.browser_profile_sha256,
    resources.bridge_identity_sha256,client_nonce,server_nonce,expires_at_ms]);
}
function matchesHello(v,policy){
  const probe=Object.prototype.hasOwnProperty.call(v??{},"read_only_probe");
  const control=Object.prototype.hasOwnProperty.call(v??{},"controller_probe");
  if(!exact(v,control?CONTROL_HELLO:probe?PROBE_HELLO:HELLO)||
     (probe&&v.read_only_probe!==true)||
     (control&&(v.controller_probe!==true||v.read_only_probe!==true))||
     v.type!=="HELLO"||v.version!==1||
     v.worker_id!==policy.worker_id||!validPublic(v.public_key)||
     !validResources(v.resources)||!sameResources(v.resources,policy.resources)||
     !isHash(v.client_nonce))return false;
  try{
    createPublicKey({key:v.public_key,format:"jwk"});
    return publicThumbprint(v.public_key)===policy.public_key_sha256;
  }catch{return false;}
}
function decodeP1363(s){
  if(typeof s!=="string"||!/^[A-Za-z0-9_-]{86}$/u.test(s))return null;
  const bytes=Buffer.from(s,"base64url");
  return bytes.length===64&&bytes.toString("base64url")===s?bytes:null;
}
function matchesProof(value,issued,hello,policy,origin,now,issuedAt){
  // Clock monotonicity is part of this one-shot proof: a signed response
  // must not become valid again after wall-clock rollback or invalid time.
  if(!Number.isSafeInteger(now)||now<issuedAt||
    !exact(value,PROOF)||value.type!=="PROOF"||value.version!==1||
    value.client_nonce!==hello.client_nonce||
    value.server_nonce!==issued.server_nonce||now>=issued.expires_at_ms)
    return false;
  const signature=decodeP1363(value.device_signature);
  if(!signature)return false;
  const message=nativeProofMessage({
    origin,worker_id:hello.worker_id,public_key_sha256:policy.public_key_sha256,
    profile_binding_sha256:policy.profile_binding_sha256,
    resources:policy.resources,client_nonce:hello.client_nonce,
    server_nonce:issued.server_nonce,expires_at_ms:issued.expires_at_ms,
  });
  try{
    const key=createPublicKey({key:hello.public_key,format:"jwk"});
    return verify("sha256",Buffer.from(message,"utf8"),
      {key,dsaEncoding:"ieee-p1363"},signature);
  }catch{return false;}
}

export async function runNativeProofHost({
  input,output,policy,claimedOrigin,now=()=>Date.now(),
  nonce=()=>randomBytes(32).toString("hex"),
  timeoutMs=15_000,controllerOptions=null,
}){
  // A claimed Chrome argv origin is not OS attestation on its own.
  // Browser native host manifest allow_origins / OS registration must be
  // approved separately before any remote server can trust this process.
  const started=now();
  if(!validNativeHostPolicy(policy,started)||
    claimedOrigin!==policy.allowed_origin ||
    !Number.isSafeInteger(timeoutMs)||timeoutMs<100||timeoutMs>15_000)
    throw Error("NATIVE_POLICY_DENIED");
  const reader=nativeFrameReader(input);
  let timer=null;
  const bounded=async()=>{
    return Promise.race([
      reader.next(),
      new Promise((_,reject)=>{
        timer=setTimeout(()=>reject(Error("NATIVE_TIMEOUT")),timeoutMs);
        timer.unref?.();
      }),
    ]).finally(()=>clearTimeout(timer));
  };
  try {
    const hello=await bounded();
    if(!matchesHello(hello,policy))throw Error("NATIVE_HELLO_DENIED");
    const server_nonce=nonce();
    if(!isHash(server_nonce)||server_nonce===hello.client_nonce)
      throw Error("NATIVE_NONCE_DENIED");
    const moment=now();
    if(!Number.isSafeInteger(moment)||moment<started||
      moment>=policy.expires_at_ms)
      throw Error("NATIVE_CLOCK_DENIED");
    const expires_at_ms=Math.min(moment+timeoutMs,policy.expires_at_ms);
    const issued={
      type:"CHALLENGE",version:1,server_nonce,
      client_nonce:hello.client_nonce,expires_at_ms,
      profile_binding_sha256:policy.profile_binding_sha256,
    };
    await writeFrame(output,issued,timeoutMs);
    const proof=await bounded();
    if(!matchesProof(proof,issued,hello,policy,claimedOrigin,now(),moment))
      throw Error("NATIVE_PROOF_DENIED");
    // Proof of local key possession ONLY; never a bearer token, enrollment
    // grant, authenticated Command Center session, or dispatch authority.
    const receipt={
      type:"LOCAL_PROOF_OK",version:1,worker_id:policy.worker_id,
      public_key_sha256:policy.public_key_sha256,
      admission_authority:"NONE",dispatch_authority:"NONE",
    };
    await writeFrame(output,receipt,timeoutMs);
    if(hello.read_only_probe===true){
      // Not a controller admission: only a one-shot echo on an already
      // P-256-verified native channel, with zero dispatch privileges.
      const gate=createLocalReadOnlyEnvelopeGate({
        policy,localReceipt:receipt,clientNonce:hello.client_nonce,
        serverNonce:issued.server_nonce,clock:now,ttlMs:Math.min(5000,timeoutMs),
      });
      try{
        await writeFrame(output,gate.proposal,timeoutMs);
        const response=gate.accept(await bounded());
        if(response.state!=="LOCAL_READ_ONLY_PONG")
          throw Error("NATIVE_READ_ONLY_ENVELOPE_DENIED");
        await writeFrame(output,{
          type:"LOCAL_READ_ONLY_PONG",version:1,
          worker_id:policy.worker_id,
          admission_authority:"NONE",dispatch_authority:"NONE",
          message_send_authority:"NONE",
          controller_authentication:"NOT_ESTABLISHED",
          external_controller_transport:"NOT_CONNECTED",
        },timeoutMs);
      }finally{gate.close();}
      if(hello.controller_probe===true){
          // The actual Chrome entry never passes controllerOptions.
          // Browser messages cannot choose a controller key or socket.
          if(!controllerOptions||typeof controllerOptions!=="object"||
             Array.isArray(controllerOptions))
            throw Error("NATIVE_CONTROLLER_NOT_PROVISIONED");
          const {authenticatedReadOnlyControllerTransport}=
            await import("./controller-transport.mjs");
          const admission=await authenticatedReadOnlyControllerTransport({
            principal:controllerOptions.principal,
            socketPath:controllerOptions.socketPath,
            fenceDir:controllerOptions.fenceDir,
            clock:now,clientNonce:hello.client_nonce,serverNonce:issued.server_nonce,
            scope:{
              worker_id:policy.worker_id,allowed_origin:claimedOrigin,
              profile_binding_sha256:policy.profile_binding_sha256,
              browser_profile_sha256:policy.resources.browser_profile_sha256,
              chatgpt_target_sha256:policy.resources.chatgpt_target_sha256,
              bridge_identity_sha256:policy.resources.bridge_identity_sha256,
            },
          });
          if(admission.state!=="CONTROLLER_AUTH_READ_ONLY")
            throw Error("NATIVE_CONTROLLER_DENIED");
          await writeFrame(output,{
            type:"CONTROLLER_AUTH_READ_ONLY_ACK",version:1,
            worker_id:policy.worker_id,controller_id:admission.controller_id,
            principal_authentication:"ED25519_SIGNATURE_VERIFIED",
            github_assignment:"NOT_VERIFIED",
            chatgpt_target_attestation:"NOT_PROVEN",
            scope_fencing:"LOCAL_PERSISTENT_OWNER_RECOVERY_REQUIRED",
            dispatch_authority:"NONE",message_send_authority:"NONE",
          },timeoutMs);
          return "CONTROLLER_AUTH_READ_ONLY";
        }
        return "LOCAL_READ_ONLY_PONG";
    }
    return "LOCAL_PROOF_OK";
  } finally {
    reader.close();
    if(timer!==null)clearTimeout(timer);
  }
}
