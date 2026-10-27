import test from 'node:test';
import assert from 'node:assert/strict';
import {claimSendOnce} from '../dist/send-once-claim.js';

const HEAD = 'a'.repeat(40);
const NEXT = 'b'.repeat(40);
const request = () => ({repository:'jan2xo/bke-worker',prNumber:123,
  headSha:HEAD,attemptId:'attempt-one',workerId:'worker-f1'});

class FakeGitHub {
  refs = new Map();
  writes = 0;
  failAfterCommit = false;
  failReadback = false;
  authority = {repository:'jan2xo/bke-worker',installationRepository:'jan2xo/bke-worker',
    installationAuthenticated:true,prNumber:123,prOpen:true,headSha:HEAD,
    attemptId:'attempt-one',assignedWorkerId:'worker-f1',
    authenticatedWorkerId:'worker-f1',activeWorkerPrCount:1,prWorkerCount:1};
  async readAuthority() { return {...this.authority}; }
  async readRef(ref) { if (this.failReadback) throw Error('connection down');
    return this.refs.get(ref) ?? null; }
  async createRefIfAbsent(ref, sha) {
    this.writes++;
    if (this.refs.has(ref)) return 'EXISTS';
    this.refs.set(ref, sha);
    if (this.failAfterCommit) throw Error('response lost after remote write');
    return 'CREATED';
  }
}
const code = async (gh, req=request()) => (await claimSendOnce(gh,req)).code;

test('first exclusive claim records one ref at exact head; no send authority', async () => {
  const gh=new FakeGitHub(), out=await claimSendOnce(gh,request());
  assert.deepEqual(out,{code:'CLAIM_RECORDED',authority:'NONE',
    ref:'refs/bke/claims/123/attempt-one'});
  assert.equal(gh.refs.get(out.ref),HEAD);assert.equal(gh.writes,1);
});
test('sequential double-claim never writes twice',async()=>{
  const gh=new FakeGitHub();assert.equal(await code(gh),'CLAIM_RECORDED');
  assert.equal(await code(gh),'CLAIM_ALREADY_EXISTS');assert.equal(gh.writes,1);
});
test('concurrent sibling double-claim has exactly one winner',async()=>{
  const gh=new FakeGitHub();const result=await Promise.all([code(gh),code(gh)]);
  assert.deepEqual(result.sort(),['CLAIM_CONFLICT','CLAIM_RECORDED']);
  assert.equal(gh.refs.size,1);
});
test('lost write response stays quarantined, even with committed ref',async()=>{
  const gh=new FakeGitHub();gh.failAfterCommit=true;
  assert.equal(await code(gh),'WRITE_UNCERTAIN');
  assert.equal(gh.refs.size,1);
  assert.equal(await code(gh),'CLAIM_ALREADY_EXISTS');assert.equal(gh.writes,1);
});
test('changed head before claim writes nothing',async()=>{
  const gh=new FakeGitHub();gh.authority.headSha=NEXT;
  assert.equal(await code(gh),'STALE_HEAD');assert.equal(gh.writes,0);
});
test('head changes between commit and read-back: no permission to send',async()=>{
  const gh=new FakeGitHub();const original=gh.createRefIfAbsent.bind(gh);
  gh.createRefIfAbsent=async (...args)=>{const x=await original(...args);
    gh.authority.headSha=NEXT;return x;};
  assert.equal(await code(gh),'STALE_HEAD');assert.equal(gh.writes,1);
});
test('wrong worker, unauthenticated, scope mismatch and duplicate assignment block',async()=>{
  for (const delta of [{assignedWorkerId:'other'},{authenticatedWorkerId:'other'},
    {installationAuthenticated:false},{installationRepository:'other/repo'},
    {activeWorkerPrCount:2},{prWorkerCount:2},{prOpen:false}]) {
    const gh=new FakeGitHub();Object.assign(gh.authority,delta);
    assert.equal(await code(gh),'WRONG_WORKER_OR_SCOPE');assert.equal(gh.writes,0);
  }
});
test('attempt mismatch blocks and prevents ref creation',async()=>{
  const gh=new FakeGitHub();gh.authority.attemptId='another-attempt';
  assert.equal(await code(gh),'ATTEMPT_NOT_ACTIVE');assert.equal(gh.writes,0);
});
test('bad request identifiers fail without GitHub writes',async()=>{
  for(const delta of [{attemptId:'../inject'},{workerId:'CAPITAL'},
    {prNumber:0},{headSha:'short'},{repository:'wrong'}]){
    const gh=new FakeGitHub();assert.equal(await code(gh,{...request(),...delta}),'INVALID_INPUT');
    assert.equal(gh.writes,0);
  }
});
test('read-back ref differs from pinned head, claim remains consumed',async()=>{
  const gh=new FakeGitHub();const original=gh.createRefIfAbsent.bind(gh);
  gh.createRefIfAbsent=async (ref,sha)=>{const result=await original(ref,sha);
    gh.refs.set(ref,NEXT);return result;};
  assert.equal(await code(gh),'READBACK_MISMATCH');assert.equal(gh.writes,1);
});
test('read-back outage never confirms and never retries',async()=>{
  const gh=new FakeGitHub();const original=gh.createRefIfAbsent.bind(gh);
  gh.createRefIfAbsent=async (...args)=>{const x=await original(...args);
    gh.failReadback=true;return x;};
  assert.equal(await code(gh),'READ_UNCERTAIN');assert.equal(gh.writes,1);
});
test('initial GitHub reader outage is not absence',async()=>{
  const gh=new FakeGitHub();gh.readRef=async()=>{throw Error('404 or outage unknown');};
  assert.equal(await code(gh),'READ_UNCERTAIN');assert.equal(gh.writes,0);
});
