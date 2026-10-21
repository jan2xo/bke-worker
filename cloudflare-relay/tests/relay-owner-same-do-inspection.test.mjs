import test from 'node:test';
import assert from 'node:assert/strict';
import {webcrypto} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import {inspectSameDurableObjectCandidate as inspect} from '../src/relay-owner-same-do-inspection.js';

const KEY=Uint8Array.from({length:32},(_,i)=>i+21);
const keyB64=Buffer.from(KEY).toString('base64url');
const NOW=1800000001000;
const target=Object.freeze({
  worker_id:'android-worker-a',repo:'jan2xo/bke-worker',pr_number:90,
  expected_head_sha:'d80f5272e90677558fb1311a94772c8991f03b8f',
});
const nonce='b'.repeat(64);
const wake={
  protocol:1,type:'wake',...target,
  reason:'github_pull_request_continuation',
  delivery_id:'161779c0-cc60-11f1-9ea6-31208570a69a',
};
const state={
  worker_id:target.worker_id,active_wake:{wake,phase:'queued'},queued_wake:wake,
  active_connection_id:'PRIVATE_SOCKET_ID',
  recent_deliveries:[wake.delivery_id],
};
const env={
  BKE_PREPRODUCTION:'true',BKE_G0_OWNER_INSPECTION_ENABLED:'true',
  BKE_G0_SAME_DO_RECEIVER_ENABLED:'true',BKE_G0_OWNER_INSPECTION_KEY_B64:keyB64,
};
async function signedCommand(overrides={}) {
  const command={
    version:1,purpose:'read_retirement_witness_v1',...target,
    nonce,issued_at_ms:NOW-1000,expires_at_ms:NOW+29000,...overrides,
  };
  const encoded=JSON.stringify([
    'bke-worker/owner-inspection-command/v1',1,'read_retirement_witness_v1',
    command.worker_id,command.repo,command.pr_number,command.expected_head_sha,
    command.nonce,command.issued_at_ms,command.expires_at_ms,
  ]);
  const key=await webcrypto.subtle.importKey('raw',KEY,
    {name:'HMAC',hash:'SHA-256'},false,['sign']);
  command.signature=Buffer.from(await webcrypto.subtle.sign(
    'HMAC',key,new TextEncoder().encode(encoded))).toString('base64url');
  return command;
}
function makeData(data=state,{mutate=()=>{},failKey=null}={}) {
  let reads=0,writes=0;
  const storage={
    async get(k) {
      reads++;
      mutate(k,reads,data);
      if(k===failKey)throw Error('PRIVATE_TOKEN');
      return data[k];
    },
    async put(){writes++;throw Error('NO_WRITES');},
    async delete(){writes++;throw Error('NO_DELETES');},
    async transaction(){writes++;throw Error('NO_TRANSACTIONS');},
  };
  const socket={
    deserializeAttachment(){return {
      workerId:target.worker_id,connectionId:'PRIVATE_SOCKET_ID',
      registered:true,sessionId:'PRIVATE_CHAT_SESSION',
    }},
    send(){writes++;},close(){writes++;},
  };
  return {storage,getWebSockets:()=>[socket],stats:()=>({reads,writes})};
}
const call=async (command,options={})=>{
  const d=options.deps||makeData();
  return inspect({env,command,storage:d.storage,
    getWebSockets:d.getWebSockets,cryptoImpl:webcrypto,clock:()=>NOW,
    ...options,});
};
function deny(r) {
  assert.ok(Object.isFrozen(r));
  const negative={authority:'NONE',human_owner_authenticated:false,
    human_consent_verified:false,current_github_assignment_verified:false,
    same_do_verified:false,nonce_consumed:false,replay_protection_proven:false,
    read_permitted:false,can_retire:false,can_release_assignment:false,
    delivery_fenced:false,credential_revocation_proven:false,snapshot_atomic:false};
  for (const [k,v] of Object.entries(negative)) assert.equal(r[k],v,k);
  const asJson=JSON.stringify(r);
  for (const secret of ['PRIVATE_SOCKET_ID','PRIVATE_CHAT_SESSION','PRIVATE_TOKEN',keyB64,nonce]) {
    assert.ok(!asJson.includes(secret),'leaked '+secret);
  }
}

test('gated same-DO candidate is redacted and explicitly never owner/retirement authority',async()=>{
  const deps=makeData();
  const r=await call(await signedCommand(),{deps});
  assert.equal(r.state,'INSPECTION_CANDIDATE_ONLY');
  assert.equal(r.worker_id,target.worker_id);
  assert.equal(r.active_wake_present,true);
  assert.equal(r.queued_wake_present,true);
  assert.equal(r.registered_socket_id_match_observed,true);
  assert.equal(deps.stats().writes,0);
  deny(r);
});

