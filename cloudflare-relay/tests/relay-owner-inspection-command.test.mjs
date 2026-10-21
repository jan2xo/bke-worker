import test from 'node:test';
import assert from 'node:assert/strict';
import {webcrypto} from 'node:crypto';
import {
  verifyOwnerInspectionCommand as verify,
  OWNER_INSPECTION_COMMAND_PURPOSE as PURPOSE,
} from '../src/relay-owner-inspection-command.js';

const DOMAIN = 'bke-worker/owner-inspection-command/v1';
const key = Uint8Array.from({length:32}, (_, i) => i + 17);
const keyB64 = Buffer.from(key).toString('base64url');
const now = 1800000001000;
const target = Object.freeze({
  worker_id:'android-worker-a',
  repo:'jan2xo/bke-worker',
  pr_number:90,
  expected_head_sha:'d80f5272e90677558fb1311a94772c8991f03b8f',
});
const env = Object.freeze({
  BKE_PREPRODUCTION:'true',
  BKE_G0_OWNER_INSPECTION_ENABLED:'true',
  BKE_G0_OWNER_INSPECTION_KEY_B64:keyB64,
});
const negative = {
  authority:'NONE',
  human_owner_authenticated:false,
  human_consent_verified:false,
  current_github_assignment_verified:false,
  same_do_verified:false,
  nonce_consumed:false,
  replay_protection_proven:false,
  read_permitted:false,
  can_retire:false,
  can_release_assignment:false,
  can_reuse_worker_id:false,
  delivery_fenced:false,
  delivery_ack_proven:false,
  credential_revocation_proven:false,
};
function checkNegative(result) {
  assert.ok(Object.isFrozen(result));
  for (const [name, value] of Object.entries(negative)) {
    assert.ok(Object.hasOwn(result,name),name);
    assert.equal(result[name],value,name);
  }
  assert.equal(JSON.stringify(result).includes(keyB64),false);
  assert.equal(Object.hasOwn(result,'signature'),false);
  assert.equal(Object.hasOwn(result,'nonce'),false);
}
function digestPayload(command) {
  return JSON.stringify([DOMAIN, 1, PURPOSE, command.worker_id, command.repo,
    command.pr_number, command.expected_head_sha, command.nonce,
    command.issued_at_ms, command.expires_at_ms]);
}
async function sign(command, signingKey = key, payload = digestPayload(command)) {
  const k = await webcrypto.subtle.importKey('raw', signingKey,
    {name:'HMAC',hash:'SHA-256'},false,['sign']);
  return Buffer.from(await webcrypto.subtle.sign(
    'HMAC',k,new TextEncoder().encode(payload))).toString('base64url');
}
async function command(partial = {}, signingKey = key, payload) {
  const c = {
    version:1,purpose:PURPOSE,...target,
    nonce:'a'.repeat(64),
    issued_at_ms:now-1000,expires_at_ms:now+29000,
    signature:'',
    ...partial,
  };
  c.signature = await sign(c, signingKey, payload ?? digestPayload(c));
  return c;
}
const inspect = (c, overrides = {}) => verify({
  env, command:c, expected:target, cryptoImpl:webcrypto,
  clock:()=>now, ...overrides,
});

test('cryptographically verified scoped envelope never grants owner or DO authority', async()=>{
  const r=await inspect(await command());
  assert.equal(r.state,'COMMAND_SIGNATURE_VERIFIED_ONLY');
  assert.equal(r.code,'OWNER_AUTH_GITHUB_AND_DO_PROVENANCE_REQUIRED');
  assert.equal(r.worker_id,target.worker_id);
  assert.equal(r.repo,target.repo);
  assert.equal(r.pr_number,target.pr_number);
  assert.equal(r.expected_head_sha,target.expected_head_sha);
  checkNegative(r);
});

test('exact opt-in and PREPRODUCTION-only flags fail closed', async()=>{
  const signed=await command();
  for(const replacement of [
    {}, {BKE_PREPRODUCTION:'false'},
    {BKE_G0_OWNER_INSPECTION_ENABLED:'false'},
    {BKE_G0_OWNER_INSPECTION_ENABLED:true},
    {BKE_PREPRODUCTION:true},
  ]){
    const next = Object.keys(replacement).length === 0 ? {} : {...env,...replacement};
    const r=await inspect(signed,{env:next});
    assert.equal(r.code,'OWNER_INSPECTION_LOCKED');
    checkNegative(r);
  }
});

