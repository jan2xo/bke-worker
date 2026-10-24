// Local Chrome native-host P-256 key-possession client (owner OPT-IN only).
// service-worker.ts imports it only through the trusted-popup proof action;
// nativeMessaging is OPTIONAL and Chrome requests it after a human button click.
// Real owner Mac host registration/physical handshake remains UNPROVEN.
// Local proof does not grant enrollment, network dispatch, ChatGPT sends,
// authenticated controller sessions or GitHub assignment authority.
import type { createDeviceIdentityBridge, NativeProofChallenge } from "./device-identity.js";

export const NATIVE_HOST_NAME="bke.worker.desktop";
const HASH=/^[a-f0-9]{64}$/;
const ORIGIN=/^chrome-extension:\/\/[a-p]{32}\/$/;
const RESOURCE_KEYS=["chatgpt_target_sha256","browser_profile_sha256","bridge_identity_sha256"] as const;
const CHALLENGE_KEYS=["client_nonce","expires_at_ms","profile_binding_sha256","server_nonce","type","version"] as const;
const RECEIPT_KEYS=["admission_authority","dispatch_authority","public_key_sha256","type","version","worker_id"] as const;
const PING_KEYS=["bridge_identity_sha256","chatgpt_target_sha256","client_nonce",
  "expires_at_ms","profile_binding_sha256","proof_binding_sha256",
  "sequence","server_nonce","type","version","worker_id"] as const;
const PONG_KEYS=["admission_authority","controller_authentication","dispatch_authority",
  "external_controller_transport","message_send_authority","type","version","worker_id"] as const;
type ResourcePins={chatgpt_target_sha256:string;browser_profile_sha256:string;bridge_identity_sha256:string};
type DeviceIdentity=ReturnType<typeof createDeviceIdentityBridge>;
type Listener=(message:unknown)=>void;
type DisconnectListener=()=>void;
type Port={
  postMessage(message:unknown):void;
  disconnect():void;
  onMessage:{addListener(fn:Listener):void;removeListener(fn:Listener):void};
  onDisconnect:{addListener(fn:DisconnectListener):void;removeListener(fn:DisconnectListener):void};
};
type Runtime={
  getURL(path:string):string;
  connectNative(name:string):Port;
};
type ClientOpts={
  runtime:Runtime; identity:DeviceIdentity; workerId:string;
  resources:ResourcePins; profileBindingSha256:string;
  clock?:()=>number; cryptoImpl?:Pick<Crypto,"getRandomValues"|"subtle">;
  timeoutMs?:number; readOnlyProbe?:boolean;
};
type Outcome={state:"LOCAL_PROOF_OK";worker_id:string;public_key_sha256:string;
  admission_authority:"NONE";dispatch_authority:"NONE"}|
  {state:"LOCAL_READ_ONLY_PONG";worker_id:string;public_key_sha256:string;
   admission_authority:"NONE";dispatch_authority:"NONE";
   message_send_authority:"NONE";controller_authentication:"NOT_ESTABLISHED";
   external_controller_transport:"NOT_CONNECTED"}|
  {state:"BLOCKED";code:string};
const blocked=(code:string):Outcome=>({state:"BLOCKED",code});
const exact=(v:unknown,keys:readonly string[]):v is Record<string,unknown> =>
  v!==null&&typeof v==="object"&&!Array.isArray(v) &&
  Object.keys(v).sort().join(",") === [...keys].sort().join(",");
