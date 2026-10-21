import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {
  inspectDormantRetirementRouteFence as inspect,
  RETIREMENT_ROUTE_SEAMS,
} from '../src/relay-retirement-route-fence.js';
import {
  FENCED_OPERATIONS, RETIREMENT_FENCE_KEY,
  validateRetiredFenceRecord,
} from '../src/relay-retirement-fence-policy.js';
import {RETIREMENT_EPOCH_KEY} from '../src/relay-retirement-transaction-kernel.js';

const target=Object.freeze({
  worker_id:'android-worker-a',
  repo:'jan2xo/bke-worker',
  pr_number:90,
  expected_head_sha:'d80f5272e90677558fb1311a94772c8991f03b8f',
});
const fence=Object.freeze({
  schema_version:1,status:'retired',...target,
  retirement_id:'candidate-never-live',epoch:1,
  created_at_ms:1792500000000,
});
const input=operation=>({target:{...target},operation});
const stored=()=>({
  worker_id:target.worker_id,
  [RETIREMENT_FENCE_KEY]:fence,
  [RETIREMENT_EPOCH_KEY]:1,
});
const gates=Object.freeze({
  authority:'NONE',human_owner_authenticated:false,
  human_consent_verified:false,current_github_assignment_verified:false,
  same_do_provenance_verified:false,nonce_consumed:false,
  replay_protection_proven:false,dispatch_permitted:false,
  connect_permitted:false,read_permitted:false,
  can_retire:false,can_release_assignment:false,can_reuse_worker_id:false,
  delivery_fenced:false,all_paths_fenced:false,
  atomic_commit_proven:false,credential_revocation_proven:false,
});
function assertNoAuthority(r) {
  assert.ok(Object.isFrozen(r));
  for(const [key,value] of Object.entries(gates)) {
    assert.equal(r[key],value,key);
  }
  const data=JSON.stringify(r);
  assert.ok(!data.includes('PRIVATE_SOCKET_ID'));
  assert.ok(!data.includes('PRIVATE_TOKEN'));
  assert.ok(!data.includes('candidate-never-live'));
}
const deny=(result,code)=>{
  assert.equal(result.state,'BLOCKED');
  assert.equal(result.code,code);
  assertNoAuthority(result);
};

function fixture(values=stored(),options={}) {
  const data={...values};
  let gets=0,writes=0,transactions=0;
  const storage={
    async transaction(callback) {
      transactions++;
      const tx={
        async get(key) {
          gets++;
          if (options.getError===key) throw Error('PRIVATE_TOKEN');
          if (options.beforeRead) await options.beforeRead(key);
          return data[key];
        },
        async put() {writes++;throw Error('NEVER_WRITE');},
        async delete() {writes++;throw Error('NEVER_DELETE');},
      };
      return callback(tx);
    },
    async get() {gets++;throw Error('OUTSIDE_TRANSACTION');},
    async put() {writes++;throw Error('NEVER_WRITE');},
    async delete() {writes++;throw Error('NEVER_DELETE');},
  };
  return {storage,stats:()=>({gets,writes,transactions})};
}

test('paired fence and epoch only yield RETIRED_BLOCKED for ALL nine operations',async()=>{
  assert.equal(validateRetiredFenceRecord(fence),true);
  assert.equal(Object.isFrozen(FENCED_OPERATIONS),true);
  assert.equal(FENCED_OPERATIONS.length,9);
  for(const operation of FENCED_OPERATIONS) {
    const f=fixture();
    const r=await inspect(f.storage,input(operation));
    assert.equal(r.state,'RETIRED_BLOCKED',operation);
    assert.equal(r.code,'WORKER_RETIRED',operation);
    assert.equal(r.operation,operation);
    assertNoAuthority(r);
    assert.deepEqual(f.stats(),{gets:3,writes:0,transactions:1});
  }
});

test('no fence is NEVER permission to connect, register, send or dispatch',async()=>{
  for(const operation of FENCED_OPERATIONS) {
    const f=fixture({worker_id:target.worker_id});
    deny(await inspect(f.storage,input(operation)),'FENCE_ABSENT_UNVERIFIED');
    assert.equal(f.stats().writes,0);
  }
});

test('absent, partial, invalid, downgraded or contradictory epoch blocks',async()=>{
  const full=stored();
  for(const bad of [
    {...full,[RETIREMENT_FENCE_KEY]:undefined},
    {...full,[RETIREMENT_EPOCH_KEY]:undefined},
    {...full,[RETIREMENT_EPOCH_KEY]:0},
    {...full,[RETIREMENT_EPOCH_KEY]:2},
    {...full,[RETIREMENT_EPOCH_KEY]:'1'},
    {...full,[RETIREMENT_EPOCH_KEY]:Number.MAX_SAFE_INTEGER+1},
    {...full,[RETIREMENT_FENCE_KEY]:{...fence,epoch:2}},
    {...full,[RETIREMENT_FENCE_KEY]:{...fence,status:'active'}},
    {...full,[RETIREMENT_FENCE_KEY]:null},
    {...full,[RETIREMENT_FENCE_KEY]:{...fence,unexpected:'secret'}},
  ]) {
    const f=fixture(bad);
    deny(await inspect(f.storage,input('dispatch')),
      'FENCE_EPOCH_INCONSISTENT');
    assert.equal(f.stats().writes,0);
  }
});

