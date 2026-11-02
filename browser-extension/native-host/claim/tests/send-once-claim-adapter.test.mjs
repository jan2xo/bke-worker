import test from 'node:test';
import assert from 'node:assert/strict';
import {GitHubSendOnceRestAdapter} from '../dist/native-host/claim/send-once-claim-adapter.js';

const SHA = 'a'.repeat(40), OTHER = 'b'.repeat(40), TOKEN = 'super-secret-token-never-log';
const request = {repository:'jan2xo/bke-worker',prNumber:123,headSha:SHA,
  workerId:'worker-f1',attemptId:'attempt-one'};
const REF = 'refs/bke/claims/123/attempt-one';
const proof = {installationRepository:request.repository,installationAuthenticated:true,
  authenticatedWorkerId:request.workerId,activeWorkerPrCount:1,currentAttemptId:request.attemptId};
const pull = {number:123,state:'open',head:{sha:SHA},
  labels:[{name:'bke-worker:worker-f1'}]};
const response = (status, body) => ({status,json:async()=>body});
function fixture(steps=[], external=proof) {
  const requests = [], queue = [...steps];
  const fetch = async (url, init) => {
    requests.push({url,init});
    const action = queue.shift();
    if (!action) throw Error('unexpected request ' + TOKEN);
    if (action instanceof Error) throw action;
    return action;
  };
  return {adapter:new GitHubSendOnceRestAdapter(request,fetch,async()=>TOKEN,external),requests,queue};
}
const claimReceipt = response(201,{ref:REF,object:{sha:SHA}});
const pullOk = response(200,pull);
const repoOk = response(200,{full_name:request.repository});
const refOk = response(200,{ref:REF,object:{sha:SHA}});
const missing = response(404,{message:'Not Found'});

async function throwsCode(fn, expected) {
  await assert.rejects(fn, e => {
    assert.equal(e.message, expected);
    assert.equal(e.message.includes(TOKEN),false);
    return true;
  });
}

