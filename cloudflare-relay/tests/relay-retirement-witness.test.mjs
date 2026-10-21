import test from 'node:test';
import assert from 'node:assert/strict';
import {readRelayRetirementWitness as witness, readRelayArchivedWakeEvidence as archivedWitness} from '../src/relay-retirement-witness.js';
import {nextRelayObservation, validateRelayObservation} from '../src/protocol.js';
const worker_id = 'android-worker-a';
const expected_head_sha = 'd80f5272e90677558fb1311a94772c8991f03b8f';
const pr_number = 90;
const repoName = 'jan2xo/bke-worker';
const delivery = 'ecba94d0-cc65-11f1-81c0-1201344291e7';
const context = {worker_id, repo: repoName, pr_number, expected_head_sha};
const wake = {protocol: 1, type: 'wake', worker_id, repo: repoName, pr_number,
  expected_head_sha, reason: 'github_pull_request_continuation', delivery_id: delivery};
const state = {worker_id, active_wake: {wake, phase: 'queued'}, recent_deliveries: [delivery]};
const storage = (data = state) => ({
  async get(key) { return data[key]; },
  async put() { throw Error('READ_ONLY_VIOLATION'); },
  async delete() { throw Error('READ_ONLY_VIOLATION'); },
});

test('observes queued coalesced wake but never claims retirement or ACK', async () => {
  const result = await witness(storage(), context);
  assert.equal(result.state, 'OBSERVED_ONLY');
  assert.equal(result.authority, 'NONE');
  assert.equal(result.can_retire, false);
  assert.equal(result.delivery_fenced, false);
  assert.equal(result.delivery_ack_proven, false);
  assert.equal(result.snapshot_atomic, false);
  assert.equal(result.active.phase, 'queued');
  assert.equal(result.active.delivery_id, delivery);
  assert.equal(result.active.repo, repoName);
  assert.equal(result.repo, repoName);
  assert.equal(Object.keys(result.active).includes('reason'), false);
});
test('no active wake is NOT permission to retire: token and external turn unknown', async () => {
  const result = await witness(storage({worker_id}), context);
  assert.equal(result.state, 'OBSERVED_ONLY');
  assert.equal(result.active, null);
  assert.equal(result.can_retire, false);
  assert.equal(result.owner_gate_required, true);
});
test('denies conflicting identity, wrong head, PR and missing identity', async () => {
  for (const data of [{...state, worker_id: 'other-worker'}, {...state, worker_id: undefined}]) {
    assert.equal((await witness(storage(data), context)).code, 'IDENTITY_MISMATCH_OR_MISSING');
  }
  for (const other of [{...context, pr_number: 91}, {...context, expected_head_sha: 'a'.repeat(40)},
    {...context, repo: 'jan2xo/bke-demo-app'}]) {
    assert.equal((await witness(storage(), other)).code, 'WAKE_CONTEXT_MISMATCH');
  }
});
test('denies invalid caller context, absent storage and read failures', async () => {
  assert.equal((await witness(storage(), {...context, worker_id: 'WRONG'})).code, 'EXPECTED_CONTEXT_INVALID');
  assert.equal((await witness(storage(), {...context, repo: 'attacker/other'})).code, 'EXPECTED_CONTEXT_INVALID');
  assert.equal((await witness(storage(), {...context, extra: true})).code, 'EXPECTED_CONTEXT_INVALID');
  assert.equal((await witness({}, context)).code, 'STORAGE_NOT_TRUSTED');
  assert.equal((await witness({get: async () => {throw Error('offline');}}, context)).code, 'STORAGE_READ_FAILED');
});
test('denies malformed phase, wake and queued metadata', async () => {
  assert.equal((await witness(storage({...state, active_wake: {wake, phase: 'completed'}}), context)).code, 'ACTIVE_PHASE_MALFORMED');
  assert.equal((await witness(storage({...state, active_wake: {wake: {...wake, delivery_id: 'bad delivery id'}, phase: 'queued'}}), context)).code, 'ACTIVE_WAKE_MALFORMED');
  assert.equal((await witness(storage({...state, queued_wake: {...wake, pr_number: 91}}), context)).code, 'WAKE_CONTEXT_MISMATCH');
  assert.equal((await witness(storage({...state, queued_wake: {...wake, worker_id: 'other'}}), context)).code, 'QUEUED_WAKE_MALFORMED');
});
test('rejects every missing/invalid required wake field in ACTIVE and QUEUED storage', async () => {
  const invalidCases = [
    ['protocol', 2], ['protocol', '1'], ['type', 'register'], ['repo', 'evil/worker'],
    ['reason', 'not a valid reason'], ['reason', ''], ['reason', 'x'.repeat(65)],
    ['delivery_id', 'not valid space'], ['worker_id', 'wrong-worker'],
    ['pr_number', -2], ['expected_head_sha', 'f'.repeat(39)],
  ];
  for (const [field, bad] of invalidCases) {
    for (const candidate of [{...wake, [field]: bad},
                             Object.fromEntries(Object.entries(wake).filter(([key]) => key !== field))]) {
      assert.equal((await witness(storage({...state, active_wake: {wake: candidate, phase: 'queued'}}), context)).code,
        'ACTIVE_WAKE_MALFORMED', 'active '+field);
      assert.equal((await witness(storage({...state, queued_wake: candidate}), context)).code,
        'QUEUED_WAKE_MALFORMED', 'queued '+field);
    }
  }
});