test('signature cannot transfer to another worker, repo, PR or SHA', async()=>{
  const signed=await command();
  for(const changed of [
    {worker_id:'another-worker'},{repo:'jan2xo/bke-demo-app'},
    {pr_number:91},{expected_head_sha:'f'.repeat(40)},
  ]){
    const r=await inspect(signed,{expected:{...target,...changed}});
    assert.equal(r.code,'OWNER_INSPECTION_TARGET_MISMATCH');
    checkNegative(r);
  }
});

test('extra fake Admin authorization and client-supplied privilege fields reject', async()=>{
  const signed=await command();
  for(const extra of [
    {owner_approved:true},{authenticated:true},{can_retire:true},
    {admin_email:'fake@example.test'},{access_jwt:'SECRET_ACCESS'},
    {claimed_device_identity:'LEGACY'},
  ]){
    const r=await inspect({...signed,...extra});
    assert.equal(r.code,'OWNER_INSPECTION_COMMAND_INVALID');
    checkNegative(r);
  }
  for (const extra of [{owner_approved:true},{authority:'OWNER'},{nonce:signed.nonce}]){
    const r=await inspect(signed,{expected:{...target,...extra}});
    assert.equal(r.code,'OWNER_INSPECTION_COMMAND_INVALID');
    checkNegative(r);
  }
});

test('all omitted and invalid required signed-command fields reject before crypto', async()=>{
  const signed=await command();
  for(const name of Object.keys(signed)){
    const { [name]: omitted, ...short } = signed;
    const r=await inspect(short);
    assert.equal(r.code,'OWNER_INSPECTION_COMMAND_INVALID',name);
    checkNegative(r);
  }
  for(const c of [null,[],{},'bad',123]){
    const r=await inspect(c);
    assert.equal(r.code,'OWNER_INSPECTION_COMMAND_INVALID');
    checkNegative(r);
  }
});

test('bad purpose, version, nonce and target are not valid signed commands', async()=>{
  for(const patch of [
    {purpose:'retire_worker'},{purpose:'read_all_worker_sessions'},
    {version:2},{nonce:'Z'.repeat(64)},{nonce:'a'.repeat(63)},
    {worker_id:'INVALID'},{repo:'attacker/non-control'},
    {pr_number:0},{expected_head_sha:'not-a-sha'},
  ]){
    const r=await inspect(await command(patch));
    assert.equal(r.code,'OWNER_INSPECTION_COMMAND_INVALID',JSON.stringify(patch));
    checkNegative(r);
  }
});

test('tampering signed byte or signature always denies', async()=>{
  const signed=await command();
  for(const altered of [
    {...signed,issued_at_ms:signed.issued_at_ms+1},
    {...signed,nonce:'b'.repeat(64)},
    {...signed,signature:signed.signature.replace(/^./u, signed.signature[0]==='A'?'B':'A')},
    {...signed,signature:'A'.repeat(43)},
  ]){
    const r=await inspect(altered);
    assert.equal(r.code,'OWNER_INSPECTION_SIGNATURE_INVALID');
    checkNegative(r);
  }
});

test('domain-separated HMAC prevents cross-purpose signed payload reuse', async()=>{
  const original=await command();
  const reused=await command({},key,
    JSON.stringify(['bke-worker/old-pairing-v1',1,PURPOSE,
      original.worker_id,original.repo,original.pr_number,
      original.expected_head_sha,original.nonce,
      original.issued_at_ms,original.expires_at_ms]));
  const r=await inspect(reused);
  assert.equal(r.code,'OWNER_INSPECTION_SIGNATURE_INVALID');
  checkNegative(r);
});