test('default-OFF and wrong flag types never inspect storage or sockets',async()=>{
  const command=await signedCommand();
  for(const replacement of [{},{BKE_PREPRODUCTION:'false'},
    {BKE_G0_OWNER_INSPECTION_ENABLED:false},
    {BKE_G0_SAME_DO_RECEIVER_ENABLED:'false'},
    {BKE_G0_SAME_DO_RECEIVER_ENABLED:true}]){
    let touched=0;
    const e=Object.keys(replacement).length?{...env,...replacement}:{};
    const r=await call(command,{env:e,deps:{
      storage:{get(){touched++;throw Error('NOPE')}},
      getWebSockets(){touched++;throw Error('NOPE')},
    }});
    assert.equal(r.code,'SAME_DO_RECEIVER_LOCKED');
    assert.equal(touched,0);deny(r);
  }
});

test('invalid / untrusted ctx provider blocks without touching storage writes',async()=>{
  for(const options of [{storage:null,getWebSockets:()=>[]},
    {storage:{},getWebSockets:()=>[]},
    {storage:{get(){}},getWebSockets:null}]){
    const r=await call(await signedCommand(),options);
    assert.equal(r.code,'SAME_DO_CONTEXT_INVALID');deny(r);
  }
});

test('storage error after successful signature verification remains redacted',async()=>{
  const r=await call(await signedCommand(),{deps:makeData(state,{failKey:'worker_id'})});
  assert.equal(r.code,'SAME_DO_IDENTITY_READ_FAILED');deny(r);
});

test('persisted worker ID must be present and exact, no implicit creation',async()=>{
  for(const worker_id of [undefined,null,'other-worker',123]){
    const r=await call(await signedCommand(),{deps:makeData({...state,worker_id})});
    assert.equal(r.state,'BLOCKED');deny(r);
  }
});

test('wrong or conflicting persisted wake context refuses before trust',async()=>{
  for(const data of [
    {...state,active_wake:undefined,queued_wake:undefined},
    {...state,active_wake:{...state.active_wake,wake:{...wake,pr_number:91}}},
    {...state,queued_wake:{...wake,expected_head_sha:'f'.repeat(40)}},
    {...state,active_wake:{...state.active_wake,phase:19}},
    {...state,queued_wake:{...wake,worker_id:'other-worker'}},
    {...state,active_wake:{...state.active_wake,owner_approved:true}},
  ]){
    const r=await call(await signedCommand(),{deps:makeData(data)});
    assert.equal(r.code,'SAME_DO_PERSISTED_TARGET_AMBIGUOUS');deny(r);
  }
});

test('signed caller target cannot override actual persisted worker/PR/head',async()=>{
  const mismatches=[{worker_id:'another-worker'},{pr_number:91},
    {expected_head_sha:'f'.repeat(40)},{repo:'jan2xo/bke-demo-app'}];
  for(const change of mismatches){
    const r=await call(await signedCommand(change));
    assert.equal(r.code,'SAME_DO_PERSISTED_TARGET_MISMATCH');deny(r);
  }
});

test('missing, malformed and bad MAC must perform ZERO persisted reads or socket samples',async()=>{
  const signed=await signedCommand();
  const cases=[
    undefined, null, {}, {worker_id:target.worker_id},
    {...signed,signature:'A'.repeat(43)},
    {...signed,signature:'not-a-base64url-signature'},
    {...signed,nonce:'c'.repeat(64)},
    {...signed,issued_at_ms:NOW+1},
    {...signed,purpose:'retire_worker'},
    {...signed,owner_approved:true},
  ];
  for(const stored of [structuredClone(state), {worker_id:target.worker_id}, {}]){
    for(const command of cases){
      let reads=0,samples=0,writes=0;
      const deps={
        storage:{
          async get(){reads++;return stored.worker_id;},
          async put(){writes++;throw Error('NO_WRITE');},
          async delete(){writes++;throw Error('NO_DELETE');},
          async transaction(){writes++;throw Error('NO_TRANSACTION');},
        },
        getWebSockets(){samples++;throw Error('NO_SOCKET_SAMPLE');},
      };
      const result=await call(command,{deps});
      assert.equal(result.code,'SAME_DO_SIGNATURE_OR_SCOPE_DENIED');
      assert.equal(reads,0,'pre-HMAC storage access');
      assert.equal(samples,0,'pre-HMAC socket sampling');
      assert.equal(writes,0,'pre-HMAC storage mutation');
      deny(result);
    }
  }
});

test('valid MAC with WRONG persisted worker/PR/head denies after comparison and before socket sampling',async()=>{
  const valid=await signedCommand();
  for(const stored of [
    {...state,worker_id:'other-worker',active_wake:{
      ...state.active_wake,wake:{...wake,worker_id:'other-worker'},
    },queued_wake:{...wake,worker_id:'other-worker'}},
    {...state,active_wake:{...state.active_wake,wake:{...wake,pr_number:91}},
      queued_wake:{...wake,pr_number:91}},
    {...state,active_wake:{...state.active_wake,
      wake:{...wake,expected_head_sha:'f'.repeat(40)}},
      queued_wake:{...wake,expected_head_sha:'f'.repeat(40)}},
  ]){
    let samples=0;
    const deps=makeData(stored);
    deps.getWebSockets=()=>{samples++;throw Error('MUST_NOT_SAMPLE');};
    const r=await call(valid,{deps});
    assert.equal(r.code,'SAME_DO_PERSISTED_TARGET_MISMATCH');
    assert.ok(deps.stats().reads>0,'authenticated command may read the DO');
    assert.equal(deps.stats().writes,0);
    assert.equal(samples,0,'must refuse before G0-04 sampling');
    deny(r);
  }
});

