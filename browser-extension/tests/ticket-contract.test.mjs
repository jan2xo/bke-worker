import test from 'node:test';
import assert from 'node:assert/strict';
import {TICKET_CONTRACT_VERSION, validateTicketInventory} from '../dist/ticket-contract.js';

const HEAD = 'a'.repeat(40);
const nowMs = 1793130000000;
const context = () => ({
  pinnedApp: {id: 412345, slug: 'bke-dispatcher'}, currentHead: HEAD,
  workerId: 'f1-worker', nowMs, consumedAttemptIds: new Set(),
});
const run = (delta = {}) => ({
  id: 19, name: 'bke-ticket',
  app: {id: 412345, slug: 'bke-dispatcher'},
  head_sha: HEAD, status: 'completed', conclusion: 'success',
  external_id: 'bke-ticket:v1:f1-worker:attempt-1:' +
    Math.floor(nowMs / 1000 + 120), ...delta,
});
const decide = (items, c=context()) => validateTicketInventory(items, c);

test('v1 accepts one exact app+head+worker unexpired unconsumed ticket', () => {
  assert.equal(TICKET_CONTRACT_VERSION, 1);
  const result=decide([run()]);
  assert.deepEqual(result, {code:'VALID',authority:'NONE',ticket:{
    contractVersion:1,checkRunId:19,ticketId:'check-run:19',
    attemptId:'attempt-1',workerId:'f1-worker',
    expiresAtMs:nowMs+120000,headSha:HEAD,
  }});
});
test('rejects github-actions even if all ticket text appears correct', () => {
  assert.equal(decide([run({app:{id:15368,slug:'github-actions'}})]).code,'INVALID');
  const c=context();c.pinnedApp={id:15368,slug:'github-actions'};
  assert.equal(decide([run({app:{id:15368,slug:'github-actions'}})],c).code,'INVALID');
});
test('app id AND slug pinned; never either alone', () => {
  for (const app of [{id:412345,slug:'other'},{id:22,slug:'bke-dispatcher'},null,{}])
    assert.equal(decide([run({app})]).code,'INVALID');
});
test('exact head and completed success checks required', () => {
  for (const delta of [
    {head_sha:'b'.repeat(40)},{status:'queued'},
    {conclusion:'failure'},{name:'MVP scope gate'},
  ]) assert.equal(decide([run(delta)]).code,'INVALID');
});
test('missing or malformed fields fail closed', () => {
  for(const key of ['id','name','app','head_sha','status','conclusion','external_id']){
    const r=run();delete r[key];assert.equal(decide([r]).code,'INVALID');
  }
  assert.equal(decide([run({id:0})]).code,'INVALID');
});
test('expired, wrong worker, wrong version and malformed attempt reject', () => {
  for (const external_id of [
    'bke-ticket:v1:f1-worker:attempt-1:'+Math.floor(nowMs/1000),
    'bke-ticket:v1:another:attempt-1:'+Math.floor(nowMs/1000+120),
    'bke-ticket:v2:f1-worker:attempt-1:'+Math.floor(nowMs/1000+120),
    'bke-ticket:v1:f1-worker:../bad:'+Math.floor(nowMs/1000+120),
  ]) assert.equal(decide([run({external_id})]).code,'INVALID');
});
test('already consumed attempt is not available', () => {
  const c=context();c.consumedAttemptIds.add('attempt-1');
  assert.equal(decide([run()],c).code,'INVALID');
});
test('multiple valid unconsumed tickets are AMBIGUOUS rather than newest wins', () => {
  assert.equal(decide([run(),run({id:20})]).code,'AMBIGUOUS');
  assert.equal(decide([run({app:{id:1,slug:'evil'}}),run()]).code,'VALID');
});
test('missing context, malformed snapshot, and no tickets reject', () => {
  assert.equal(decide([]).code,'INVALID');
  assert.equal(decide(null).code,'INVALID');
  const c=context();c.currentHead='wrong';
  assert.equal(decide([run()],c).code,'INVALID');
});
