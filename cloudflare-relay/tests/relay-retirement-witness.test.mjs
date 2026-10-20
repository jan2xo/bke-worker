import test from 'node:test';
import assert from 'node:assert/strict';
import {readRelayRetirementWitness as witness} from '../src/relay-retirement-witness.js';
const worker_id = 'android-worker-a';
const expected_head_sha = 'd80f5272e90677558fb1311a94772c8991f03b8f';
const pr_number = 90;
const delivery = 'ecba94d0-cc65-11f1-81c0-1201344291e7';
const context = {worker_id, pr_number, expected_head_sha};
const wake = {worker_id, pr_number, expected_head_sha, delivery_id: delivery, secret: 'NEVER_EXPOSE'};
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
  assert.equal(JSON.stringify(result).includes('NEVER_EXPOSE'), false);
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
  for (const other of [{...context, pr_number: 91}, {...context, expected_head_sha: 'a'.repeat(40)}]) {
    assert.equal((await witness(storage(), other)).code, 'WAKE_CONTEXT_MISMATCH');
  }
});
test('denies invalid caller context, absent storage and read failures', async () => {
  assert.equal((await witness(storage(), {...context, worker_id: 'WRONG'})).code, 'EXPECTED_CONTEXT_INVALID');
  assert.equal((await witness({}, context)).code, 'STORAGE_NOT_TRUSTED');
  assert.equal((await witness({get: async () => {throw Error('offline');}}, context)).code, 'STORAGE_READ_FAILED');
});
test('denies malformed phase, wake and queued metadata', async () => {
  assert.equal((await witness(storage({...state, active_wake: {wake, phase: 'completed'}}), context)).code, 'ACTIVE_PHASE_MALFORMED');
  assert.equal((await witness(storage({...state, active_wake: {wake: {...wake, delivery_id: 'bad'}, phase: 'queued'}}), context)).code, 'ACTIVE_WAKE_MALFORMED');
  assert.equal((await witness(storage({...state, queued_wake: {...wake, pr_number: 91}}), context)).code, 'WAKE_CONTEXT_MISMATCH');
  assert.equal((await witness(storage({...state, queued_wake: {...wake, worker_id: 'other'}}), context)).code, 'QUEUED_WAKE_MALFORMED');
});
test('exposes socket presence only, never opaque connection id', async () => {
  const result = await witness(storage({...state, active_connection_id: 'private-socket-id'}), context);
  assert.equal(result.registered_connection_present, true);
  assert.equal(JSON.stringify(result).includes('private-socket-id'), false);
});
test('fails closed on malformed connection and recent-delivery state', async () => {
  assert.equal((await witness(storage({...state, active_connection_id: 0}), context)).code, 'CONNECTION_METADATA_MALFORMED');
  assert.equal((await witness(storage({...state, recent_deliveries: ['bad']}), context)).code, 'RECENT_DELIVERIES_MALFORMED');
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
