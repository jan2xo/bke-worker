// SOURCE-ONLY: one-use host-side evidence signer matching Command Center PR #57.
// NOT an OS attestor, Chrome peer verifier, enrollment grant or dispatch bridge.
// The injected inspector MUST be private, platform-owned and independently
// authenticated; a claimed Chrome argv origin or browser message is NOT proof.
import { sign } from "node:crypto";

const AUD="bke-command-center/private-native-peer-attestor/v1";
const GATEWAY_AUD="bke-command-center/preproduction/native-device-admission/v1";
const HASH=/^[a-f0-9]{64}$/u;
const WORKER=/^[a-z0-9][a-z0-9-]{0,62}$/u;
const PIN_KEYS="bridge_identity_sha256,browser_profile_sha256,chatgpt_target_sha256,identity_public_key_sha256,source,worker_id";
const BIND_KEYS="audience,bridge_identity_sha256,browser_profile_sha256,chatgpt_target_sha256,expires_at_ms,identity_public_key_sha256,session_binding_sha256,source,worker_id";
const CHALLENGE="request_nonce,version";
const SOURCES=new Set(["DESKTOP_EXTENSION_NATIVE","GECKOVIEW_EXTENSION_NATIVE"]);
const exact=(v,fields)=>v!==null&&typeof v==="object"&&!Array.isArray(v)&&Object.keys(v).sort().join(",")===fields;
const hash=v=>typeof v==="string"&&HASH.test(v);
const validPins=p=>exact(p,PIN_KEYS)&&typeof p.worker_id==="string"&&WORKER.test(p.worker_id)&&
  SOURCES.has(p.source)&&["identity_public_key_sha256","chatgpt_target_sha256","browser_profile_sha256","bridge_identity_sha256"].every(k=>hash(p[k]));
const validBinding=(b,now)=>exact(b,BIND_KEYS)&&b.audience===GATEWAY_AUD&&SOURCES.has(b.source)&&
  typeof b.worker_id==="string"&&WORKER.test(b.worker_id)&&
  ["identity_public_key_sha256","session_binding_sha256","chatgpt_target_sha256","browser_profile_sha256","bridge_identity_sha256"].every(k=>hash(b[k]))&&
  Number.isSafeInteger(b.expires_at_ms)&&b.expires_at_ms>now&&b.expires_at_ms<=now+30_000;
const nowMs=clock=>{try{const n=clock();return Number.isSafeInteger(n)&&n>0&&n<Number.MAX_SAFE_INTEGER-30_000?n:null;}catch{return null;}};
function validNonce(s){
  if(typeof s!=="string"||!/^[A-Za-z0-9_-]{43}$/u.test(s))return false;
  const b=Buffer.from(s,"base64url");
  return b.length===32&&b.toString("base64url")===s;
}
export const PRIVATE_PEER_ATTESTOR_AUDIENCE=AUD;
export function canonicalPrivatePeerEvidence(requestNonce,b){
  return JSON.stringify([AUD,1,requestNonce,b.audience,b.source,b.worker_id,
    b.identity_public_key_sha256,b.session_binding_sha256,b.chatgpt_target_sha256,
    b.browser_profile_sha256,b.bridge_identity_sha256,b.expires_at_ms]);
}

/**
 * This is a SIGNER, not a platform attestation adapter. The trusted host
 * injects a separate locally protected attestor key and inspectTrustedPeer.
 * Neither may be populated from remote JSON, Chrome argv, extension data
 * or the device's own P-256 identity key.
 */
export function createPrivatePeerEvidenceSigner({
  attestorKey,ownerPins,inspectTrustedPeer,clock=()=>Date.now(),
  timeoutMs=10_000,maxNonces=64,
}={}){
  if(attestorKey?.type!=="private"||attestorKey?.asymmetricKeyType!=="ec"||
    attestorKey?.asymmetricKeyDetails?.namedCurve!=="prime256v1"||
    !validPins(ownerPins)||typeof inspectTrustedPeer!=="function"||
    !Number.isSafeInteger(timeoutMs)||timeoutMs<100||timeoutMs>15_000||
    !Number.isSafeInteger(maxNonces)||maxNonces<1||maxNonces>256)
    throw Error("NATIVE_ATTESTOR_NOT_CONFIGURED");
  const pins=Object.freeze(structuredClone(ownerPins));
  const spent=new Set();
  let busy=false;
  return async function issueSignedPeerEvidence(link,challenge) {
    const start=nowMs(clock);
    if(start===null||!link||typeof link!=="object"||
      !exact(challenge,CHALLENGE)||challenge.version!==1||
      !validNonce(challenge.request_nonce)||busy||spent.size>=maxNonces||
      spent.has(challenge.request_nonce))
      throw Error("NATIVE_ATTESTOR_REQUEST_DENIED");
    // Claim before ANY await. No retry after unknown signing/delivery.
    spent.add(challenge.request_nonce);busy=true;
    let timer=null;
    try{
      const candidate=await Promise.race([
        Promise.resolve().then(()=>inspectTrustedPeer(link)),
        new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error("NATIVE_ATTESTOR_TIMEOUT")),timeoutMs);}),
      ]);
      const after=nowMs(clock);
      if(after===null||after<start||after>=start+timeoutMs)
        throw Error("NATIVE_ATTESTOR_TIME_INVALID");
      // Snapshot before an async inspector can mutate its reference.
      let b;
      try{b=structuredClone(candidate);}catch{throw Error("NATIVE_ATTESTOR_PEER_INVALID");}
      if(!validBinding(b,after)||
        [...Object.keys(pins)].some(k=>b[k]!==pins[k]))
        throw Error("NATIVE_ATTESTOR_PEER_DENIED");
      const signature=sign("sha256",Buffer.from(canonicalPrivatePeerEvidence(challenge.request_nonce,b),"utf8"),
        {key:attestorKey,dsaEncoding:"ieee-p1363"}).toString("base64url");
      const final=nowMs(clock);
      if(final===null||final<after||final>=b.expires_at_ms||
        !/^[A-Za-z0-9_-]{86}$/u.test(signature))
        throw Error("NATIVE_ATTESTOR_OUTCOME_UNCERTAIN");
      return Object.freeze({version:1,request_nonce:challenge.request_nonce,binding:Object.freeze(b),signature});
    }catch{
      // No remote details, key material, browser profile or secrets in errors.
      throw Error("NATIVE_ATTESTOR_BLOCKED");
    }finally{if(timer!==null)clearTimeout(timer);busy=false;}
  };
}
