import test from 'node:test';
import assert from 'node:assert/strict';
import {readRetirementInspectionConsistency as inspect} from '../src/relay-retirement-inspection-consistency.js';

const expected = Object.freeze({
  worker_id: 'android-worker-a',
  repo: 'jan2xo/bke-worker',
  pr_number: 90,
  expected_head_sha: 'd80f5272e90677558fb1311a94772c8991f03b8f',
});
const delivery_id = 'ecba94d0-cc65-11f1-81c0-1201344291e7';
const wake = Object.freeze({
  protocol: 1, type: 'wake', worker_id: expected.worker_id,
  repo: expected.repo, pr_number: expected.pr_number,
  expected_head_sha: expected.expected_head_sha,
  reason: 'github_pull_request_continuation', delivery_id,
});
const state = {
  worker_id: expected.worker_id,
  active_wake: {wake, phase: 'queued'},
  queued_wake: wake,
  recent_deliveries: [delivery_id],
  active_connection_id: 'SECRET_CONNECTION_ID',
};
const fence = {
  schema_version: 1, status: 'retired', ...expected, retirement_id: 'candidate-not-persisted',
  epoch: 1, created_at_ms: 1792500000000,
};
const storage = (data = state) => ({
  async get(key) {return data[key];},
  async put() {throw Error('NO_STORAGE_WRITES');},
  async delete() {throw Error('NO_STORAGE_DELETES');},
  async transaction() {throw Error('NO_TRANSACTION');},
});
const socket = (changes = {}) => ({
  deserializeAttachment() {
    return {workerId: expected.worker_id, connectionId: 'SECRET_CONNECTION_ID',
      registered: true, sessionId: 'SECRET_CHAT_SESSION', ...changes};
  },
});
const deps = (data = state, sockets = [socket()]) =>
  ({storage: storage(data), getWebSockets: () => sockets});
const negative = Object.freeze({
  authority: 'NONE', can_retire: false, can_dispatch: false,
  can_release_assignment: false, can_reuse_worker_id: false,
  delivery_ack_proven: false, delivery_fenced: false,
  atomic_commit_proven: false, credential_revocation_proven: false,
  owner_authenticated: false, do_provenance_verified: false,
  snapshot_atomic: false, socket_sample_atomic: false,
  socket_liveness_proven: false, owner_gate_required: true,
});
function assertNegative(r) {
  assert.equal(Object.isFrozen(r), true);
  for (const [k,v] of Object.entries(negative)) {
    assert.equal(Object.hasOwn(r,k),true,'missing '+k);
    assert.equal(r[k],v,k);
  }
  const output=JSON.stringify(r);
  assert.equal(output.includes('SECRET_CONNECTION_ID'),false);
  assert.equal(output.includes('SECRET_CHAT_SESSION'),false);
  assert.equal(output.includes('PRIVATE_TOKEN'),false);
}

test('bound sampled observation is read-only, redacted and never authority', async () => {
  const r=await inspect(deps(),expected);
  assert.equal(r.state,'OBSERVED_ONLY');
  assert.equal(r.active.phase,'queued');
  assert.equal(r.queued.delivery_id,delivery_id);
  assert.equal(r.registered_socket_id_match_observed,true);
  assert.equal(r.retired_record_schema_observed,false);
  assert.equal(r.retired_epoch_shape_observed,null);
  assertNegative(r);
});

test('valid-shaped stored tombstone is only schema observation, not provenance', async () => {
  const r=await inspect(deps({...state,retirement_fence_v1:fence}),expected);
  assert.equal(r.state,'OBSERVED_ONLY');
  assert.equal(r.retired_record_schema_observed,true);
  assert.equal(r.retired_epoch_shape_observed,1);
  assert.equal(r.delivery_fenced,false);
  assert.equal(r.owner_authenticated,false);
  assert.equal(r.do_provenance_verified,false);
  assertNegative(r);
});

test('missing all wakes, sockets and fence never grants a retirement decision', async () => {
  const r=await inspect(deps({worker_id:expected.worker_id},[]),expected);
  assert.equal(r.state,'OBSERVED_ONLY');
  assert.equal(r.active,null);
  assert.equal(r.queued,null);
  assert.equal(r.retired_record_schema_observed,false);
  assertNegative(r);
});

test('forged owner or caller privilege fields are rejected as target-invalid', async () => {
  for(const add of [{owner_approved:true},{authenticated:true},{can_retire:true},
                    {admin_token:'PRIVATE_TOKEN'},{provenance:'OWNER'}]){
    const r=await inspect(deps(),{...expected,...add});
    assert.equal(r.code,'TARGET_INVALID');
    assertNegative(r);
  }
});

test('wrong worker, repository, PR and head are never trusted inputs', async () => {
  const cases=[
    {...expected,worker_id:'INVALID_WORKER'},
    {...expected,repo:'attacker/repo'},
    {...expected,pr_number:0},
    {...expected,expected_head_sha:'a'.repeat(39)},
    {...expected,extra:true},
  ];
  for(const e of cases){
    const r=await inspect(deps(),e);
    assert.equal(r.code,'TARGET_INVALID');
    assertNegative(r);
  }
  const otherWorker=await inspect(deps(),{...expected,worker_id:'different-worker'});
  assert.equal(otherWorker.code,'IDENTITY_MISMATCH_OR_MISSING');
  assertNegative(otherWorker);
  for(const e of [
    {...expected,repo:'jan2xo/bke-demo-app'},
    {...expected,pr_number:91},
    {...expected,expected_head_sha:'f'.repeat(40)},
  ]) {
    const r=await inspect(deps(),e);
    assert.equal(r.code,'WAKE_CONTEXT_MISMATCH');
    assertNegative(r);
  }
});

