import test from 'node:test';
import assert from 'node:assert/strict';
import {
  RETIREMENT_FENCE_KEY, FENCED_OPERATIONS, validateRetirementTarget,
  validateRetiredFenceRecord, inspectRetirementOperation,
  proposeRetirementTombstone,
} from '../src/relay-retirement-fence-policy.js';

const target = Object.freeze({
  worker_id: 'android-worker-a',
  repo: 'jan2xo/bke-worker',
  pr_number: 90,
  expected_head_sha: 'd80f5272e90677558fb1311a94772c8991f03b8f',
});
const proposal = {
  target, persisted_fence: undefined,
  retirement_id: 'operator-approved-candidate-only',
  created_at_ms: 1792500000000,
};
const candidate = proposeRetirementTombstone(proposal).candidate;
const NEGATIVE = Object.freeze({
  authority: 'NONE',
  can_commit: false,
  can_dispatch: false,
  can_reconnect: false,
  can_release_assignment: false,
  can_reuse_worker_id: false,
  delivery_ack_proven: false,
  delivery_fenced: false,
  atomic_commit_proven: false,
  credential_revocation_proven: false,
});
function assertDeny(result) {
  assert.equal(result.state === 'BLOCKED' || result.state === 'RETIRED_BLOCKED' ||
    result.state === 'PROPOSAL_ONLY', true);
  for (const [key, value] of Object.entries(NEGATIVE)) {
    assert.equal(Object.hasOwn(result, key), true, 'missing '+key);
    assert.equal(result[key], value, key);
  }
  assert.equal(Object.isFrozen(result), true);
}
test('policy stays a separate source-only immutable contract', () => {
  assert.equal(RETIREMENT_FENCE_KEY, 'retirement_fence_v1');
  assert.equal(Object.isFrozen(FENCED_OPERATIONS), true);
  assert.equal(FENCED_OPERATIONS.length, 9);
  assert.equal(new Set(FENCED_OPERATIONS).size, 9);
});
test('validated target binds exact worker repo PR and head', () => {
  assert.equal(validateRetirementTarget(target), true);
  for (const change of [
    {worker_id: 'BAD-ID'}, {repo: 'attacker/repo'}, {pr_number: -1},
    {expected_head_sha: 'z'.repeat(40)}, {pr_number: Number.MAX_SAFE_INTEGER+1},
  ]) assert.equal(validateRetirementTarget({...target,...change}), false);
  for (const key of Object.keys(target)) {
    const x = {...target};delete x[key];
    assert.equal(validateRetirementTarget(x), false, 'missing '+key);
  }
  assert.equal(validateRetirementTarget({...target, extra: 'untrusted'}), false);
});
test('pure proposal is explicitly non-authoritative and never commits', () => {
  const r = proposeRetirementTombstone(proposal);
  assert.equal(r.state, 'PROPOSAL_ONLY');
  assert.equal(r.code, 'OWNER_AUTH_AND_ATOMIC_DO_CAS_REQUIRED');
  assertDeny(r);
  assert.equal(validateRetiredFenceRecord(r.candidate), true);
  assert.equal(Object.isFrozen(r.candidate), true);
  assert.deepEqual(Object.keys(r.candidate).sort(), [
    'schema_version','status','worker_id','repo','pr_number',
    'expected_head_sha','retirement_id','epoch','created_at_ms',
  ].sort());
  assert.equal(JSON.stringify(r).includes('token'), false);
});
test('no client-supplied privilege or ambient authority field accepted', () => {
  for(const change of [
    {owner_approved: true}, {authenticated: true}, {can_commit: true},
    {allow: true}, {admin_token: 'SECRET'}, {worker_id: target.worker_id},
  ]) {
    const r=proposeRetirementTombstone({...proposal,...change});
    assert.equal(r.code,'PROPOSAL_INVALID');
    assertDeny(r);
  }
});
test('all possible malformed proposal decisions are denied', () => {
  for (const request of [
    null, {}, {...proposal, created_at_ms: 0},
    {...proposal, created_at_ms: Infinity},
    {...proposal, retirement_id:'bad space'},
    {...proposal, retirement_id:''},
    {...proposal, retirement_id:'a'.repeat(129)},
    {...proposal, target: {...target,repo:'other/repo'}},
    {...proposal, persisted_fence:null},
  ]) {
    const r=proposeRetirementTombstone(request);
    assert.equal(r.state,'BLOCKED');
    assertDeny(r);
  }
});
test('repeated or cross-target proposals never overwrite existing fence', () => {
  const repeated=proposeRetirementTombstone({...proposal,persisted_fence:candidate});
  assert.equal(repeated.code,'ALREADY_FENCED_REQUIRES_AUTHORITATIVE_READBACK');
  assertDeny(repeated);
  const conflicting=proposeRetirementTombstone({
    ...proposal,persisted_fence:{...candidate,pr_number:91},
  });
  assert.equal(conflicting.code,'EXISTING_FENCE_TARGET_MISMATCH');
  assertDeny(conflicting);
  assert.equal(proposeRetirementTombstone({
    ...proposal,persisted_fence:{...candidate,epoch:0},
  }).code,'EXISTING_FENCE_MALFORMED');
});
test('tombstone schema rejects missing extra and invalid persisted fields', () => {
  assert.equal(validateRetiredFenceRecord(candidate),true);
  for (const k of Object.keys(candidate)) {
    const altered={...candidate};delete altered[k];
    assert.equal(validateRetiredFenceRecord(altered),false,k);
  }
  for (const change of [
    {schema_version:2}, {status:'active'}, {worker_id:'other@bad'},
    {repo:'untrusted/repo'}, {pr_number:0},
    {expected_head_sha:'a'.repeat(39)}, {retirement_id:'contains spaces'},
    {epoch:0}, {epoch:1.1}, {created_at_ms:0},
    {created_at_ms:Number.MAX_SAFE_INTEGER+1}, {extra:'private'},
  ]) assert.equal(validateRetiredFenceRecord({...candidate,...change}),false,JSON.stringify(change));
});
test('all nine relay and socket operations are denied for retired identity', () => {
  for (const op of FENCED_OPERATIONS) {
    const r=inspectRetirementOperation(candidate,target,op);
    assert.equal(r.state,'RETIRED_BLOCKED',op);
    assert.equal(r.code,'WORKER_RETIRED',op);
    assert.equal(r.operation,op);
    assertDeny(r);
  }
});
test('missing tombstone never implies safe dispatch, pairing or reuse', () => {
  for (const op of FENCED_OPERATIONS) {
    const r=inspectRetirementOperation(undefined,target,op);
    assert.equal(r.code,'FENCE_ABSENT_UNVERIFIED');
    assertDeny(r);
  }
});
test('wrong target or a malformed persisted tombstone fails closed', () => {
  const cases=[
    [candidate,{...target,pr_number:91},'FENCE_TARGET_MISMATCH'],
    [candidate,{...target,repo:'jan2xo/bke-demo-app'},'FENCE_TARGET_MISMATCH'],
    [candidate,{...target,expected_head_sha:'f'.repeat(40)},'FENCE_TARGET_MISMATCH'],
    [candidate,{...target,worker_id:'different-worker'},'FENCE_TARGET_MISMATCH'],
    [{...candidate,epoch:0},target,'FENCE_MALFORMED'],
    [null,target,'FENCE_MALFORMED'],
    [candidate,{...target,worker_id:'BAD_WORKER'},'TARGET_INVALID'],
  ];
  for(const [f,t,error] of cases){
    const r=inspectRetirementOperation(f,t,'dispatch');
    assert.equal(r.code,error);
    assertDeny(r);
  }
});
test('unknown operation is never assumed harmless', () => {
  for(const op of ['manual-wake','unknown','',null,undefined]) {
    const r=inspectRetirementOperation(candidate,target,op);
    assert.equal(r.code,'OPERATION_UNKNOWN');
    assertDeny(r);
  }
});
test('read-only pure functions cannot call storage or mutate input state', () => {
  const before=JSON.stringify(candidate);
  const result=inspectRetirementOperation(candidate,target,'promote');
  assertDeny(result);
  assert.equal(JSON.stringify(candidate),before);
  assert.equal(candidate.status,'retired');
});
test('all blocked results expose stable exact negative proof shape', () => {
  for(const x of [
    proposeRetirementTombstone({}),
    inspectRetirementOperation(undefined,target,'connect'),
    inspectRetirementOperation({...candidate,epoch:0},target,'ack'),
    inspectRetirementOperation(candidate,{...target,pr_number:91},'send'),
  ]) {
    assertDeny(x);
    assert.deepEqual(Object.keys(x).sort(),
      ['state','code',...Object.keys(NEGATIVE)].sort());
  }
});