test('rejects unknown persisted wake keys and ambiguous active envelope fields', async () => {
  for (const candidate of [{...wake, secret: 'NEVER_EXPOSE'}, {...wake, diagnostics: true}]) {
    assert.equal((await witness(storage({...state, active_wake: {wake: candidate, phase: 'queued'}}), context)).code,
      'ACTIVE_WAKE_MALFORMED');
    assert.equal((await witness(storage({...state, queued_wake: candidate}), context)).code,
      'QUEUED_WAKE_MALFORMED');
  }
  const result = await witness(storage({...state, active_wake: {wake, phase: 'queued', extra: 1}}), context);
  assert.equal(result.code, 'ACTIVE_PHASE_MALFORMED');
});

test('canonical alternative repo and recovery delivery id require exact expected context', async () => {
  const recovered = {...wake, repo: 'jan2xo/bke-demo-app',
    delivery_id: 'recovery-android-worker-a-90-' + expected_head_sha,
    reason: 'github_pull_request_reconnect_recovery'};
  assert.equal((await witness(storage({...state, active_wake: {wake: recovered, phase: 'queued'}}), context)).code,
    'WAKE_CONTEXT_MISMATCH');
  const correct = {...context, repo: recovered.repo};
  const result = await witness(storage({worker_id,
    active_wake: {wake: recovered, phase: 'queued'}, recent_deliveries: [recovered.delivery_id]}), correct);
  assert.equal(result.state, 'OBSERVED_ONLY');
  assert.equal(result.active.delivery_id, recovered.delivery_id);
  assert.equal(result.can_retire, false);
});

test('reports stored connection-ID metadata only, never an authenticated live socket', async () => {
  const result = await witness(storage({...state, active_connection_id: 'stale-private-socket-id'}), context);
  assert.equal(result.state, 'OBSERVED_ONLY');
  assert.equal(result.active_connection_id_present, true);
  assert.equal(Object.hasOwn(result, 'registered_connection_present'), false);
  assert.equal(Object.hasOwn(result, 'live_socket_present'), false);
  assert.equal(Object.hasOwn(result, 'authoritative_socket_present'), false);
  assert.equal(JSON.stringify(result).includes('stale-private-socket-id'), false);
  assert.equal(result.can_retire, false);

  // The helper has no access to ctx.getWebSockets(), so absence/presence of a
  // stored ID MUST NOT be interpreted as evidence of connection liveness.
  const missing = await witness(storage({...state, active_connection_id: undefined}), context);
  assert.equal(missing.active_connection_id_present, false);
  assert.equal(Object.hasOwn(missing, 'registered_connection_present'), false);
  assert.equal(Object.hasOwn(missing, 'live_socket_present'), false);
  assert.equal(missing.can_retire, false);
});
test('fails closed on malformed connection and recent-delivery state', async () => {
  assert.equal((await witness(storage({...state, active_connection_id: 0}), context)).code, 'CONNECTION_METADATA_MALFORMED');
  assert.equal((await witness(storage({...state, recent_deliveries: ['bad delivery id']}), context)).code, 'RECENT_DELIVERIES_MALFORMED');
  assert.equal((await witness(storage({...state, recent_deliveries: Array(65).fill(delivery)}), context)).code, 'RECENT_DELIVERIES_MALFORMED');
});
test('each recognized phase remains observed-only and never cleared', async () => {
  for (const phase of ['queued', 'sent', 'deferred', 'accepted', 'recovery_required']) {
    const result = await witness(storage({...state, active_wake: {wake, phase}}), context);
    assert.equal(result.state, 'OBSERVED_ONLY');
    assert.equal(result.active.phase, phase);
    assert.equal(result.can_retire, false);
    assert.equal(result.delivery_fenced, false);
  }
});


