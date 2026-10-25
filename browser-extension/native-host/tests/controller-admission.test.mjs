import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash,generateKeyPairSync,sign} from 'node:crypto';
import {mkdtemp,rm,readdir,readFile,chmod,symlink,mkdir} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createControllerChallenge,controllerSignedPayload} from '../controller-admission.mjs';
import {deriveOwnerAttestedLocalPins} from '../owner-local-bindings.mjs';
const sha=x=>createHash('sha256').update(x).digest('hex');
const T=1_800_000_000_000;
function setup(){
 const {publicKey,privateKey}=generateKeyPairSync('ed25519');
 const principal={controller_id:'controller-a',public_key:publicKey.export({format:'jwk'})};
 const scope={worker_id:'worker-a',allowed_origin:'chrome-extension://'+'a'.repeat(32)+'/',
  profile_binding_sha256:sha('binding'),browser_profile_sha256:sha('profile'),
  chatgpt_target_sha256:sha('target'),bridge_identity_sha256:sha('bridge')};
 const params={scope,principal,clientNonce:sha('client'),serverNonce:sha('server'),
  clock:()=>T,nonce:()=>sha('fresh'),ttlMs:3000};
 const gate=()=>createControllerChallenge(params);
 const respond=(challenge,key=privateKey)=>{
  const frame={type:'CONTROLLER_AUTH_READ_ONLY',version:1,
   worker_id:challenge.worker_id,controller_id:principal.controller_id,
   profile_binding_sha256:challenge.profile_binding_sha256,
   browser_profile_sha256:challenge.browser_profile_sha256,
   chatgpt_target_sha256:challenge.chatgpt_target_sha256,
   bridge_identity_sha256:challenge.bridge_identity_sha256,
   client_nonce:challenge.client_nonce,server_nonce:challenge.server_nonce,
   challenge_nonce:challenge.challenge_nonce,issued_at_ms:challenge.issued_at_ms,
   expires_at_ms:challenge.expires_at_ms};
  return {...frame,signature:sign(null,Buffer.from(controllerSignedPayload(challenge,principal.controller_id)),key).toString('base64url')};
 };
 return {params,scope,principal,gate,respond};
}
async function privateDir(run){const dir=await mkdtemp(join(tmpdir(),'bke-f1-controller-'));await chmod(dir,0o700);try{return await run(dir);}finally{await rm(dir,{recursive:true,force:true});}}
test('independent Ed25519 principal verified, four persistent local reservation locks',async()=>privateDir(async dir=>{
 const f=setup(),g=f.gate(),v=await g.accept(f.respond(g.challenge),{fenceDir:dir});
 assert.equal(v.state,'CONTROLLER_AUTH_READ_ONLY');
 assert.equal(v.principal_authentication,'ED25519_SIGNATURE_VERIFIED');
 assert.equal(v.dispatch_authority,'NONE');assert.equal(v.message_send_authority,'NONE');
 assert.equal(v.github_assignment,'NOT_VERIFIED');
 const names=await readdir(dir);assert.equal(names.length,4);
 for(const name of names){const data=JSON.parse(await readFile(join(dir,name),'utf8'));
  assert.equal(data.state,'RESERVED_UNCERTAIN_NO_AUTOMATIC_RELEASE');
  assert.equal(data.controller_id,'controller-a');}
 await assert.rejects(g.accept(f.respond(g.challenge),{fenceDir:dir}),/REPLAY_OR_UNCERTAIN/);
 await assert.rejects(f.gate().accept(f.respond(g.challenge),{fenceDir:dir}),/FENCE_CONFLICT_OR_IO_UNCERTAIN/);
 assert.equal((await readdir(dir)).length,4);
}));
test('tampering, effectful commands and extra fields consume a challenge without fencing',async()=>privateDir(async dir=>{
 const changes=[
  x=>({...x,type:'SEND_CHATGPT_MESSAGE'}),x=>({...x,command:'send'}),
  x=>({...x,controller_id:'controller-b'}),x=>({...x,worker_id:'worker-b'}),
  x=>({...x,profile_binding_sha256:sha('other')}),
  x=>({...x,browser_profile_sha256:sha('other')}),
  x=>({...x,chatgpt_target_sha256:sha('other')}),
  x=>({...x,bridge_identity_sha256:sha('other')}),
  x=>({...x,client_nonce:sha('other')}),x=>({...x,server_nonce:sha('other')}),
  x=>({...x,challenge_nonce:sha('other')}),
  x=>({...x,expires_at_ms:x.expires_at_ms+1}),
  x=>({...x,issued_at_ms:x.issued_at_ms+1}),x=>({...x,signature:'A'.repeat(86)}),
  ()=>null,()=>[],x=>({...x,token:'bearer'}),
 ];
 for(const change of changes){const f=setup(),g=f.gate();
  await assert.rejects(g.accept(change(f.respond(g.challenge)),{fenceDir:dir}),/CONTROLLER_/);
  await assert.rejects(g.accept(f.respond(g.challenge),{fenceDir:dir}),/REPLAY_OR_UNCERTAIN/);
 }
 assert.deepEqual(await readdir(dir),[]);
}));
test('wrong signing key and key substitution reject without a lock',async()=>privateDir(async dir=>{
 const f=setup();const wrong=generateKeyPairSync('ed25519').privateKey;
 const g=f.gate();await assert.rejects(g.accept(f.respond(g.challenge,wrong),{fenceDir:dir}),/SIGNATURE_DENIED/);
 assert.deepEqual(await readdir(dir),[]);
}));
test('clock expiry, rollback, and missing clock fail closed',async()=>privateDir(async dir=>{
 const f=setup();let clock=T;const g=createControllerChallenge({...f.params,clock:()=>clock});
 clock=T+3000;
 await assert.rejects(g.accept(f.respond(g.challenge),{fenceDir:dir}),/EXPIRED_OR_CLOCK_REWOUND/);
 const j=createControllerChallenge({...f.params,clock:()=>clock,nonce:()=>sha('other')});
 clock=T;
 await assert.rejects(j.accept(f.respond(j.challenge),{fenceDir:dir}),/EXPIRED_OR_CLOCK_REWOUND/);
 assert.deepEqual(await readdir(dir),[]);
}));
test('transport cancellation during asynchronous controller fencing denies positive receipt and retains locks',async()=>privateDir(async dir=>{
 const f=setup(),g=f.gate();
 const pending=g.accept(f.respond(g.challenge),{fenceDir:dir});
 // accept() has validated the signature and entered awaited fence I/O.
 // This simulates a transport deadline/connection close on that same tick.
 g.close();
 await assert.rejects(pending,/CONTROLLER_SESSION_CLOSED_UNCERTAIN/);
 assert.equal((await readdir(dir)).length,4);
 for(const name of await readdir(dir)){
  const record=JSON.parse(await readFile(join(dir,name),'utf8'));
  assert.equal(record.state,'RESERVED_UNCERTAIN_NO_AUTOMATIC_RELEASE');
 }
 await assert.rejects(g.accept(f.respond(g.challenge),{fenceDir:dir}),/REPLAY_OR_UNCERTAIN/);
}));
test('expiry or clock failure during durable fencing never reports admission, locks remain',async()=>privateDir(async dir=>{
 const f=setup();
 for(const mode of ['expired','rewound','invalid']){
  const inner=join(dir,mode);await mkdir(inner,{mode:0o700});
  let calls=0;
  const g=createControllerChallenge({...f.params,clock:()=>{
   calls++;
   if(calls<=2)return T;
   if(mode==='expired')return T+3000;
   if(mode==='rewound')return T-1;
   throw Error('clock unavailable');
  }});
  await assert.rejects(g.accept(f.respond(g.challenge),{fenceDir:inner}),
   /EXPIRED_OR_CLOCK_REWOUND|CLOCK_INVALID/);
  assert.equal((await readdir(inner)).length,4);
  await assert.rejects(g.accept(f.respond(g.challenge),{fenceDir:inner}),
   /REPLAY_OR_UNCERTAIN/);
 }
}));
test('mutated caller scope cannot redirect signed challenge into different resource fences',async()=>privateDir(async dir=>{
 const f=setup(),g=f.gate();
 const signedOriginal=f.respond(g.challenge);
 // The signature covers target A. Mutating the caller-owned scope then
 // claiming target B in the envelope must not allow fencing/admission for B.
 const originalTarget=g.challenge.chatgpt_target_sha256;
 f.scope.chatgpt_target_sha256=sha('substituted target after challenge');
 assert.equal(g.challenge.chatgpt_target_sha256,originalTarget);
 const changedFrame={...signedOriginal,chatgpt_target_sha256:f.scope.chatgpt_target_sha256};
 await assert.rejects(g.accept(changedFrame,{fenceDir:dir}),/CONTROLLER_ENVELOPE_DENIED/);
 assert.deepEqual(await readdir(dir),[]);
 await assert.rejects(g.accept(signedOriginal,{fenceDir:dir}),/REPLAY_OR_UNCERTAIN/);

 // A legitimate signed response still binds the ORIGINAL challenge and
 // original persistent resource locks, not any subsequently mutated input.
 const second=setup(),valid=second.gate();
 const original=valid.challenge.chatgpt_target_sha256;
 const authentic=second.respond(valid.challenge);
 second.scope.chatgpt_target_sha256=sha('unreviewed new target');
 const receipt=await valid.accept(authentic,{fenceDir:dir});
 assert.equal(receipt.state,'CONTROLLER_AUTH_READ_ONLY');
 const records=(await readdir(dir)).map(x=>x);
 assert.equal(records.length,4);
 const expectedName=sha(JSON.stringify(['bke/f1/fence','target',original]))+'.lock';
 assert.ok(records.includes(expectedName));
 const substitutedName=sha(JSON.stringify(['bke/f1/fence','target',second.scope.chatgpt_target_sha256]))+'.lock';
 assert.ok(!records.includes(substitutedName));
}));
test('unreviewed principal, malformed scope, weak nonces rejected',()=>{
 const f=setup();
 for(const patch of [
  {principal:{...f.principal,public_key:{...f.principal.public_key,x:'A'.repeat(43)}}},
  {principal:{...f.principal,public_key:{...f.principal.public_key,crv:'X25519'}}},
  {principal:{...f.principal,controller_id:'x/y'}},
  {scope:{...f.scope,worker_id:'../..'}},
  {scope:{...f.scope,allowed_origin:'https://chatgpt.com'}},
  {scope:{...f.scope,chatgpt_target_sha256:f.scope.browser_profile_sha256}},
  {scope:{...f.scope,secret:'bad'}},
  {clientNonce:f.params.serverNonce},
  {nonce:()=>f.params.clientNonce},
  {ttlMs:6000},
  {clock:()=>NaN},
 ])assert.throws(()=>createControllerChallenge({...f.params,...patch}),/CONTROLLER_/);
});
test('nonprivate root and symlinked fence root rejected after valid signature',async()=>privateDir(async dir=>{
 const unsafe=join(dir,'unsafe');await mkdir(unsafe,{mode:0o777});
 await chmod(unsafe,0o777);
 const link=join(dir,'link');await symlink(unsafe,link);
 for(const root of [unsafe,link,join(dir,'missing'),'/tmp']){
  const f=setup(),g=f.gate();
  await assert.rejects(g.accept(f.respond(g.challenge),{fenceDir:root}),/FENCE_ROOT_DENIED/);
 }
}));
test('concurrent controller claims for identical target never both succeed',async()=>privateDir(async dir=>{
 const f=setup();const a=f.gate(),b=createControllerChallenge({...f.params,nonce:()=>sha('next')});
 const results=await Promise.allSettled([
  a.accept(f.respond(a.challenge),{fenceDir:dir}),
  b.accept(f.respond(b.challenge),{fenceDir:dir}),
 ]);
 assert.equal(results.filter(x=>x.status==='fulfilled').length,1);
 assert.equal(results.filter(x=>x.status==='rejected').length,1);
 assert.equal((await readdir(dir)).length,4);
}));
test('two distinct worker identities with the SAME owner Chrome profile cannot both reserve',async()=>privateDir(async dir=>{
 const physical="/Users/operator/.bke-worker/f1/chrome-profile";
 const origin="abcdefghijklmnopabcdefghijklmnop";
 const make=(worker_id,public_key_sha256,extension_id=origin)=>{
  const pins=deriveOwnerAttestedLocalPins({worker_id,extension_id,
   public_key_sha256,profile_path:physical,
   chrome_runtime_sha256:sha('same signed Chrome process'),
   verified_process_profile:true,
   owner_attested_single_idle_chatgpt_tab:true}).input;
  return {worker_id:pins.worker_id,allowed_origin:pins.allowed_origin,
   profile_binding_sha256:pins.profile_binding_sha256,
   browser_profile_sha256:pins.browser_profile_sha256,
   chatgpt_target_sha256:pins.chatgpt_target_sha256,
   bridge_identity_sha256:pins.bridge_identity_sha256};
 };
 const first=setup(),second=setup();
 first.params.scope=make('worker-a',sha('worker a p256'));
 second.params.scope=make('worker-b',sha('worker b p256'),
   'bcdefghijklmnopabcdefghijklmnopa');
 assert.notEqual(first.params.scope.profile_binding_sha256,
   second.params.scope.profile_binding_sha256);
 assert.equal(first.params.scope.browser_profile_sha256,
   second.params.scope.browser_profile_sha256);
 const a=first.gate(),b=second.gate();
 assert.equal((await a.accept(first.respond(a.challenge),{fenceDir:dir})).state,
   'CONTROLLER_AUTH_READ_ONLY');
 await assert.rejects(b.accept(second.respond(b.challenge),{fenceDir:dir}),
   /FENCE_CONFLICT_OR_IO_UNCERTAIN/);
 assert.equal((await readdir(dir)).length,4);
}));
test('profile or target collision between different workers is locked, crash no automatic takeover',async()=>privateDir(async dir=>{
 const f=setup(),g=f.gate();await g.accept(f.respond(g.challenge),{fenceDir:dir});
 for(const collision of ['browser_profile_sha256','chatgpt_target_sha256']){
  const other=setup();other.params.scope={...other.scope,worker_id:'worker-b',
   [collision]:f.scope[collision],bridge_identity_sha256:sha('other bridge'),
   profile_binding_sha256:sha('other binding')};
  const attempt=other.gate();
  await assert.rejects(attempt.accept(other.respond(attempt.challenge),{fenceDir:dir}),/FENCE_CONFLICT_OR_IO_UNCERTAIN/);
 }
}));
