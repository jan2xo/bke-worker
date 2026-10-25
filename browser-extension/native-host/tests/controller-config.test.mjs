import test from 'node:test';
import assert from 'node:assert/strict';
import {generateKeyPairSync,createHash} from 'node:crypto';
import {mkdtemp,writeFile,chmod,rm,symlink} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {validateReviewedControllerConfig,readPinnedControllerConfig,controllerConfigDigest,ownerGlobalFenceDir} from '../controller-config.mjs';
const H=x=>createHash('sha256').update(x).digest('hex');
const T=1_800_000_000_000;
const origin='chrome-extension://'+'a'.repeat(32)+'/';
function f(){
 const key=generateKeyPairSync('ed25519').publicKey.export({format:'jwk'});
 const policy={version:1,allowed_origin:origin,worker_id:'worker-a',
  public_key_sha256:H('p256'),profile_binding_sha256:H('binding'),
  resources:{browser_profile_sha256:H('profile'),chatgpt_target_sha256:H('target'),
   bridge_identity_sha256:H('bridge')},expires_at_ms:T+60000};
 const config={version:1,enabled:true,worker_id:policy.worker_id,
  allowed_origin:policy.allowed_origin,profile_binding_sha256:policy.profile_binding_sha256,
  resources:{...policy.resources},controller_id:'controller-a',public_key:key,
  socket_path:'/var/private/bke-controller.sock',fence_dir:ownerGlobalFenceDir()};
 return {policy,config};
}
async function withDir(run){
 const dir=await mkdtemp(join(tmpdir(),'bke-ctrl-policy-'));await chmod(dir,0o700);
 try{return await run(dir);}finally{await rm(dir,{recursive:true,force:true});}
}
test('owner-pinned matching key is distinct from local P256 and authorizes read-only options only',()=>{
 const {policy,config}=f();
 const x=validateReviewedControllerConfig(config,policy,T);
 assert.deepEqual(Object.keys(x).sort(),['fenceDir','principal','socketPath']);
 assert.equal(x.principal.controller_id,'controller-a');
 assert.equal('dispatch' in x,false);
 assert.equal(validateReviewedControllerConfig({version:1,enabled:false},policy,T),null);
});
test('cannot elevate a public controller key by mutating pins, identity, permissions or type',()=>{
 const {policy,config}=f();
 for(const change of [
  x=>({...x,worker_id:'worker-b'}),x=>({...x,allowed_origin:'chrome-extension://'+'b'.repeat(32)+'/'}),
  x=>({...x,profile_binding_sha256:H('other')}),
  x=>({...x,resources:{...x.resources,chatgpt_target_sha256:H('other')}}),
  x=>({...x,resources:{...x.resources,bridge_identity_sha256:H('other')}}),
  x=>({...x,public_key:{...x.public_key,crv:'X25519'}}),
  x=>({...x,controller_id:'../escape'}),x=>({...x,token:'secret'}),
  x=>({...x,dispatch_authority:'ACTIVE'}),x=>({...x,socket_path:'/tmp/../untrusted'}),
  x=>({...x,fence_dir:'relative'}),x=>({...x,fence_dir:'/var/private/isolated-worker-fences'}),
  x=>({...x,enabled:false}),
  x=>({...x,resources:{...x.resources,secret:'x'}}),
 ]){
  assert.throws(()=>validateReviewedControllerConfig(change(config),policy,T),/CONTROLLER_CONFIG_/);
 }
 assert.throws(()=>validateReviewedControllerConfig(config,{...policy,expires_at_ms:T-1},T),/POLICY_DENIED/);
});
test('file bytes are pinned, private and non-symlinked before principal is usable',()=>withDir(async dir=>{
 const {policy,config}=f(),path=join(dir,'controller.json');
 const bytes=Buffer.from(JSON.stringify(config)+'\n');
 await writeFile(path,bytes,{mode:0o600});
 const result=await readPinnedControllerConfig({path,expectedSha256:controllerConfigDigest(bytes),policy,now:T});
 assert.equal(result.principal.controller_id,'controller-a');
 await assert.rejects(readPinnedControllerConfig({path,expectedSha256:H('wrong'),policy,now:T}),/INTEGRITY_DENIED/);
 await chmod(path,0o644);
 await assert.rejects(readPinnedControllerConfig({path,expectedSha256:controllerConfigDigest(bytes),policy,now:T}),/INTEGRITY_DENIED/);
}));
test('invalid parent, symlink, malicious JSON, and overlarge file refuse',()=>withDir(async dir=>{
 const {policy,config}=f(),file=join(dir,'controller.json');
 const bytes=Buffer.from(JSON.stringify(config));
 await writeFile(file,bytes,{mode:0o600});
 await symlink(file,join(dir,'alias'));
 await assert.rejects(readPinnedControllerConfig({path:join(dir,'alias'),expectedSha256:controllerConfigDigest(bytes),policy,now:T}),/INTEGRITY_DENIED/);
 await chmod(dir,0o755);
 await assert.rejects(readPinnedControllerConfig({path:file,expectedSha256:controllerConfigDigest(bytes),policy,now:T}),/PARENT_DENIED/);
 await chmod(dir,0o700);
 await writeFile(file,'{broken',{mode:0o600});
 await assert.rejects(readPinnedControllerConfig({path:file,expectedSha256:controllerConfigDigest(Buffer.from('{broken')),policy,now:T}),/INTEGRITY_DENIED/);
 await writeFile(file,'X'.repeat(4100));
 await assert.rejects(readPinnedControllerConfig({path:file,expectedSha256:controllerConfigDigest(Buffer.from('X'.repeat(4100))),policy,now:T}),/INTEGRITY_DENIED/);
}));

test('different worker configs cannot split shared local exclusion into distinct fence roots',()=>{
 const first=f(),second=f();
 second.policy.worker_id='worker-b';
 second.config.worker_id='worker-b';
 second.config.controller_id='controller-b';
 const shared=ownerGlobalFenceDir();
 assert.equal(validateReviewedControllerConfig(first.config,first.policy,T).fenceDir,shared);
 assert.equal(validateReviewedControllerConfig(second.config,second.policy,T).fenceDir,shared);
 for(const c of [
  {...first.config,fence_dir:shared+'/worker-a'},
  {...second.config,fence_dir:shared+'/worker-b'},
 ]){
  const policy=c.worker_id==='worker-a'?first.policy:second.policy;
  assert.throws(()=>validateReviewedControllerConfig(c,policy,T),/SCOPE_OR_PRINCIPAL_DENIED/);
 }
});