test('registered-socket admission and matched ACK produce bounded relay-only observation', async () => {
  const admitted = nextRelayObservation(undefined, worker_id, 1000, 'registration');
  assert.equal(validateRelayObservation(admitted, worker_id), true);
  assert.equal(admitted.last_registration.observed_at_ms, 1000);
  assert.equal(admitted.last_ack, null);
  const ack = {protocol:1,type:'ack',worker_id,delivery_id:delivery,state:'accepted'};
  const observed = nextRelayObservation(admitted, worker_id, 1010, 'ack', ack, wake);
  assert.equal(observed.last_ack.state, 'accepted');
  assert.equal(observed.last_ack.delivery_id, delivery);
  assert.equal(Object.hasOwn(observed.last_ack,'connectionId'), false);
  assert.equal(Object.hasOwn(observed.last_ack,'sessionId'), false);
  const result = await witness(storage({...state,relay_observation_v1:observed}),context);
  assert.equal(result.state,'OBSERVED_ONLY');
  assert.equal(result.registration_admitted_at_ms,1000);
  assert.equal(result.last_ack_observed.observed_at_ms,1010);
  assert.equal(result.last_ack_observed.matches_expected_target,true);
  assert.equal(result.delivery_ack_proven,false, 'relay ACK does not prove ChatGPT delivery');
  assert.equal(result.can_retire,false);
  assert.equal(JSON.stringify(result).includes('sessionId'), false);
});
test('completed ACK remains a relay observation after active wake is cleared', async () => {
  const ack={protocol:1,type:'ack',worker_id,delivery_id:delivery,state:'completed'};
  const observed=nextRelayObservation(undefined,worker_id,1234,'ack',ack,wake);
  const result=await witness(storage({
    worker_id,relay_observation_v1:observed,
  }),context);
  assert.equal(result.active,null);
  assert.equal(result.last_ack_observed.state,'completed');
  assert.equal(result.last_ack_observed.delivery_id,delivery);
  assert.equal(result.can_retire,false);
  assert.equal(result.delivery_ack_proven,false);
});
test('old PR ACK is marked out-of-context, never silently accepted for owner scope',async()=>{
  const ack={protocol:1,type:'ack',worker_id,delivery_id:delivery,state:'deferred'};
  const observed=nextRelayObservation(undefined,worker_id,2000,'ack',ack,wake);
  const other={...context,pr_number:91};
  const result=await witness(storage({worker_id,relay_observation_v1:observed}),other);
  assert.equal(result.state,'OBSERVED_ONLY');
  assert.equal(result.last_ack_observed.matches_expected_target,false);
  assert.equal(result.can_retire,false);
});
test('observation corruption, wrong worker and time rollback fail closed',async()=>{
  const initial=nextRelayObservation(undefined,worker_id,3000,'registration');
  assert.equal(nextRelayObservation(initial,worker_id,2999,'registration'),null);
  assert.equal(nextRelayObservation(initial,'other-worker',3100,'registration'),null);
  assert.equal(nextRelayObservation(initial,worker_id,3100,'ack',
    {protocol:1,type:'ack',worker_id,delivery_id:'not-same',state:'accepted'},wake),null);
  assert.equal(nextRelayObservation(initial,worker_id,NaN,'registration'),null);
  assert.equal(nextRelayObservation(initial,worker_id,3200,'registration',{unsafe:true}),null);
  for(const corrupted of [
    {...initial,worker_id:'other-worker'},
    {...initial,secret:'NEVER_LEAK'},
    {...initial,last_registration:{observed_at_ms:'invalid'}},
    {...initial,last_ack:{observed_at_ms:3000,delivery_id:delivery,state:'completed'}},
  ]){
    assert.equal((await witness(storage({...state,relay_observation_v1:corrupted}),context)).code,
      'RELAY_OBSERVATION_MALFORMED');
  }
});


