import test from 'node:test';
import assert from 'node:assert/strict';
import {webcrypto} from 'node:crypto';
import {relayLeaseV2Message,relayWssProofV2Message,verifyGeckoRelayPresentationV2 as verify} from '../src/relay-credential-v2.js';
const crypto = webcrypto;
const encoder = new TextEncoder();
const b64 = bytes => Buffer.from(bytes).toString('base64url');
const hex = bytes => Buffer.from(bytes).toString('hex');
const worker = 'android-worker-a', now = 1_800_000_000_000;
async function fixture() {
  const keypair = await crypto.subtle.generateKey({name:'ECDSA',namedCurve:'P-256'},true,['sign','verify']);
  const jwkfull = await crypto.subtle.exportKey('jwk',keypair.publicKey);
  const jwk = {kty:'EC',crv:'P-256',x:jwkfull.x,y:jwkfull.y};
  const hash = hex(await crypto.subtle.digest('SHA-256',encoder.encode(JSON.stringify(['EC','P-256',jwk.x,jwk.y]))));
  const serverKey = crypto.getRandomValues(new Uint8Array(32));
  const lease = {v:2,installation_id:'123',worker_id:worker,device_key_sha256:hash,
    session_binding_sha256:'a'.repeat(64),epoch:7,token_id:b64(crypto.getRandomValues(new Uint8Array(16))),
    issued_at_ms:now-1_000,expires_at_ms:now+60_000};
  const macKey = await crypto.subtle.importKey('raw',serverKey,{name:'HMAC',hash:'SHA-256'},false,['sign']);
  const tag = b64(await crypto.subtle.sign('HMAC',macKey,encoder.encode(relayLeaseV2Message(lease))));
  const proof = {v:1,nonce:b64(crypto.getRandomValues(new Uint8Array(32))),method:'GET',path:'/relay/'+worker,signature:''};
  const signProof = async (p=proof,l=lease,t=tag) => b64(await crypto.subtle.sign({name:'ECDSA',hash:'SHA-256'},keypair.privateKey,encoder.encode(relayWssProofV2Message(p,l,t))));
  proof.signature=await signProof();
  const expected={epoch:7,installation_id:'123',session_binding_sha256:'a'.repeat(64),worker_id:worker};
  return {args:{credential:{lease,tag},proof,expected,serverKey,pinnedDeviceJwk:jwk,now:()=>now,cryptoImpl:crypto},signProof};
}
const blocked = x => {assert.equal(x.state,'BLOCKED');assert.equal(x.authority,'NONE');};
test('real P-256 proof + HMAC verifies cryptographically but grants no authority',async()=>{
  const {args}=await fixture();
  const r=await verify(args);
  assert.deepEqual(r,{state:'CRYPTO_VERIFIED_ONLY',authority:'NONE',nonce_authority:'NOT_CHECKED',paired_device_authority:'NOT_CHECKED',relay_connection_authority:'NONE',renewal_authority:'NONE'});
  assert.deepEqual(await verify(args),r,'unchanged nonce has no consume/replay authority in this module');
});
test('default missing trusted server proof and unsafe key sizes deny before crypto',async()=>{
  const {args}=await fixture();
  blocked(await verify({}));blocked(await verify({...args,serverKey:Uint8Array.of(1)}));
  blocked(await verify({...args,pinnedDeviceJwk:{...args.pinnedDeviceJwk,d:'secret'}}));
});
test('reject cross-worker, installation, session and old/future key epochs',async()=>{
  const {args}=await fixture();
  for (const patch of [{worker_id:'android-worker-b'},{installation_id:'456'},
    {session_binding_sha256:'b'.repeat(64)},{epoch:8},{epoch:6}]) {
    const r=await verify({...args,expected:{...args.expected,...patch}});blocked(r);
    assert.equal(r.code,'V2_CREDENTIAL_SCOPE_MISMATCH');
  }
});
test('reject expired, future and noninteger or out-of-range clocks',async()=>{
  const {args}=await fixture();
  for(const t of [args.credential.lease.expires_at_ms,args.credential.lease.issued_at_ms-1,0,NaN,Infinity,123.5]) {
    const r=await verify({...args,now:()=>t});blocked(r);
  }
  blocked(await verify({...args,now:()=>{throw Error('private clock');}}));
});
test('reject malformed token schemas, long expiry and altered MAC',async()=>{
  const {args}=await fixture();
  for(const lease of [{...args.credential.lease,expires_at_ms:now+600_000},
    {...args.credential.lease,token_id:'n'},
    {...args.credential.lease,unexpected:'credential'},
    {...args.credential.lease,epoch:0}]) {
    blocked(await verify({...args,credential:{...args.credential,lease}}));
  }
  blocked(await verify({...args,credential:{...args.credential,tag:'Z'.repeat(43)}}));
  blocked(await verify({...args,credential:{...args.credential,unknown:'flag'}}));
});
test('reject valid lease but wrong pinned P-256 device and forged public key',async()=>{
  const {args}=await fixture();
  const other=await fixture();
  assert.equal((await verify({...args,pinnedDeviceJwk:other.args.pinnedDeviceJwk})).code,'V2_DEVICE_KEY_MISMATCH');
  blocked(await verify({...args,pinnedDeviceJwk:{...args.pinnedDeviceJwk,y:'~'.repeat(43)}}));
});
test('reject mutated proof nonce, wrong path, method, signature and extra fields',async()=>{
  const {args}=await fixture();
  for (const patch of [{nonce:'Z'.repeat(43)},{path:'/relay/android-worker-b'},
    {method:'POST'},{signature:'Z'.repeat(86)},{extra:'yes'}]) {
    blocked(await verify({...args,proof:{...args.proof,...patch}}));
  }
});
test('signer cannot reuse valid device proof against a separately signed token ID',async()=>{
  const {args}=await fixture();
  const second=await fixture();
  blocked(await verify({...args,credential:second.args.credential}));
});
test('literal legacy v1 bearer is never accepted as v2 credential',async()=>{
  const {args}=await fixture();
  blocked(await verify({...args,credential:'Bearer '+args.credential.tag}));
});

test('reject numerically coerced installation identities and extra untrusted fields',async()=>{
  const {args}=await fixture();
  blocked(await verify({...args,expected:{...args.expected,installation_id:123}}));
  blocked(await verify({...args,credential:{...args.credential,lease:{...args.credential.lease,installation_id:123}}}));
  blocked(await verify({...args,expected:{...args.expected,verified:true}}));
});