test('wrong secret and noncanonical secret material fail closed', async()=>{
  const signed=await command();
  const wrong=Buffer.from(Uint8Array.from({length:32},()=>50)).toString('base64url');
  for(const bad of [undefined,'', ' ', 'secret', keyB64+'=', keyB64.slice(0,-1),
                     Buffer.from(new Uint8Array(31)).toString('base64url'),
                     Buffer.from(new Uint8Array(33)).toString('base64url')]){
    const e={...env,BKE_G0_OWNER_INSPECTION_KEY_B64:bad};
    const r=await inspect(signed,{env:e});
    assert.equal(r.code,'OWNER_INSPECTION_CRYPTO_UNCONFIGURED');
    checkNegative(r);
  }
  const r=await inspect(signed,{env:{...env,BKE_G0_OWNER_INSPECTION_KEY_B64:wrong}});
  assert.equal(r.code,'OWNER_INSPECTION_SIGNATURE_INVALID');
  checkNegative(r);
});

test('expired, future, overlong and malformed timestamp intervals deny', async()=>{
  const invalid=[
    {issued_at_ms:now-31000,expires_at_ms:now-1},
    {issued_at_ms:now+1,expires_at_ms:now+1000},
    {issued_at_ms:now-1,expires_at_ms:now},
    {issued_at_ms:now-1,expires_at_ms:now+30000},
    {issued_at_ms:0,expires_at_ms:now+1},
    {issued_at_ms:now,expires_at_ms:now},
    {issued_at_ms:now+'0',expires_at_ms:now+1},
    {issued_at_ms:NaN,expires_at_ms:now+1},
  ];
  for(const changed of invalid){
    const r=await inspect(await command(changed));
    assert.ok(['OWNER_INSPECTION_WINDOW_INVALID','OWNER_INSPECTION_EXPIRED_OR_FUTURE'].includes(r.code),r.code);
    checkNegative(r);
  }
});

test('broken clock and cryptographic verification never expose secret/error', async()=>{
  const signed=await command();
  const cases=[
    [{clock:()=>{throw Error('SECRET_ACCESS');}},'OWNER_INSPECTION_CLOCK_UNAVAILABLE'],
    [{clock:()=>NaN},'OWNER_INSPECTION_EXPIRED_OR_FUTURE'],
    [{cryptoImpl:{}},'OWNER_INSPECTION_CRYPTO_UNAVAILABLE'],
    [{cryptoImpl:{subtle:{importKey:async()=>{throw Error('SECRET_ACCESS');},verify:async()=>true}}},'OWNER_INSPECTION_CRYPTO_UNAVAILABLE'],
    [{cryptoImpl:{subtle:{importKey:async()=>({}),verify:async()=>{throw Error('SECRET_ACCESS');}}}},'OWNER_INSPECTION_CRYPTO_UNAVAILABLE'],
  ];
  for(const [options,code] of cases){
    const r=await inspect(signed,options);
    assert.equal(r.code,code);
    checkNegative(r);
    assert.equal(JSON.stringify(r).includes('SECRET_ACCESS'),false);
  }
});

test('repeat of signed read-only command has no replay/nonce consumption claim', async()=>{
  const signed=await command();
  const first=await inspect(signed);
  const again=await inspect(signed);
  for(const r of [first,again]){
    assert.equal(r.state,'COMMAND_SIGNATURE_VERIFIED_ONLY');
    assert.equal(r.nonce_consumed,false);
    assert.equal(r.replay_protection_proven,false);
    assert.equal(r.read_permitted,false);
    checkNegative(r);
  }
});

test('server expected context must itself be strict and deny caller metadata', async()=>{
  const signed=await command();
  for(const e of [
    {...target,pr_number:0},
    {...target,repo:'other/not-authorized'},
    {...target,expected_head_sha:'abcdef'},
    {...target,owner:true},
    {...target,worker_id:'UPPERCASE'},
  ]){
    const r=await inspect(signed,{expected:e});
    assert.equal(r.code,'OWNER_INSPECTION_COMMAND_INVALID');
    checkNegative(r);
  }
});

test('provider environment operations are never contacted by signature verification', async()=>{
  let calls=0;
  const instrumented={...env,
    WORKER_SESSIONS:{idFromName(){calls++},get(){calls++}},
    put(){calls++},fetch(){calls++},send(){calls++},
  };
  const r=await inspect(await command(),{env:instrumented});
  assert.equal(r.state,'COMMAND_SIGNATURE_VERIFIED_ONLY');
  assert.equal(calls,0);
  checkNegative(r);
});