test('redacted supersession history is inspectable without permitting G0 retirement', async () => {
  const previous = {...wake, delivery_id:'original-sent-90'};
  const foreign = {...wake, repo:'jan2xo/bke-demo-app', pr_number:91,
    delivery_id:'foreign-queued-91'};
  const archive = [{wake:previous,phase:'sent'},{wake:foreign,phase:'queued'}];
  const data={...state,supersession_evidence_v1:archive};
  assert.equal((await witness(storage(data),context)).code,
    'SUPERSESSION_EVIDENCE_REQUIRES_OWNER_RECONCILIATION',
    'existing retirement witness MUST remain blocked');
  const result=await archivedWitness(storage(data),context);
  assert.equal(result.state,'ARCHIVE_OBSERVED_ONLY');
  assert.equal(result.recorded_supersession_count,2);
  assert.equal(result.archive_key_present,true);
  assert.equal(result.historical_completeness_proven,false);
  assert.equal(result.snapshot_atomic,false);
  assert.equal(result.can_retire,false);
  assert.equal(result.can_release_assignment,false);
  assert.equal(result.delivery_ack_proven,false);
  assert.equal(result.authority,'NONE');
  assert.deepEqual(result.recorded_supersessions.map(item => [
    item.delivery_id,item.last_recorded_phase,item.matches_expected_target,
  ]), [['original-sent-90','sent',true],['foreign-queued-91','queued',false]]);
  assert.equal(result.recorded_supersessions[1].repo,'jan2xo/bke-demo-app');
  assert.equal(Object.isFrozen(result.recorded_supersessions),true);
  assert.equal(Object.isFrozen(result.recorded_supersessions[0]),true);
  assert.equal(Object.hasOwn(result.recorded_supersessions[0],'reason'),false);
  assert.equal(Object.hasOwn(result.recorded_supersessions[0],'wake'),false);
});
test('absent archived key is not proof of complete historical delivery coverage',async()=>{
  const result=await archivedWitness(storage({worker_id}),context);
  assert.equal(result.state,'ARCHIVE_OBSERVED_ONLY');
  assert.equal(result.archive_key_present,false);
  assert.equal(result.recorded_supersession_count,0);
  assert.equal(result.historical_completeness_proven,false);
  assert.equal(result.can_retire,false);
});
test('malformed, duplicated, overflowing or foreign archival records deny',async()=>{
  const archived={wake,phase:'sent'};
  const invalid=[
    null,{},[{wake:{...wake,delivery_id:'invalid id'},phase:'sent'}],
    [archived,{...archived}],
    [{...archived,secret:'PRIVATE_TOKEN'}],
    Array.from({length:65},(_,i)=>({
      wake:{...wake,delivery_id:'historical-'+i},phase:'queued',
    })),
    [{wake:{...wake,worker_id:'other-worker'},phase:'queued'}],
  ];
  for (const item of invalid) {
    const result=await archivedWitness(storage({
      worker_id,supersession_evidence_v1:item,
    }),context);
    assert.equal(result.code,'SUPERSESSION_EVIDENCE_MALFORMED');
    assert.equal(result.can_retire,false);
    assert.equal(JSON.stringify(result).includes('PRIVATE_TOKEN'),false);
  }
});
test('archival reconciliation rejects wrong scope, missing identity and reads; never writes',async()=>{
  assert.equal((await archivedWitness(storage(),{...context,repo:'attacker/repo'})).code,
    'EXPECTED_CONTEXT_INVALID');
  assert.equal((await archivedWitness(storage({worker_id:'other-worker'}),context)).code,
    'IDENTITY_MISMATCH_OR_MISSING');
  assert.equal((await archivedWitness({get:async()=>{throw Error('PRIVATE_TOKEN')}},context)).code,
    'STORAGE_READ_FAILED');
  let writes=0;
  const readonly={
    async get(k){return ({worker_id,supersession_evidence_v1:[{wake,phase:'sent'}]})[k];},
    async put(){writes++;},async delete(){writes++;},async transaction(){writes++;},
  };
  const result=await archivedWitness(readonly,context);
  assert.equal(result.state,'ARCHIVE_OBSERVED_ONLY');
  assert.equal(writes,0);
});
