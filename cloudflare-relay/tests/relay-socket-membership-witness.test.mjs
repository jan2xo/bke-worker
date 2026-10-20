import test from 'node:test';
import assert from 'node:assert/strict';
import {readRelaySocketMembershipWitness as observe} from '../src/relay-socket-membership-witness.js';

const worker_id = 'android-worker-a';
const repo = 'jan2xo/bke-worker';
const pr_number = 90;
const expected_head_sha = 'd80f5272e90677558fb1311a94772c8991f03b8f';
const delivery_id = 'ecba94d0-cc65-11f1-81c0-1201344291e7';
const expected = {worker_id, repo, pr_number, expected_head_sha};
const wake = {
  protocol: 1, type: 'wake', worker_id, repo, pr_number, expected_head_sha,
  reason: 'github_pull_request_continuation', delivery_id,
};
const state = {
  worker_id,
  active_wake: {wake, phase: 'queued'},
  active_connection_id: 'private-connection-id',
  recent_deliveries: [delivery_id],
};

const store = (data = state) => ({
  async get(key) { return data[key]; },
  async put() { throw Error('MUTATION_FORBIDDEN'); },
  async delete() { throw Error('MUTATION_FORBIDDEN'); },
});
const socket = (changes = {}) => ({
  deserializeAttachment() {
    return {workerId: worker_id, connectionId: 'private-connection-id',
      registered: true, sessionId: 'private-session-id', ...changes};
  },
});
const deps = (data = state, sockets = [socket()]) =>
  ({storage: store(data), getWebSockets: () => sockets});

test('matching stored ID and one registered DO socket is a sample, never liveness/retirement', async () => {
  const r = await observe(deps(), expected);
  assert.equal(r.state, 'OBSERVED_ONLY');
  assert.equal(r.active.phase, 'queued');
  assert.equal(r.registered_socket_id_match_observed, true);
  assert.equal(r.socket_collection_sample_size, 1);
  assert.equal(r.socket_sample_atomic, false);
  assert.equal(r.snapshot_atomic, false);
  assert.equal(r.socket_liveness_proven, false);
  assert.equal(r.delivery_ack_proven, false);
  assert.equal(r.delivery_fenced, false);
  assert.equal(r.can_retire, false);
  assert.equal(r.authority, 'NONE');
  assert.equal(JSON.stringify(r).includes('private-connection-id'), false);
  assert.equal(JSON.stringify(r).includes('private-session-id'), false);
});

test('stale stored ID without a matching socket never implies alive or cancelled', async () => {
  const r = await observe(deps(state, []), expected);
  assert.equal(r.state, 'OBSERVED_ONLY');
  assert.equal(r.active_connection_id_present, true);
  assert.equal(r.registered_socket_id_match_observed, false);
  assert.equal(r.delivery_fenced, false);
  assert.equal(r.can_retire, false);
});

test('no stored ID and no registered socket is NOT proof of retirement', async () => {
  const data = {worker_id};
  const r = await observe(deps(data, []), expected);
  assert.equal(r.state, 'OBSERVED_ONLY');
  assert.equal(r.active_connection_id_present, false);
  assert.equal(r.registered_socket_id_match_observed, false);
  assert.equal(r.can_retire, false);
});

test('pending unregistered socket does not establish authoritative pairing', async () => {
  const r = await observe(deps(state, [socket({registered: false, sessionId: null})]), expected);
  assert.equal(r.state, 'OBSERVED_ONLY');
  assert.equal(r.registered_socket_id_match_observed, false);
  assert.equal(r.socket_collection_sample_size, 1);
});

test('registered socket with another ID or absent stored ID fails closed', async () => {
  const bad = await observe(deps(state, [socket({connectionId: 'other-connection'})]), expected);
  assert.equal(bad.code, 'REGISTERED_SOCKET_CONFLICT');
  assert.equal(bad.authority, 'NONE');
  const missing = await observe(deps({worker_id}, [socket()]), expected);
  assert.equal(missing.code, 'REGISTERED_SOCKET_CONFLICT');
});