test('crypto errors and wrong HMAC key cannot touch persisted state',async()=>{
  const cmd=await signedCommand();
  for(const extra of [
    {cryptoImpl:{}},
    {env:{...env,BKE_G0_OWNER_INSPECTION_KEY_B64:
      Buffer.from(new Uint8Array(32).fill(99)).toString('base64url')}},
  ]){
    let reads=0,samples=0;
    const deps={
      storage:{get(){reads++;throw Error('DO_PROBE');}},
      getWebSockets(){samples++;throw Error('SOCKET_PROBE');},
    };
    const r=await call(cmd,{deps,...extra});
    assert.equal(r.code,'SAME_DO_SIGNATURE_OR_SCOPE_DENIED');
    assert.equal(reads,0);assert.equal(samples,0);deny(r);
  }
});

test('injected owner approval and Access header are rejected even with valid HMAC',async()=>{
  const valid=await signedCommand();
  for(const extra of [{admin_authenticated:true},{owner_approved:true},{can_retire:true},
    {access_jwt:'PRIVATE_TOKEN'}]){
    const r=await call({...valid,...extra});
    assert.equal(r.code,'SAME_DO_SIGNATURE_OR_SCOPE_DENIED');deny(r);
  }
});

test('malformed signature, future/expired window and wrong keys fail without candidate',async()=>{
  const valid=await signedCommand();
  for(const patched of [
    {...valid,signature:'A'.repeat(43)},
    {...valid,issued_at_ms:NOW+2},
    {...valid,expires_at_ms:NOW-2},
    {...valid,nonce:'a'.repeat(64)},
  ]){
    const r=await call(patched);
    assert.equal(r.code,'SAME_DO_SIGNATURE_OR_SCOPE_DENIED');deny(r);
  }
});

test('repeated valid signature cannot imply replay protection or nonce consumed',async()=>{
  const valid=await signedCommand();
  for(let n=0;n<2;n++){
    const r=await call(valid);
    assert.equal(r.state,'INSPECTION_CANDIDATE_ONLY');deny(r);
  }
});

test('race on active wake phase across candidate read is fail-closed',async()=>{
  const data=structuredClone(state);
  let seen=0;
  const deps=makeData(data,{mutate:(key)=>{
    if(key==='active_wake' && ++seen===5) data.active_wake.phase='sent';
  }});
  const r=await call(await signedCommand(),{deps});
  assert.equal(r.code,'SAME_DO_IDENTITY_CHANGED');deny(r);
  assert.equal(deps.stats().writes,0);
});

test('G0-04 registered socket collisions propagate hard denial',async()=>{
  const d=makeData();
  d.getWebSockets=()=>[{deserializeAttachment(){return {
    workerId:target.worker_id,connectionId:'OTHER_PRIVATE',
    registered:true,sessionId:'PRIVATE_CHAT_SESSION',
  }}}];
  const r=await call(await signedCommand(),{deps:d});
  assert.equal(r.code,'SAME_DO_WITNESS_UNAVAILABLE');deny(r);
});

test('oversized Unicode persisted wake metadata is rejected after valid signature',async()=>{
  const huge={...state,queued_wake:{...wake,extra:'界'.repeat(24000)}};
  const r=await call(await signedCommand(),{deps:makeData(huge)});
  assert.equal(r.code,'SAME_DO_PERSISTED_TARGET_AMBIGUOUS');deny(r);
});

test('read exception from socket sampling is always blocked and redacted',async()=>{
  const d=makeData();d.getWebSockets=()=>{throw Error('PRIVATE_TOKEN')};
  const r=await call(await signedCommand(),{deps:d});
  assert.equal(r.code,'SAME_DO_WITNESS_UNAVAILABLE');deny(r);
});

test('source entrypoint is an internal DO method only, never an HTTP route or Wrangler-enabled',async()=>{
  const code=await readFile(new URL('../src/index.js',import.meta.url),'utf8');
  const conf=await readFile(new URL('../wrangler.toml',import.meta.url),'utf8');
  assert.match(code,/async inspectRetirementCandidate\(command\)/u);
  assert.match(code,/storage: this\.ctx\.storage/u);
  assert.match(code,/getWebSockets: \(\) => this\.ctx\.getWebSockets\(\)/u);
  assert.ok(!/\/owner-retirement-inspection|\/g0-inspect/u.test(code));
  assert.ok(!conf.includes('BKE_G0_SAME_DO_RECEIVER_ENABLED'));
  assert.ok(!conf.includes('BKE_G0_OWNER_INSPECTION_KEY_B64'));
});
