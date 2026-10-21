import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {
  RETIREMENT_EPOCH_KEY, stageRetirementFenceCandidate as commit,
} from '../src/relay-retirement-transaction-kernel.js';
import {
  RETIREMENT_FENCE_KEY,validateRetiredFenceRecord,
} from '../src/relay-retirement-fence-policy.js';

const target=Object.freeze({
  worker_id:'android-worker-a', repo:'jan2xo/bke-worker', pr_number:90,
  expected_head_sha:'d80f5272e90677558fb1311a94772c8991f03b8f',
});
const delivery='ecba94d0-cc65-11f1-81c0-1201344291e7';
const delivery2='161779c0-cc60-11f1-9ea6-31208570a69a';
const wake=id=>({
  protocol:1,type:'wake',...target,
  reason:'github_pull_request_continuation', delivery_id:id,
});
const initial=()=>({
  worker_id:target.worker_id,active_wake:{wake:wake(delivery),phase:'accepted'},
  queued_wake:wake(delivery),recent_deliveries:[delivery],
});
const request=Object.freeze({
  target,retirement_id:'operator-candidate-007',
  created_at_ms:1792500000000,expected_delivery_ids:[delivery],
});
const NEGATIVE={
  authority:'NONE',human_owner_authenticated:false,human_consent_verified:false,
  current_github_assignment_verified:false,same_do_provenance_verified:false,
  nonce_consumed:false,replay_protection_proven:false,
  can_commit:false,can_retire:false,can_dispatch:false,can_reconnect:false,
  can_release_assignment:false,can_reuse_worker_id:false,
  delivery_fenced:false,delivery_ack_proven:false,
  socket_membership_verified:false,all_paths_fenced:false,
  atomic_commit_proven:false,credential_revocation_proven:false,
};
const checkNegative=x=>{
  assert.equal(Object.isFrozen(x),true);
  for(const [k,v] of Object.entries(NEGATIVE)){
    assert.equal(Object.hasOwn(x,k),true,k);
    assert.equal(x[k],v,k);
  }
  const encoded=JSON.stringify(x);
  assert.ok(!encoded.includes('PRIVATE_TOKEN'));
  assert.ok(!encoded.includes('SECRET_SOCKET_ID'));
  assert.ok(!encoded.includes(delivery));
};

function store(start=initial(),options={}) {
  let state=structuredClone(start),writes=0,txCount=0,queued=Promise.resolve();
  const data={
    async transaction(fn){
      // A deliberately serialized, rollback-capable transaction test double.
      let finish;
      const next=new Promise(resolve=>{finish=resolve});
      const prior=queued;queued=next;
      await prior;
      txCount++;
      const snapshot=structuredClone(state);
      let stagedWrites=0;
      const tx={
        async get(key){return snapshot[key];},
        async put(key,value){
          if(options.failPutKey===key)throw Error('PRIVATE_TOKEN');
          stagedWrites++;snapshot[key]=structuredClone(value);
        },
      };
      try {
        if(options.failBeforeTransaction)throw Error('NO_TRANSACTION');
        const result=await fn(tx);
        if(options.beforeCommit)await options.beforeCommit();
        if(options.failBeforeCommit)throw Error('ROLLED_BACK');
        state=snapshot;
        writes+=stagedWrites;
        if(options.failAfterCommit)throw Error('CRASH_AFTER_COMMIT');
        return result;
      } finally {finish()}
    },
    async get(key){
      if(options.failReadback)throw Error('SECRET_SOCKET_ID');
      if(options.mutateReadback)options.mutateReadback(state,key);
      return state[key];
    },
    snapshot(){return structuredClone(state)},
    stats(){return {writes,txCount}},
  };
  return data;
}
function assertBlocked(result,code){
  assert.equal(result.state,'BLOCKED');
  assert.equal(result.code,code);
  checkNegative(result);
}

test('transactional shape write persists fence and monotonic epoch together, but grants NOTHING',async()=>{
  const db=store();
  const r=await commit(db,request);
  assert.equal(r.state,'STAGED_SHAPE_READBACK_ONLY');
  assert.equal(r.observed_epoch,1);
  checkNegative(r);
  const state=db.snapshot();
  assert.equal(validateRetiredFenceRecord(state[RETIREMENT_FENCE_KEY]),true);
  assert.equal(state[RETIREMENT_EPOCH_KEY],1);
  assert.equal(state[RETIREMENT_FENCE_KEY].retirement_id,request.retirement_id);
  assert.equal(db.stats().writes,2);
  assert.deepEqual(state.active_wake,initial().active_wake,'no wake cancellation');
  assert.deepEqual(state.queued_wake,initial().queued_wake,'no wake promotion/replay');
});

