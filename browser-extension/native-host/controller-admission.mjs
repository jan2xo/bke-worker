// FORGE F1-03: authenticated controller principal, READ-ONLY admission only.
// Caller MUST first verify the Chrome-native P-256 proof on the same channel.
// Neither public hashes, an owner receipt, nor this module attest GitHub ownership
// or allow ChatGPT messages. Local durable fences fail closed on crash/restart.
import {createHash, createPublicKey, randomBytes, verify} from 'node:crypto';
import {open, lstat, realpath} from 'node:fs/promises';
import {constants} from 'node:fs';
import {join} from 'node:path';

const HASH=/^[0-9a-f]{64}$/u;
const WORKER=/^[a-z0-9][a-z0-9-]{0,62}$/u;
const SIG=/^[A-Za-z0-9_-]{86}$/u;
const B64=/^[A-Za-z0-9_-]{43}$/u;
const exact=(x,keys)=>x!==null&&typeof x==='object'&&!Array.isArray(x)&&
  Object.keys(x).sort().join(',')===keys.slice().sort().join(',');
const digest=x=>createHash('sha256').update(JSON.stringify(x)).digest('hex');
const BLOCK=code=>{throw Error('CONTROLLER_'+code);};
const SCOPE=['allowed_origin','bridge_identity_sha256','browser_profile_sha256',
  'chatgpt_target_sha256','profile_binding_sha256','worker_id'];
const SIGNED=['challenge_nonce','client_nonce','controller_id','expires_at_ms',
  'issued_at_ms','profile_binding_sha256','server_nonce','signature',
  'type','version','worker_id','bridge_identity_sha256',
  'browser_profile_sha256','chatgpt_target_sha256'];
const OWNER=['controller_id','public_key'];
export const CONTROLLER_AUDIENCE='bke-worker/f1/desktop/controller-read-only/v1';

function principalKey(principal){
  if(!exact(principal,OWNER)||!WORKER.test(principal.controller_id)||
     !exact(principal.public_key,['crv','kty','x'])||
     principal.public_key.crv!=='Ed25519'||principal.public_key.kty!=='OKP'||
     typeof principal.public_key.x!=='string'||!B64.test(principal.public_key.x)||
     /^([A-Za-z0-9_-])\1{42}$/u.test(principal.public_key.x))
    BLOCK('PRINCIPAL_INVALID');
  try{
    const key=createPublicKey({key:principal.public_key,format:'jwk'});
    if(key.asymmetricKeyType!=='ed25519'||
       key.export({format:'jwk'}).x!==principal.public_key.x)BLOCK('PRINCIPAL_INVALID');
    return key;
  }catch{BLOCK('PRINCIPAL_INVALID');}
}
function validScope(scope){
  return exact(scope,SCOPE)&&WORKER.test(scope.worker_id)&&
   /^chrome-extension:\/\/[a-p]{32}\/$/u.test(scope.allowed_origin)&&
   SCOPE.filter(k=>k.endsWith('_sha256')).every(k=>typeof scope[k]==='string'&&HASH.test(scope[k]))&&
   new Set(SCOPE.filter(k=>k.endsWith('_sha256')).map(k=>scope[k])).size===4;
}
export function controllerSignedPayload(challenge,controllerId){
  // Canonical immutable order; no caller-supplied arbitrary commands.
  return JSON.stringify([CONTROLLER_AUDIENCE,'ADMIT_READ_ONLY',controllerId,
    challenge.worker_id,challenge.allowed_origin,
    challenge.profile_binding_sha256,challenge.browser_profile_sha256,
    challenge.chatgpt_target_sha256,challenge.bridge_identity_sha256,
    challenge.client_nonce,challenge.server_nonce,challenge.challenge_nonce,
    challenge.issued_at_ms,challenge.expires_at_ms]);
}

