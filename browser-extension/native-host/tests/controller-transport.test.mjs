import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash,generateKeyPairSync,sign} from 'node:crypto';
import {createServer} from 'node:net';
import {mkdtemp,rm,mkdir,chmod,readdir} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {once} from 'node:events';
import {authenticatedReadOnlyControllerTransport} from '../controller-transport.mjs';
import {controllerSignedPayload} from '../controller-admission.mjs';
import {nativeFrameReader,writeFrame} from '../framing.mjs';
const H=x=>createHash('sha256').update(x).digest('hex');
function fixture(){
 const {publicKey,privateKey}=generateKeyPairSync('ed25519');
 const principal={controller_id:'owner-controller',public_key:publicKey.export({format:'jwk'})};
 const scope={allowed_origin:'chrome-extension://'+'a'.repeat(32)+'/',worker_id:'worker-a',
  profile_binding_sha256:H('local'),bridge_identity_sha256:H('bridge'),
  browser_profile_sha256:H('profile'),chatgpt_target_sha256:H('target')};
 return {principal,scope,privateKey,clientNonce:H('client'),serverNonce:H('server')};
}
function signed(challenge,key){return {
 type:'CONTROLLER_AUTH_READ_ONLY',version:1,controller_id:'owner-controller',
 worker_id:challenge.worker_id,profile_binding_sha256:challenge.profile_binding_sha256,
 browser_profile_sha256:challenge.browser_profile_sha256,
 chatgpt_target_sha256:challenge.chatgpt_target_sha256,
 bridge_identity_sha256:challenge.bridge_identity_sha256,
 client_nonce:challenge.client_nonce,server_nonce:challenge.server_nonce,
 challenge_nonce:challenge.challenge_nonce,issued_at_ms:challenge.issued_at_ms,
 expires_at_ms:challenge.expires_at_ms,
 signature:sign(null,Buffer.from(controllerSignedPayload(challenge,'owner-controller')),key).toString('base64url')
};}
async function harness(change,run){
 const root=await mkdtemp(join(tmpdir(),'bke-transport-'));await chmod(root,0o700);
 const fenceDir=join(root,'fences');await mkdir(fenceDir,{mode:0o700});
 const socketPath=join(root,'controller.sock');
 const f=fixture();
 const server=createServer(async socket=>{
  try{
   const read=nativeFrameReader(socket,4096);const challenge=await read.next();
   const reply=change(signed(challenge,f.privateKey));
   if(reply!==null)await writeFrame(socket,reply);
   socket.end();
  }catch{socket.destroy();}
 });
 try{
  server.listen(socketPath);await once(server,'listening');
  return await run({...f,root,fenceDir,socketPath});
 }finally{server.close();await new Promise(resolve=>server.once('close',resolve));await rm(root,{recursive:true,force:true});}
}
test('real Unix socket authenticates an external key, grants read-only only, then fences forever',()=>harness(x=>x,async p=>{
 const x=await authenticatedReadOnlyControllerTransport({...p,timeoutMs:1800});
 assert.equal(x.state,'CONTROLLER_AUTH_READ_ONLY');
 assert.equal(x.principal_authentication,'ED25519_SIGNATURE_VERIFIED');
 assert.equal(x.dispatch_authority,'NONE');
 assert.equal((await readdir(p.fenceDir)).length,4);
 await assert.rejects(authenticatedReadOnlyControllerTransport({...p,timeoutMs:1800}),/FENCE_CONFLICT_OR_IO_UNCERTAIN/);
}));
test('tampered controller command or substituted worker is rejected without any grant',async()=>{
 for(const change of [x=>({...x,type:'SEND_CHATGPT_MESSAGE'}),x=>({...x,worker_id:'worker-b'}),
   x=>({...x,signature:'A'.repeat(86)}),x=>({...x,dispatch_authority:'ACTIVE'})]){
  await harness(change,async p=>{
   await assert.rejects(authenticatedReadOnlyControllerTransport({...p,timeoutMs:1800}),/CONTROLLER_/);
   assert.equal((await readdir(p.fenceDir)).length,0);
  });
 }
});
test('missing response, wrong socket, world-readable parent and replayed identity deny',async()=>{
 await harness(()=>null,async p=>{
  await assert.rejects(authenticatedReadOnlyControllerTransport({...p,timeoutMs:200}),/CONTROLLER_|NATIVE_/);
  await assert.rejects(authenticatedReadOnlyControllerTransport({...p,socketPath:join(p.root,'absent.sock')}),/CONTROLLER_SOCKET_DENIED/);
  await chmod(p.root,0o755);
  await assert.rejects(authenticatedReadOnlyControllerTransport({...p}),/CONTROLLER_SOCKET_DENIED/);
 });
});
