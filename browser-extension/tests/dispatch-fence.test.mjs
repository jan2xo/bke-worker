import test from 'node:test';
import assert from 'node:assert/strict';
import {DispatchFence} from '../dist/dispatch-fence.js';
const head='a'.repeat(40);
const request=(delta={})=>({prNumber:123,attemptId:'attempt-1',headSha:head,...delta});
const claim=(delta={})=>({code:'CREATED',prNumber:123,attemptId:'attempt-1',
  headSha:head,ref:'refs/bke/claims/123/attempt-1',...delta});
class Registry {
  used=new Set(); error=false;
  consumeOnce(id) {
    if(this.error) throw Error('durability uncertain');
    if(this.used.has(id)) return false;
    this.used.add(id); return true;
  }
}
const fixture=()=>{const registry=new Registry();const fence=new DispatchFence(registry);
  let clicks=0;const port={clickOnce:async()=>{clicks++;}};
  return {fence,registry,port,count:()=>clicks};};
test('one CREATED exact claim gets exactly one port attempt, never a delivery receipt',async()=>{
  const x=fixture();
  assert.deepEqual(await x.fence.attempt(request(),claim(),x.port),
    {code:'ATTEMPTED',authority:'NONE'});
  assert.equal(x.count(),1);
  assert.equal((await x.fence.attempt(request(),claim(),x.port)).code,'ABORT');
  assert.equal(x.count(),1);
});
test('EXISTS, errors, timeout and mismatched claim refuse click permanently',async()=>{
 for (const bad of [{code:'EXISTS'},{code:'TIMEOUT'},{code:'ERROR'},
   {code:'CLAIM_RECORDED'},{attemptId:'other'},
   {headSha:'b'.repeat(40)},{prNumber:122},{ref:'refs/bke/claims/1/wrong'}]){
   const x=fixture();assert.equal((await x.fence.attempt(request(),claim(bad),x.port)).code,'ABORT');
   assert.equal(x.count(),0);
   assert.equal((await x.fence.attempt(request(),claim(),x.port)).code,'ABORT');
 }
});
test('two concurrent attempts never click simultaneously',async()=>{
 const x=fixture();let release;
 const hold=new Promise(r=>{release=r;});
 const port={clickOnce:async()=>{x.port.clickOnce();await hold;}};
 const first=x.fence.attempt(request(),claim(),port);
 const second=await x.fence.attempt(request({attemptId:'attempt-2'}),
   claim({attemptId:'attempt-2',ref:'refs/bke/claims/123/attempt-2'}),port);
 assert.equal(second.code,'ABORT');assert.equal(second.reason,'BUSY');
 release();assert.equal((await first).code,'ATTEMPTED');
 assert.equal(x.count(),1);assert.equal(x.registry.used.has('attempt-2'),true);
});
test('shared durable registry denies replay after process restart',async()=>{
 const registry=new Registry();let clicks=0;
 const port={clickOnce:async()=>{clicks++;}};
 assert.equal((await new DispatchFence(registry).attempt(request(),claim(),port)).code,'ATTEMPTED');
 assert.equal((await new DispatchFence(registry).attempt(request(),claim(),port)).code,'ABORT');
 assert.equal(clicks,1);
});
test('unknown registry outcome aborts before click',async()=>{
 const x=fixture();x.registry.error=true;
 const r=await x.fence.attempt(request(),claim(),x.port);
 assert.deepEqual(r,{code:'ABORT',authority:'NONE',reason:'CONSUMPTION_UNCERTAIN'});
 assert.equal(x.count(),0);
});
test('port failure quarantines consumed attempt without retry',async()=>{
 const x=fixture();const port={clickOnce:async()=>{throw Error('timeout after click?');}};
 const r=await x.fence.attempt(request(),claim(),port);
 assert.equal(r.reason,'CLICK_UNCERTAIN');
 assert.equal((await x.fence.attempt(request(),claim(),x.port)).code,'ABORT');
 assert.equal(x.count(),0);assert.equal(x.registry.used.has('attempt-1'),true);
});
test('bad input cannot invoke a click',async()=>{
 const x=fixture();
 for(const a of [request({attemptId:'../bad'}),request({headSha:'short'}),request({prNumber:0})])
   assert.equal((await x.fence.attempt(a,claim(),x.port)).code,'ABORT');
 assert.equal(x.count(),0);
});