// One-use challenge bound to both local signed-P256 nonces; the external
// controller must prove possession of a DIFFERENT owner-pinned Ed25519 key.
export function createControllerChallenge({scope,principal,clientNonce,serverNonce,
  clock=()=>Date.now(),nonce=()=>randomBytes(32).toString('hex'),ttlMs=3000}={}){
  const key=principalKey(principal);
  const issued=clock();
  if(!validScope(scope)||!HASH.test(clientNonce)||!HASH.test(serverNonce)||
     clientNonce===serverNonce||!Number.isSafeInteger(issued)||issued<=0||
     !Number.isSafeInteger(ttlMs)||ttlMs<100||ttlMs>5000||
     issued>Number.MAX_SAFE_INTEGER-ttlMs)BLOCK('CHALLENGE_INVALID');
  const challengeNonce=nonce();
  if(typeof challengeNonce!=='string'||!HASH.test(challengeNonce)||
     challengeNonce===clientNonce||challengeNonce===serverNonce)
    BLOCK('CHALLENGE_INVALID');
  const challenge=Object.freeze({type:'CONTROLLER_CHALLENGE',version:1,
    ...scope,client_nonce:clientNonce,server_nonce:serverNonce,
    challenge_nonce:challengeNonce,issued_at_ms:issued,expires_at_ms:issued+ttlMs});
  let consumed=false;
  return Object.freeze({challenge,
    async accept(frame,{fenceDir}={}){
      if(consumed)BLOCK('REPLAY_OR_UNCERTAIN');
      consumed=true; // Even invalid frames and failing writes consume the attempt.
      let at;try{at=clock();}catch{BLOCK('CLOCK_INVALID');}
      if(!Number.isSafeInteger(at)||at<issued||at>=challenge.expires_at_ms)
        BLOCK('EXPIRED_OR_CLOCK_REWOUND');
      if(!exact(frame,SIGNED)||frame.type!=='CONTROLLER_AUTH_READ_ONLY'||
         frame.version!==1||frame.controller_id!==principal.controller_id||
         frame.worker_id!==scope.worker_id||
         frame.profile_binding_sha256!==scope.profile_binding_sha256||
         frame.browser_profile_sha256!==scope.browser_profile_sha256||
         frame.chatgpt_target_sha256!==scope.chatgpt_target_sha256||
         frame.bridge_identity_sha256!==scope.bridge_identity_sha256||
         frame.client_nonce!==clientNonce||frame.server_nonce!==serverNonce||
         frame.challenge_nonce!==challengeNonce||
         frame.issued_at_ms!==issued||frame.expires_at_ms!==challenge.expires_at_ms||
         typeof frame.signature!=='string'||!SIG.test(frame.signature))
        BLOCK('ENVELOPE_DENIED');
      const signature=Buffer.from(frame.signature,'base64url');
      if(signature.length!==64||signature.toString('base64url')!==frame.signature||
         !verify(null,Buffer.from(controllerSignedPayload(challenge,principal.controller_id)),
           key,signature))BLOCK('SIGNATURE_DENIED');
      // These are LOCAL, conservative isolation reservations, not Github leases.
      // All locks survive a disconnect/crash/clock expiry until owner recovery.
      await reserveFences(fenceDir,scope,principal.controller_id,challengeNonce);
      // Fsync may complete after the signature's short expiry. Refuse a stale
      // successful receipt but RETAIN all fences as uncertain owner recovery;
      // never roll back or automatically reassign an in-flight reservation.
      let completedAt;try{completedAt=clock();}catch{BLOCK('CLOCK_INVALID');}
      if(!Number.isSafeInteger(completedAt)||completedAt<at||
         completedAt>=challenge.expires_at_ms)
        BLOCK('EXPIRED_OR_CLOCK_REWOUND');
      return Object.freeze({state:'CONTROLLER_AUTH_READ_ONLY',
        worker_id:scope.worker_id,controller_id:principal.controller_id,
        principal_authentication:'ED25519_SIGNATURE_VERIFIED',
        scope_fencing:'LOCAL_PERSISTENT_OWNER_RECOVERY_REQUIRED',
        github_assignment:'NOT_VERIFIED',chatgpt_target_attestation:'NOT_PROVEN',
        dispatch_authority:'NONE',message_send_authority:'NONE'});
    },
    close(){consumed=true;},
  });
}

async function reserveFences(dir,scope,principalId,nonce){
  if(typeof dir!=='string'||!dir.startsWith('/')||dir.includes('\0')||
     dir.includes('//')||/(?:^|\/)\.\.?(?:\/|$)/u.test(dir)||
     !constants.O_NOFOLLOW||typeof process.getuid!=='function')BLOCK('FENCE_ROOT_DENIED');
  let st;try{st=await lstat(dir);if(await realpath(dir)!==dir)BLOCK('FENCE_ROOT_DENIED');}
  catch{BLOCK('FENCE_ROOT_DENIED');}
  if(!st.isDirectory()||st.isSymbolicLink()||st.uid!==process.getuid()||
     (st.mode&0o077)!==0)BLOCK('FENCE_ROOT_DENIED');
  const resources=[['worker',scope.worker_id],['profile',scope.browser_profile_sha256],
    ['target',scope.chatgpt_target_sha256],['bridge',scope.bridge_identity_sha256]];
  const record=JSON.stringify({version:1,controller_id:principalId,
    worker_id:scope.worker_id,scope_sha256:digest(scope),challenge_nonce:nonce,
    state:'RESERVED_UNCERTAIN_NO_AUTOMATIC_RELEASE'})+'\n';
  // Sorted resource-independent locks: different workers cannot claim one
  // writable profile/ChatGPT target. Partial failures retain all locks.
  const names=resources.map(([type,value])=>digest(['bke/f1/fence',type,value])).sort();
  for(const name of names){
    let handle;
    try{
      handle=await open(join(dir,name+'.lock'),
        constants.O_CREAT|constants.O_EXCL|constants.O_WRONLY|constants.O_NOFOLLOW,0o600);
      await handle.writeFile(record);await handle.sync();
    }catch{BLOCK('FENCE_CONFLICT_OR_IO_UNCERTAIN');}
    finally{if(handle)await handle.close().catch(()=>{});}
  }
  // Ensure directory entries reach stable storage before reporting admitted.
  let d;try{d=await open(dir,constants.O_RDONLY|constants.O_NOFOLLOW);await d.sync();}
  catch{BLOCK('FENCE_DURABILITY_UNCERTAIN');}
  finally{if(d)await d.close().catch(()=>{});}
}