test('repeated same intent is an idempotent observation without second writes',async()=>{
  const db=store();
  assert.equal((await commit(db,request)).state,'STAGED_SHAPE_READBACK_ONLY');
  const again=await commit(db,request);
  assert.equal(again.state,'EXISTING_SHAPE_READBACK_ONLY');
  assert.equal(db.stats().writes,2);
  assert.equal(again.observed_epoch,1);
  checkNegative(again);
});

test('existing fence rejects same target with a different retirement decision',async()=>{
  const db=store();
  await commit(db,request);
  for(const change of [{retirement_id:'other-decision'},{created_at_ms:request.created_at_ms+1}]){
    assertBlocked(await commit(db,{...request,...change}),'EXISTING_FENCE_DECISION_CONFLICT');
    assert.equal(db.stats().writes,2);
  }
});

test('existing fence for another worker/PR/head is immutable and cannot be overwritten',async()=>{
  const db=store();
  await commit(db,request);
  for(const change of [
    {worker_id:'different-worker'}, {repo:'jan2xo/bke-demo-app'},
    {pr_number:91},{expected_head_sha:'a'.repeat(40)},
  ]){
    assertBlocked(await commit(db,{...request,target:{...target,...change}}),
      'EXISTING_FENCE_TARGET_CONFLICT');
    assert.equal(db.stats().writes,2);
  }
});

test('missing or inconsistent high-water and tombstone block resurrection',async()=>{
  const first=store();await commit(first,request);
  const good=first.snapshot(),fence=good[RETIREMENT_FENCE_KEY];
  for(const bad of [
    {...good,[RETIREMENT_EPOCH_KEY]:undefined},
    {...good,[RETIREMENT_EPOCH_KEY]:0},
    {...good,[RETIREMENT_EPOCH_KEY]:2},
    {...good,[RETIREMENT_FENCE_KEY]:undefined},
    {...good,[RETIREMENT_FENCE_KEY]:{...fence,epoch:0}},
    {...good,[RETIREMENT_FENCE_KEY]:{...fence,status:'active'}},
    {...initial(),[RETIREMENT_EPOCH_KEY]:1},
  ]){
    const db=store(bad);
    assertBlocked(await commit(db,request),'FENCE_EPOCH_INCONSISTENT');
    assert.equal(db.stats().writes,0);
  }
});

test('missing wake, malformed worker, or different active and queued target deny',async()=>{
  for(const bad of [
    {worker_id:target.worker_id}, // empty does not authorize retirement
    {...initial(),worker_id:'other-worker'},
    {...initial(),queued_wake:{...wake(delivery),pr_number:91}},
    {...initial(),active_wake:{...initial().active_wake,phase:'completed'}},
    {...initial(),recent_deliveries:['bad delivery']},
  ]){
    const db=store(bad);
    assertBlocked(await commit(db,request),
      bad.active_wake===undefined?'NO_PERSISTED_WAKE_TO_RECONCILE':
      'PERSISTED_WAKE_OR_IDENTITY_UNTRUSTED');
    assert.equal(db.stats().writes,0);
  }
});

test('registered socket metadata blocks before any fence write',async()=>{
  const db=store({...initial(),active_connection_id:'SECRET_SOCKET_ID'});
  assertBlocked(await commit(db,request),'CONNECTION_ID_PRESENT_SOCKET_UNVERIFIED');
  assert.equal(db.stats().writes,0);
});

test('exact delivery IDs must match active and queued wake collection',async()=>{
  const db=store({
    ...initial(),active_wake:{wake:wake(delivery2),phase:'sent'},
    queued_wake:wake(delivery),
  });
  assertBlocked(await commit(db,request),'DELIVERY_SET_MISMATCH');
  const withBoth={...request,expected_delivery_ids:[delivery2,delivery].sort()};
  const ok=await commit(db,withBoth);
  assert.equal(ok.state,'STAGED_SHAPE_READBACK_ONLY');
  checkNegative(ok);
  assert.equal(db.stats().writes,2);
});