function resourceShape(v:unknown):v is ResourcePins {
  return exact(v,RESOURCE_KEYS)&&RESOURCE_KEYS.every(k=>typeof v[k]==="string"&&HASH.test(v[k] as string));
}
function freshTime(clock:()=>number):number|null {
  try {const at=clock();return Number.isSafeInteger(at)&&at>0&&at<Number.MAX_SAFE_INTEGER-16000?at:null;}
  catch{return null;}
}
function validChallenge(x:unknown,nonce:string,profile:string,at:number,ttl:number):
  x is {type:"CHALLENGE";version:1;client_nonce:string;server_nonce:string;expires_at_ms:number;profile_binding_sha256:string} {
  return exact(x,CHALLENGE_KEYS)&&x.type==="CHALLENGE"&&x.version===1&&
    x.client_nonce===nonce&&typeof x.server_nonce==="string"&&HASH.test(x.server_nonce)&&
    x.server_nonce!==nonce&&x.profile_binding_sha256===profile&&
    typeof x.expires_at_ms==="number"&&Number.isSafeInteger(x.expires_at_ms)&&
    x.expires_at_ms>at&&x.expires_at_ms<=at+ttl;
}
function validReceipt(x:unknown,worker:string,hash:string):boolean {
  return exact(x,RECEIPT_KEYS)&&x.type==="LOCAL_PROOF_OK"&&x.version===1&&
    x.worker_id===worker&&x.public_key_sha256===hash&&
    x.admission_authority==="NONE"&&x.dispatch_authority==="NONE";
}
async function validReadOnlyPing(
  value:unknown, worker:string, key:string, origin:string, resources:ResourcePins,
  profile:string, clientNonce:string, serverNonce:string, proofExpiry:number,
  clock:()=>number, cryptoImpl:Pick<Crypto,"getRandomValues"|"subtle">,
):Promise<boolean>{
  const at=freshTime(clock);
  if(at===null||!exact(value,PING_KEYS)||value.type!=="LOCAL_READ_ONLY_PING"||
    value.version!==1||value.sequence!==1||value.worker_id!==worker||
    value.profile_binding_sha256!==profile||
    value.chatgpt_target_sha256!==resources.chatgpt_target_sha256||
    value.bridge_identity_sha256!==resources.bridge_identity_sha256||
    value.client_nonce!==clientNonce||value.server_nonce!==serverNonce||
    typeof value.proof_binding_sha256!=="string"||!HASH.test(value.proof_binding_sha256)||
    typeof value.expires_at_ms!=="number"||!Number.isSafeInteger(value.expires_at_ms)||
    value.expires_at_ms<=at||value.expires_at_ms>at+5000||
    value.expires_at_ms>proofExpiry)return false;
  const payload=["bke-worker/desktop/local-controller/read-only/v1",
    worker,origin,key,profile,resources.chatgpt_target_sha256,
    resources.bridge_identity_sha256,clientNonce,serverNonce,value.expires_at_ms];
  try{
    const bytes=await cryptoImpl.subtle.digest("SHA-256",
      new TextEncoder().encode(JSON.stringify(payload)));
    const digest=Array.from(new Uint8Array(bytes))
      .map(b=>b.toString(16).padStart(2,"0")).join("");
    return digest===value.proof_binding_sha256;
  }catch{return false;}
}
function validReadOnlyPong(value:unknown,worker:string):boolean{
  return exact(value,PONG_KEYS)&&value.type==="LOCAL_READ_ONLY_PONG"&&
    value.version===1&&value.worker_id===worker&&
    value.admission_authority==="NONE"&&value.dispatch_authority==="NONE"&&
    value.message_send_authority==="NONE"&&
    value.controller_authentication==="NOT_ESTABLISHED"&&
    value.external_controller_transport==="NOT_CONNECTED";
}
function nonce(cryptoImpl:Pick<Crypto,"getRandomValues">):string {
  const b=new Uint8Array(32);
  cryptoImpl.getRandomValues(b);
  return [...b].map(x=>x.toString(16).padStart(2,"0")).join("");
}

// Serial single-session listener. No reconnect or automatic retry on uncertain
// send, P-256 signing, host disconnect, MV3 suspension or timeout.
function channel(port:Port,deadline:number,clock:()=>number){
  let failed=false, closed=false;
  const queue:unknown[]=[];
  let wake:((value:unknown)=>void)|null=null;
  let fail:(()=>void)|null=null;
  const onMessage=(msg:unknown)=>{
    if(closed)return;
    if(wake){const next=wake;wake=null;fail=null;next(msg);return;}
    if(queue.length>0){failed=true;return;}
    queue.push(msg);
  };
  const onDisconnect=()=>{failed=true;if(fail){const f=fail;fail=null;wake=null;f();}};
  port.onMessage.addListener(onMessage);
  port.onDisconnect.addListener(onDisconnect);
  const receive=async()=>{
    if(failed||closed)throw Error("NATIVE_CHANNEL_UNAVAILABLE");
    if(queue.length>0)return queue.shift();
    const left=Math.min(deadline-clock(),15_000);
    if(!Number.isSafeInteger(left)||left<=0)throw Error("NATIVE_CHANNEL_TIMEOUT");
    return new Promise<unknown>((resolve,reject)=>{
      const timer=setTimeout(()=>{
        failed=true;wake=null;fail=null;reject(Error("NATIVE_CHANNEL_TIMEOUT"));
      },left);
      wake=x=>{clearTimeout(timer);resolve(x);};
      fail=()=>{clearTimeout(timer);reject(Error("NATIVE_CHANNEL_DISCONNECTED"));};
    });
  };
  return Object.freeze({
    send(message:unknown){
      if(failed||closed||clock()>=deadline)throw Error("NATIVE_CHANNEL_UNAVAILABLE");
      port.postMessage(message);
    },
    receive,
    close(){
      closed=true;
      port.onMessage.removeListener(onMessage);
      port.onDisconnect.removeListener(onDisconnect);
      try{port.disconnect();}catch{ /* already gone */ }
    },
  });
}