test('duplicate registered socket with same ID fails closed', async () => {
  const result = await observe(deps(state, [socket(), socket()]), expected);
  assert.equal(result.code, 'DUPLICATE_REGISTERED_SOCKET');
  assert.equal(result.can_retire, false);
});

test('unrelated worker, malformed, leaked, or unattested socket attachment fails closed', async () => {
  const badAttachments = [
    {workerId: 'other-worker'},
    {sessionId: ''},
    {sessionId: null},
    {registered: 'true'},
    {connectionId: ''},
    {extra: 'untrusted'},
    {registered: false, sessionId: 'unexpected'},
  ];
  for (const change of badAttachments) {
    const r = await observe(deps(state, [socket(change)]), expected);
    assert.equal(r.code, 'SOCKET_ATTACHMENT_CONFLICT', JSON.stringify(change));
    assert.equal(r.can_retire, false);
  }
  assert.equal((await observe(deps(state, [{}]), expected)).code, 'SOCKET_ATTACHMENT_UNREADABLE');
  assert.equal((await observe(deps(state, [{deserializeAttachment: () => {throw Error('secret');}}]), expected)).code,
    'SOCKET_ATTACHMENT_UNREADABLE');
});

test('missing and malformed private DO socket providers fail closed', async () => {
  assert.equal((await observe({}, expected)).code, 'DO_CONTEXT_REQUIRED');
  assert.equal((await observe({storage: store(), getWebSockets: null}, expected)).code, 'DO_CONTEXT_REQUIRED');
  assert.equal((await observe({storage: store(), getWebSockets: () => ({})}, expected)).code,
    'SOCKET_COLLECTION_INVALID');
  assert.equal((await observe(deps(state, Array(129).fill(socket())), expected)).code,
    'SOCKET_COLLECTION_INVALID');
  assert.equal((await observe({storage: store(), getWebSockets: () => {throw Error('secret');}}, expected)).code,
    'SOCKET_OBSERVATION_FAILED');
});

test('changed persisted connection ID during observation is a hard blocker', async () => {
  let reads = 0;
  const changing = {
    async get(key) {
      if (key === 'active_connection_id') {
        reads += 1;
        return reads >= 3 ? 'other-id' : 'private-connection-id';
      }
      return state[key];
    },
  };
  const r = await observe({storage: changing, getWebSockets: () => [socket()]}, expected);
  assert.equal(r.code, 'CONNECTION_STATE_CHANGED');
  assert.equal(r.can_retire, false);
});

test('corrupted wake and wrong PR/head/repository propagate earlier fail-closed witness', async () => {
  assert.equal((await observe(deps({...state, active_wake: {wake: {...wake, type: 'register'}, phase: 'queued'}}), expected)).code,
    'ACTIVE_WAKE_MALFORMED');
  assert.equal((await observe(deps(), {...expected, pr_number: 91})).code, 'WAKE_CONTEXT_MISMATCH');
  assert.equal((await observe(deps(), {...expected, repo: 'jan2xo/bke-demo-app'})).code, 'WAKE_CONTEXT_MISMATCH');
  assert.equal((await observe(deps(), {...expected, expected_head_sha: 'a'.repeat(40)})).code,
    'WAKE_CONTEXT_MISMATCH');
});

test('no persisted IDs are ever returned when more than one unregistered socket exists', async () => {
  const r = await observe(deps(state, [
    socket({registered: false, sessionId: null, connectionId: 'private-new-1'}),
    socket({registered: false, sessionId: null, connectionId: 'private-new-2'}),
  ]), expected);
  assert.equal(r.state, 'OBSERVED_ONLY');
  assert.equal(r.registered_socket_id_match_observed, false);
  assert.equal(r.socket_collection_sample_size, 2);
  assert.equal(JSON.stringify(r).includes('private-new'), false);
  assert.equal(r.can_retire, false);
});
