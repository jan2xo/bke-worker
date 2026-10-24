import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash,generateKeyPairSync,sign} from 'node:crypto';
import {mkdtemp,rm,readdir,readFile,chmod,symlink,mkdir} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createControllerChallenge,controllerSignedPayload} from '../controller-admission.mjs';
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