test('201 means CREATED after exact receipt and explicit authority proof',async()=>{
  const f=fixture([pullOk,claimReceipt]);
  assert.equal((await f.adapter.readAuthority()).assignedWorkerId,'worker-f1');
  assert.equal(await f.adapter.createRefIfAbsent(REF,SHA),'CREATED');
  assert.deepEqual(f.requests.map(r=>new URL(r.url).pathname),
    ['/repos/jan2xo/bke-worker/pulls/123','/repos/jan2xo/bke-worker/git/refs']);
  assert.equal(f.requests[1].init.method,'POST');
  assert.deepEqual(JSON.parse(f.requests[1].init.body),{ref:REF,sha:SHA});
});
test('422 exact Reference already exists means EXISTS',async()=>{
  const f=fixture([pullOk,response(422,{message:'Reference already exists'})]);
  await f.adapter.readAuthority();
  assert.equal(await f.adapter.createRefIfAbsent(REF,SHA),'EXISTS');
});
test('422 bad SHA is NOT existence, throws',async()=>{
  const f=fixture([pullOk,response(422,{message:'Validation Failed',errors:[{code:'invalid'}]})]);
  await f.adapter.readAuthority();
  await throwsCode(()=>f.adapter.createRefIfAbsent(REF,SHA),'GITHUB_REF_VALIDATION_FAILED');
});
test('422 malformed JSON throws rather than treating as EXISTS',async()=>{
  const f=fixture([pullOk,{status:422,json:async()=>{throw Error(TOKEN);}}]);
  await f.adapter.readAuthority();
  await throwsCode(()=>f.adapter.createRefIfAbsent(REF,SHA),'GITHUB_RESPONSE_INVALID');
});
test('404 BEFORE access proof throws and cannot look like unclaimed',async()=>{
  const f=fixture([missing]);
  await throwsCode(()=>f.adapter.readRef(REF),'GITHUB_REF_404_ACCESS_UNPROVEN');
});
test('404 AFTER valid readAuthority is genuinely absent',async()=>{
  const f=fixture([pullOk,missing]);
  await f.adapter.readAuthority();assert.equal(await f.adapter.readRef(REF),null);
});
test('404 AFTER explicit GET repository proof is absent',async()=>{
  const f=fixture([repoOk,missing]);
  await f.adapter.proveRepositoryAccess();assert.equal(await f.adapter.readRef(REF),null);
});
test('GET repository 404/identity mismatch cannot prove access',async()=>{
  const a=fixture([missing]);
  await throwsCode(()=>a.adapter.proveRepositoryAccess(),'GITHUB_REPOSITORY_ACCESS_NOT_PROVEN');
  const b=fixture([response(200,{full_name:'other/repo'})]);
  await throwsCode(()=>b.adapter.proveRepositoryAccess(),'GITHUB_REPOSITORY_MISMATCH');
});
test('200 readRef requires correct path, ref identity, valid SHA',async()=>{
  const a=fixture([pullOk,refOk]);await a.adapter.readAuthority();
  assert.equal(await a.adapter.readRef(REF),SHA);
  assert.equal(a.requests[1].url.endsWith('/git/ref/bke/claims/123/attempt-one'),true);
  const b=fixture([pullOk,response(200,{ref:REF,object:{sha:'bad'}})]);
  await b.adapter.readAuthority();
  await throwsCode(()=>b.adapter.readRef(REF),'GITHUB_SHA_INVALID');
});
test('403 and 500 readRef and POST throw; 404 POST also throws',async()=>{
  for(const status of [403,500]) {
    const f=fixture([pullOk,response(status,{message:TOKEN})]);
    await f.adapter.readAuthority();
    await throwsCode(()=>f.adapter.readRef(REF),'GITHUB_REF_READ_FAILED');
  }
  for(const status of [403,404,500]) {
    const f=fixture([pullOk,response(status,{message:TOKEN})]);
    await f.adapter.readAuthority();
    await throwsCode(()=>f.adapter.createRefIfAbsent(REF,SHA),'GITHUB_REF_WRITE_FAILED');
  }
});
test('fetch timeout/network exception sanitized (no token in thrown error)',async()=>{
  const f=fixture([pullOk,Error(TOKEN+' socket timeout')]);
  await f.adapter.readAuthority();
  await throwsCode(()=>f.adapter.createRefIfAbsent(REF,SHA),'GITHUB_TRANSPORT_UNCERTAIN');
});
test('injected token-provider failure is sanitized',async()=>{
  const adapter=new GitHubSendOnceRestAdapter(request,async()=>{throw Error('should not fetch');},
    async()=>{throw Error(TOKEN+' invalid');},proof);
  await throwsCode(()=>adapter.readAuthority(),'GITHUB_AUTH_UNAVAILABLE');
});
test('malformed 201 JSON cannot confirm a write',async()=>{
  const f=fixture([pullOk,{status:201,json:async()=>{throw Error(TOKEN)}}]);
  await f.adapter.readAuthority();
  await throwsCode(()=>f.adapter.createRefIfAbsent(REF,SHA),'GITHUB_RESPONSE_INVALID');
});
test('malformed pull JSON and missing/duplicate worker labels fail closed',async()=>{
  for (const item of [{}, {...pull,labels:[]},
    {...pull,labels:[{name:'bke-worker:worker-f1'},{name:'bke-worker:other'}]}]) {
    const f=fixture([response(200,item)]);
    await assert.rejects(()=>f.adapter.readAuthority(),e=>{
      assert.equal(e.message.includes(TOKEN),false);return true;});
  }
});
test('missing external installation/worker/attempt evidence never fabricated',async()=>{
  for (const p of [{},{...proof,activeWorkerPrCount:undefined},
    {...proof,installationAuthenticated:false},{...proof,currentAttemptId:undefined}]) {
    const f=fixture([pullOk],p);
    await throwsCode(()=>f.adapter.readAuthority(),'GITHUB_EXTERNAL_AUTHORITY_REQUIRED');
  }
});
test('wrong claim ref or SHA cannot escape PR attempt scope',async()=>{
  const f=fixture([pullOk]);await f.adapter.readAuthority();
  await throwsCode(()=>f.adapter.createRefIfAbsent('refs/heads/main',SHA),'GITHUB_REF_WRITE_NOT_AUTHORIZED');
  await throwsCode(()=>f.adapter.createRefIfAbsent(REF,OTHER),'GITHUB_REF_WRITE_NOT_AUTHORIZED');
  await throwsCode(()=>f.adapter.readRef('refs/heads/main'),'GITHUB_REF_OUT_OF_SCOPE');
  assert.equal(f.requests.length,1);
});