test('stored worker identity and target mismatch deny before retirement conclusion',async()=>{
  for(const id of [undefined,null,'other-worker',false]) {
    const f=fixture({...stored(),worker_id:id});
    deny(await inspect(f.storage,input('connect')),'PERSISTED_WORKER_ID_MISMATCH');
  }
  for(const change of [
    {worker_id:'another-worker'}, {repo:'jan2xo/bke-demo-app'},
    {pr_number:91}, {expected_head_sha:'f'.repeat(40)},
  ]) {
    const f=fixture({...stored(),[RETIREMENT_FENCE_KEY]:{...fence,...change}});
    deny(await inspect(f.storage,input('dispatch')),'FENCE_TARGET_MISMATCH');
    assert.equal(f.stats().writes,0);
  }
});

test('unknown operations and injected permission fields fail before storage access',async()=>{
  for(const bad of [
    null,{}, {target}, {target:{...target},operation:'release-label'},
    {target:{...target},operation:'ensureIdentity'},
    {target:{...target},operation:'send',admin_approved:true},
    {target:{...target,can_retire:true},operation:'ack'},
    {target:{...target,expected_head_sha:'invalid'},operation:'dispatch'},
    {target:{...target},operation:null},
    {target:{...target},operation:0},
  ]) {
    const f=fixture();
    deny(await inspect(f.storage,bad),'REQUEST_INVALID');
    assert.deepEqual(f.stats(),{gets:0,writes:0,transactions:0});
  }
});

test('no transaction or malformed injected transaction handle can permit routing',async()=>{
  for(const bad of [undefined,null,{}, {get:async()=>{}},
    {transaction:null}]) {
    deny(await inspect(bad,input('recover')),'TRANSACTION_UNAVAILABLE');
  }
  const missing={async transaction(cb){return cb({})}};
  deny(await inspect(missing,input('ack')),'TRANSACTION_HANDLE_INVALID');
});

test('storage failures are redacted and fail closed without retry or writes',async()=>{
  for(const key of ['worker_id',RETIREMENT_FENCE_KEY,RETIREMENT_EPOCH_KEY]){
    const f=fixture(stored(),{getError:key});
    deny(await inspect(f.storage,input('promote')),'TRANSACTION_READ_UNCERTAIN');
    assert.equal(f.stats().transactions,1);
    assert.equal(f.stats().writes,0);
  }
  const throws={async transaction(){throw Error('PRIVATE_TOKEN')}};
  deny(await inspect(throws,input('socket-error')),'TRANSACTION_READ_UNCERTAIN');
});

test('malformed, undefined and fabricated transaction results fail closed',async()=>{
  for(const forged of [
    undefined,null,true,[],{state:'ALLOWED'},
    {state:'RETIRED_BLOCKED',operation:'recover'},
    {state:'BLOCKED',code:'not safe text'},
  ]){
    const storage={async transaction(){return forged}};
    deny(await inspect(storage,input('dispatch')),'TRANSACTION_RESULT_INVALID');
  }
});

test('request snapshot precedes asynchronous reads and forbids mutable target swapping',async()=>{
  let unblock;
  let reached;
  const hold=new Promise(resolve=>{unblock=resolve});
  const entered=new Promise(resolve=>{reached=resolve});
  let first=true;
  const f=fixture(stored(),{async beforeRead(key){
    if(first && key==='worker_id'){
      first=false;reached();await hold;
    }
  }});
  const mutable=input('send');
  const pending=inspect(f.storage,mutable);
  await entered;
  mutable.operation='connect';
  mutable.target.worker_id='other-worker';
  mutable.target.pr_number=91;
  mutable.target.expected_head_sha='f'.repeat(40);
  unblock();
  const r=await pending;
  assert.equal(r.state,'RETIRED_BLOCKED');
  assert.equal(r.operation,'send');
  assertNoAuthority(r);
  assert.equal(f.stats().writes,0);
});

test('foreign original target cannot be repaired during an awaited transaction read',async()=>{
  let unblock,reached;
  const gate=new Promise(resolve=>{unblock=resolve});
  const entered=new Promise(resolve=>{reached=resolve});
  const f=fixture(stored(),{async beforeRead(key){
    if(key==='worker_id'){reached();await gate}
  }});
  const malicious=input('dispatch');
  malicious.target.worker_id='different-worker';
  const pending=inspect(f.storage,malicious);
  await entered;
  Object.assign(malicious.target,target);
  unblock();
  deny(await pending,'PERSISTED_WORKER_ID_MISMATCH');
  assert.equal(f.stats().writes,0);
});

test('route seam inventory matches actual WorkerSession implementation, not a live hook',async()=>{
  const code=await readFile(new URL('../src/index.js',import.meta.url),'utf8');
  const wrangler=await readFile(new URL('../wrangler.toml',import.meta.url),'utf8');
  assert.deepEqual(Object.keys(RETIREMENT_ROUTE_SEAMS).sort(),
    [...FENCED_OPERATIONS].sort());
  for(const [operation,marker] of Object.entries(RETIREMENT_ROUTE_SEAMS)){
    assert.ok(code.includes(marker),'missing route seam '+operation);
    assert.equal(typeof marker,'string');
  }
  assert.ok(code.includes('async ensureIdentity(workerId)'),
    'identity write requires future pre-fence gate');
  assert.ok(!code.includes('relay-retirement-route-fence'),
    'must remain UNIMPORTED by real runtime');
  assert.ok(!code.includes('inspectDormantRetirementRouteFence'));
  assert.ok(!wrangler.includes('BKE_G0_ROUTE_FENCE_ENABLED'));
  assert.ok(!wrangler.includes('BKE_G0_RETIREMENT_WRITE_ENABLED'));
});