export async function proveLocalNativeHost({
  runtime,identity,workerId,resources,profileBindingSha256,
  clock=()=>Date.now(),cryptoImpl=crypto,timeoutMs=15_000,readOnlyProbe=false,
}:ClientOpts):Promise<Outcome>{
  if(typeof workerId!=="string"||!/^[a-z0-9][a-z0-9-]{0,62}$/.test(workerId) ||
    !resourceShape(resources)||typeof profileBindingSha256!=="string"||
    !HASH.test(profileBindingSha256)||!Number.isSafeInteger(timeoutMs)||
    timeoutMs<100||timeoutMs>15_000||typeof readOnlyProbe!=="boolean"||
    typeof runtime?.getURL!=="function"||typeof runtime?.connectNative!=="function"||
    typeof identity?.read!=="function"||typeof identity?.signNativeProof!=="function")
    return blocked("NATIVE_CLIENT_CONFIG_INVALID");
  const at=freshTime(clock);
  if(at===null)return blocked("NATIVE_CLIENT_CLOCK_INVALID");
  const origin=runtime.getURL("");
  if(typeof origin!=="string"||!ORIGIN.test(origin))
    return blocked("NATIVE_CLIENT_EXTENSION_ORIGIN_INVALID");
  let pub;
  try{pub=await identity.read(workerId);}
  catch{return blocked("NATIVE_CLIENT_IDENTITY_UNAVAILABLE");}
  if(pub.state!=="READY")return blocked("NATIVE_CLIENT_IDENTITY_UNAVAILABLE");
  let clientNonce:string;
  try{clientNonce=nonce(cryptoImpl);}
  catch{return blocked("NATIVE_CLIENT_RANDOM_UNAVAILABLE");}
  if(!HASH.test(clientNonce))return blocked("NATIVE_CLIENT_RANDOM_UNAVAILABLE");
  let port:Port;
  try{port=runtime.connectNative(NATIVE_HOST_NAME);}
  catch{return blocked("NATIVE_CLIENT_HOST_UNAVAILABLE");}
  // Chrome must grant optional nativeMessaging from an explicit popup click.
  // This method is NEVER invoked on service-worker startup or by page scripts.
  // Successful local P-256 proof is NOT authenticated controller admission.
  const wire=channel(port,at+timeoutMs,clock);
  try{
    wire.send({type:"HELLO",version:1,worker_id:workerId,
      public_key:pub.public_key,resources:{...resources},
      client_nonce:clientNonce,...(readOnlyProbe?{read_only_probe:true}:{})});
    const incoming=await wire.receive();
    const now=freshTime(clock);
    if(now===null||!validChallenge(incoming,clientNonce,profileBindingSha256,now,15_000))
      return blocked("NATIVE_CLIENT_CHALLENGE_DENIED");
    const challenge:NativeProofChallenge={
      origin,worker_id:workerId,public_key_sha256:pub.public_key_sha256,
      profile_binding_sha256:profileBindingSha256,
      resources:{...resources},client_nonce:clientNonce,
      server_nonce:incoming.server_nonce,expires_at_ms:incoming.expires_at_ms,
    };
    const proof=await identity.signNativeProof(workerId,challenge);
    if(proof.state!=="SIGNED")return blocked("NATIVE_CLIENT_PROOF_DENIED");
    if(freshTime(clock)===null||clock()>=challenge.expires_at_ms)
      return blocked("NATIVE_CLIENT_EXPIRED");
    wire.send({type:"PROOF",version:1,client_nonce:clientNonce,
      server_nonce:incoming.server_nonce,device_signature:proof.device_signature});
    const receipt=await wire.receive();
    if(!validReceipt(receipt,workerId,pub.public_key_sha256))
      return blocked("NATIVE_CLIENT_RECEIPT_DENIED");
    if(readOnlyProbe){
      // Only after a genuine signed local proof, on this one Chrome-native
      // port; public SHA-256 binds fields but is NOT controller authentication.
      const ping=await wire.receive();
      if(!await validReadOnlyPing(
        ping,workerId,pub.public_key_sha256,origin,resources,
        profileBindingSha256,clientNonce,incoming.server_nonce,
        incoming.expires_at_ms,clock,cryptoImpl))
        return blocked("NATIVE_CLIENT_READ_ONLY_PING_DENIED");
      wire.send(ping);
      const pong=await wire.receive();
      if(!validReadOnlyPong(pong,workerId))
        return blocked("NATIVE_CLIENT_READ_ONLY_PONG_DENIED");
      return Object.freeze({state:"LOCAL_READ_ONLY_PONG",
        worker_id:workerId,public_key_sha256:pub.public_key_sha256,
        admission_authority:"NONE",dispatch_authority:"NONE",
        message_send_authority:"NONE",
        controller_authentication:"NOT_ESTABLISHED",
        external_controller_transport:"NOT_CONNECTED"});
    }
    return Object.freeze({state:"LOCAL_PROOF_OK",worker_id:workerId,
      public_key_sha256:pub.public_key_sha256,
      admission_authority:"NONE",dispatch_authority:"NONE"});
  }catch{return blocked("NATIVE_CLIENT_OUTCOME_UNCERTAIN");}
  finally{wire.close();}
}