test('repository access alone permits missing-ref read, never a claim write',async()=>{
  const f=fixture([repoOk,missing]);
  await f.adapter.proveRepositoryAccess();
  assert.equal(await f.adapter.readRef(REF),null);
  await throwsCode(()=>f.adapter.createRefIfAbsent(REF,SHA),'GITHUB_REF_WRITE_NOT_AUTHORIZED');
  assert.equal(f.requests.length,2);
});
test('stale head and mismatched owner cannot authorize direct REST writes',async()=>{
  for(const delta of [
    {head:{sha:OTHER}},
    {labels:[{name:'bke-worker:other-worker'}]},
    {state:'closed'},
  ]) {
    const f=fixture([response(200,{...pull,...delta})]);
    await f.adapter.readAuthority();
    await throwsCode(()=>f.adapter.createRefIfAbsent(REF,SHA),'GITHUB_REF_WRITE_NOT_AUTHORIZED');
    assert.equal(f.requests.length,1);
  }
});
test('lost POST response consumes adapter attempt without a second HTTP POST',async()=>{
  const f=fixture([pullOk,Error(TOKEN+' timeout')]);
  await f.adapter.readAuthority();
  await throwsCode(()=>f.adapter.createRefIfAbsent(REF,SHA),'GITHUB_TRANSPORT_UNCERTAIN');
  await throwsCode(()=>f.adapter.createRefIfAbsent(REF,SHA),'GITHUB_REF_WRITE_NOT_AUTHORIZED');
  assert.deepEqual(f.requests.map(x=>x.init.method),['GET','POST']);
});
test('failed authority refresh revokes previous write eligibility',async()=>{
  const f=fixture([pullOk,response(403,{message:TOKEN})]);
  await f.adapter.readAuthority();
  await throwsCode(()=>f.adapter.readAuthority(),'GITHUB_PR_READ_FAILED');
  await throwsCode(()=>f.adapter.createRefIfAbsent(REF,SHA),'GITHUB_REF_WRITE_NOT_AUTHORIZED');
  assert.deepEqual(f.requests.map(x=>x.init.method),['GET','GET']);
});

test('GET timeout aborts and stays GITHUB_TRANSPORT_UNCERTAIN',async()=>{
  const seen = [];
  const fetch = async (url,init) => {
    seen.push(init);
    return new Promise((_ok,reject)=>{
      init.signal.addEventListener('abort',()=>reject(Error(TOKEN)),{once:true});
    });
  };
  const a = new GitHubSendOnceRestAdapter(request,fetch,async()=>TOKEN,proof,20);
  await throwsCode(()=>a.readAuthority(),'GITHUB_TRANSPORT_UNCERTAIN');
  assert.equal(seen.length,1);
  assert.equal(seen[0].signal.aborted,true);
});
test('POST timeout consumes one attempt and cannot trigger a second POST',async()=>{
  const seen = [];
  const fetch = async (_url,init) => {
    seen.push(init);
    if (init.method === 'GET') return pullOk;
    return new Promise((_ok,reject)=>{
      init.signal.addEventListener('abort',()=>reject(Error(TOKEN)),{once:true});
    });
  };
  const a = new GitHubSendOnceRestAdapter(request,fetch,async()=>TOKEN,proof,20);
  await a.readAuthority();
  await throwsCode(()=>a.createRefIfAbsent(REF,SHA),'GITHUB_TRANSPORT_UNCERTAIN');
  await throwsCode(()=>a.createRefIfAbsent(REF,SHA),'GITHUB_REF_WRITE_NOT_AUTHORIZED');
  assert.equal(seen.filter(x=>x.method==='POST').length,1);
  assert.equal(seen[1].signal.aborted,true);
});
test('slow successful JSON body is bounded by the same request deadline',async()=>{
  const fetch = async (_url,init) => ({status:200,json:()=>new Promise((_ok,reject)=>{
    init.signal.addEventListener('abort',()=>reject(Error(TOKEN)),{once:true});
  })});
  const a = new GitHubSendOnceRestAdapter(request,fetch,async()=>TOKEN,proof,20);
  await throwsCode(()=>a.readAuthority(),'GITHUB_TRANSPORT_UNCERTAIN');
});
test('invalid deadline fails before any HTTP call',async()=>{
  assert.throws(()=>new GitHubSendOnceRestAdapter(request,async()=>pullOk,async()=>TOKEN,proof,Infinity),
    /GITHUB_DEADLINE_INVALID/);
});

test('hanging token provider obeys deadline and cannot issue a late POST',async()=>{
  let resolveToken;
  const delayedToken = new Promise(resolve=>{resolveToken=resolve;});
  const requests = [];
  const fetch = async (_url,init)=>{requests.push(init);return claimReceipt;};
  const a = new GitHubSendOnceRestAdapter(request,fetch,async()=>delayedToken,proof,20);
  await throwsCode(()=>a.readAuthority(),'GITHUB_TRANSPORT_UNCERTAIN');
  resolveToken(TOKEN);
  await new Promise(resolve=>setImmediate(resolve));
  assert.equal(requests.length,0);
});