test('malformed and conflicting retirement tombstones fail closed', async () => {
  for (const bad of [
    null, {}, {...fence,status:'active'}, {...fence,epoch:0},
    {...fence,owner_approved:true}, {...fence,created_at_ms:Infinity},
  ]) {
    const r=await inspect(deps({...state,retirement_fence_v1:bad}),expected);
    assert.equal(r.code,'FENCE_RECORD_MALFORMED');
    assertNegative(r);
  }
  for (const changed of [
    {worker_id:'other-worker'}, {repo:'jan2xo/bke-demo-app'},
    {pr_number:91}, {expected_head_sha:'f'.repeat(40)},
  ]) {
    const r=await inspect(deps({...state,retirement_fence_v1:{...fence,...changed}}),expected);
    assert.equal(r.code,'FENCE_TARGET_MISMATCH');
    assertNegative(r);
  }
});

test('detects an active wake mutation between two snapshots', async () => {
  let activeReads=0;
  const readOnly={
    async get(key) {
      if(key==='active_wake') {
        activeReads++;
        return activeReads>=3 ? {...state.active_wake, phase:'sent'} : state.active_wake;
      }
      return state[key];
    },
    async put() {throw Error('NO_WRITES');},
  };
  const r=await inspect({storage:readOnly,getWebSockets:()=>[socket()]},expected);
  assert.equal(r.code,'DO_STATE_CHANGED_DURING_INSPECTION');
  assertNegative(r);
});

test('detects recent-delivery metadata mutation during sampling', async () => {
  let reads=0;
  const readOnly={async get(key) {
    if (key==='recent_deliveries') {
      reads++;
      return reads>=2 ? [delivery_id,'161779c0-cc60-11f1-9ea6-31208570a69a'] : [delivery_id];
    }
    return state[key];
  }};
  const r=await inspect({storage:readOnly,getWebSockets:()=>[socket()]},expected);
  assert.equal(r.code,'DO_STATE_CHANGED_DURING_INSPECTION');
  assertNegative(r);
});

test('detects retirement fence becoming present mid-observation', async () => {
  let reads=0;
  const readOnly={async get(key) {
    if(key==='retirement_fence_v1') return ++reads>=2 ? fence : undefined;
    return state[key];
  }};
  const r=await inspect({storage:readOnly,getWebSockets:()=>[socket()]},expected);
  assert.equal(r.code,'DO_STATE_CHANGED_DURING_INSPECTION');
  assertNegative(r);
});

test('wrong duplicate or unreadable socket propagates strict G0-02 denial', async () => {
  const cases=[
    [deps(state,[socket(),socket()]),'DUPLICATE_REGISTERED_SOCKET'],
    [deps(state,[socket({connectionId:'ANOTHER_SECRET'})]),'REGISTERED_SOCKET_CONFLICT'],
    [deps(state,[{}]),'SOCKET_ATTACHMENT_UNREADABLE'],
  ];
  for(const [d,code] of cases){
    const r=await inspect(d,expected);
    assert.equal(r.code,code);
    assertNegative(r);
  }
});

test('storage errors, untrusted providers and oversize reads deny without leaking', async () => {
  const cases=[
    [{storage:{async get(){throw Error('PRIVATE_TOKEN');}},getWebSockets:()=>[]},'INSPECTION_READ_FAILED'],
    [{storage:storage(),getWebSockets:null},'DO_CONTEXT_REQUIRED'],
    [{storage:storage({...state,retirement_fence_v1:'PRIVATE_TOKEN'.repeat(8000)}),
      getWebSockets:()=>[socket()]},'SNAPSHOT_INVALID_OR_OVERSIZED'],
    [{storage:{async get(key){return key==='worker_id'?1n:state[key];}},getWebSockets:()=>[]},
      'INSPECTION_READ_FAILED'],
  ];
  for (const [d,code] of cases){
    const r=await inspect(d,expected);
    assert.equal(r.code,code);
    assertNegative(r);
  }
});

test('read-only observation never calls storage writes, promotion or socket sends', async () => {
  let writes=0;
  const readonly={
    async get(key){return state[key];},
    async put(){writes++;},
    async delete(){writes++;},
    async transaction(){writes++;},
  };
  const sock={...socket(),send(){writes++;},close(){writes++;}};
  const r=await inspect({storage:readonly,getWebSockets:()=>[sock]},expected);
  assert.equal(r.state,'OBSERVED_ONLY');
  assert.equal(writes,0);
  assertNegative(r);
});

test('all blocked outputs contain only fixed code and explicit negative gates', async () => {
  for(const x of [
    await inspect({},expected),
    await inspect(deps(),{...expected,extra:true}),
    await inspect(deps({...state,retirement_fence_v1:null}),expected),
  ]){
    assert.equal(x.state,'BLOCKED');
    assert.deepEqual(Object.keys(x).sort(), ['state','code',...Object.keys(negative)].sort());
    assertNegative(x);
  }
});