test('rejects guessed IDs, unordered/duplicate sets, forged authority, invalid request fields',async()=>{
  for(const bad of [
    null,{}, {...request,admin_authenticated:true},
    {...request,owner_approved:true},
    {...request,can_retire:true},
    {...request,access_jwt:'PRIVATE_TOKEN'},
    {...request,target:{...target,pr_number:0}},
    {...request,created_at_ms:NaN},
    {...request,retirement_id:'with spaces'},
    {...request,expected_delivery_ids:[]},
    {...request,expected_delivery_ids:[delivery,delivery]},
    {...request,expected_delivery_ids:[delivery2,delivery]},
    {...request,expected_delivery_ids:['bad']},
    {...request,expected_delivery_ids:[delivery,delivery2,'extra']},
  ]){
    const db=store();
    assertBlocked(await commit(db,bad),'REQUEST_INVALID');
    assert.equal(db.stats().txCount,0);
    assert.equal(db.stats().writes,0);
  }
});

test('no transaction API, no get API, and malformed transaction handle fail closed',async()=>{
  for(const bad of [null,{}, {get:async()=>{}},{transaction:async()=>{}}]){
    assertBlocked(await commit(bad,request),'TRANSACTION_UNAVAILABLE');
  }
  const db={async get(){throw Error('NEVER')}, async transaction(callback){
    return callback({get:async()=>{}});
  }};
  assertBlocked(await commit(db,request),'TRANSACTION_HANDLE_INVALID');
});

test('a failure during the second write rolls back both keys (in atomic storage)',async()=>{
  const db=store(initial(),{failPutKey:RETIREMENT_EPOCH_KEY});
  assertBlocked(await commit(db,request),'TRANSACTION_OUTCOME_UNCERTAIN');
  const state=db.snapshot();
  assert.equal(state[RETIREMENT_FENCE_KEY],undefined);
  assert.equal(state[RETIREMENT_EPOCH_KEY],undefined);
  assert.equal(db.stats().writes,0);
});

test('transaction could COMMIT then error: report UNCERTAIN and idempotently reconcile on retry',async()=>{
  const db=store(initial(),{failAfterCommit:true});
  const r=await commit(db,request);
  assertBlocked(r,'TRANSACTION_OUTCOME_UNCERTAIN');
  assert.equal(db.snapshot()[RETIREMENT_EPOCH_KEY],1);
  assert.equal(db.stats().writes,2);
  // An error after commit is not evidence of rollback; retries never overwrite.
  const recovered=store(db.snapshot());
  assert.equal((await commit(recovered,request)).state,'EXISTING_SHAPE_READBACK_ONLY');
  assert.equal(recovered.stats().writes,0);
});

test('unavailable or mismatched post-transaction readback cannot imply fencing',async()=>{
  const failure=store(initial(),{failReadback:true});
  assertBlocked(await commit(failure,request),'POST_TRANSACTION_READBACK_UNCERTAIN');
  assert.equal(failure.stats().writes,2);
  let once=false;
  const mismatched=store(initial(),{mutateReadback:(state,key)=>{
    if(!once && key===RETIREMENT_FENCE_KEY){
      state[RETIREMENT_EPOCH_KEY]=2;once=true;
    }
  }});
  assertBlocked(await commit(mismatched,request),'POST_TRANSACTION_READBACK_MISMATCH');
});

test('two concurrent decisions serialize: one wins, another blocks without overwrite',async()=>{
  const db=store();
  const other={...request,retirement_id:'operator-other-intent'};
  const [a,b]=await Promise.all([commit(db,request),commit(db,other)]);
  assert.equal(a.state,'STAGED_SHAPE_READBACK_ONLY');
  assertBlocked(b,'EXISTING_FENCE_DECISION_CONFLICT');
  assert.equal(db.stats().writes,2);
  assert.equal(db.snapshot()[RETIREMENT_FENCE_KEY].retirement_id,request.retirement_id);
});

test('module remains unreachable from relay runtime and has no configured secret or route',async()=>{
  const index=await readFile(new URL('../src/index.js',import.meta.url),'utf8');
  const wrangler=await readFile(new URL('../wrangler.toml',import.meta.url),'utf8');
  assert.ok(!index.includes('relay-retirement-transaction-kernel'));
  assert.ok(!wrangler.includes('G0_RETIREMENT_WRITE_ENABLED'));
  assert.ok(!index.includes('/retire-worker'));
  assert.ok(!index.includes('stageRetirementFenceCandidate'));
});
