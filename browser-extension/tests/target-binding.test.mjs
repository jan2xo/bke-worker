import test from "node:test";
import assert from "node:assert/strict";
import {createChatGptTargetBinding} from "../dist/target-binding.js";
const EXT="a".repeat(32),KEY="b".repeat(64);
const D1="11111111-1111-4111-8111-111111111111",D2="22222222-2222-4222-8222-222222222222";
const URL="https://chatgpt.com/c/one";
const observed=()=>({protocolVersion:1,observedAt:"2026-11-03T00:00:00Z",
  url:URL,visible:true,composerAvailable:true,turnBusy:false});
const sender=(overrides={})=>({id:EXT,frameId:0,documentLifecycle:"active",
  documentId:D1,url:URL,tab:{id:7,url:URL,incognito:false},...overrides});
function fixture(){
  let tabs=[{id:7,url:URL,incognito:false}],fail=false,failFrame=false;
  let frame={url:URL,documentId:D1,documentLifecycle:"active",
    frameType:"outermost_frame",parentFrameId:-1,errorOccurred:false};
  const binding=createChatGptTargetBinding(async()=>{
    if(fail)throw Error("tab provider offline");
    return tabs;
  },EXT,async tabId=>{
    if(failFrame)throw Error("webNavigation unavailable");
    return tabId===7?frame:null;
  });
  return {binding,setTabs:x=>{tabs=x;},setFrame:x=>{frame=x;},
    fail:()=>{fail=true;},failFrame:()=>{failFrame=true;}};
}
test("owner selects one target; only top-level browser document status is exposed",async()=>{
  const {binding}=fixture();
  assert.equal(await binding.current("worker-a",KEY),null);
  assert.equal((await binding.observe(observed(),sender(),"worker-a",KEY)).code,"TARGET_NOT_SELECTED");
  assert.deepEqual(await binding.select("worker-a",KEY),{
    ok:true,state:"OWNER_TAB_SELECTED_OBSERVATION_ONLY"});
  assert.equal(await binding.current("worker-a",KEY),null);
  assert.deepEqual(await binding.observe(observed(),sender(),"worker-a",KEY),{ok:true});
  assert.deepEqual(await binding.current("worker-a",KEY),observed());
});
test("worker and key changes invalidate; stale workers cannot inherit the bound document",async()=>{
  for(const [worker,key]of [["worker-b",KEY],["worker-a","c".repeat(64)]]){
    const {binding}=fixture();
    await binding.select("worker-a",KEY);
    assert.equal((await binding.observe(observed(),sender(),worker,key)).code,
      "TARGET_OWNER_CHANGED");
    assert.equal(await binding.current("worker-a",KEY),null);
  }
  const {binding}=fixture();
  await binding.select("worker-a",KEY);
  await binding.observe(observed(),sender(),"worker-a",KEY);
  assert.equal(await binding.current("worker-b",KEY),null);
});
test("forged sender origin, cross-frame, prerender and missing document deny status",async()=>{
  const mutations=[
    {id:"foreign-extension"},{frameId:1},{documentLifecycle:"prerender"},
    {documentId:undefined},{documentId:"not-a-uuid"},
    {tab:{id:99,url:URL,incognito:false}},
    {tab:{id:7,url:URL,incognito:true}},
    {url:"https://evil.test/"},{url:"https://chatgpt.com/c/two"},
  ];
  for(const mutation of mutations){
    const {binding}=fixture();await binding.select("worker-a",KEY);
    assert.equal((await binding.observe(observed(),sender(mutation),"worker-a",KEY)).ok,false);
    assert.equal(await binding.current("worker-a",KEY),null);
  }
});
test("document replacement and URL changes revoke instead of silently following a tab",async()=>{
  for(const mutation of [{documentId:D2},{url:"https://chatgpt.com/c/two"}]){
    const {binding}=fixture();await binding.select("worker-a",KEY);
    assert.deepEqual(await binding.observe(observed(),sender(),"worker-a",KEY),{ok:true});
    assert.equal((await binding.observe(observed(),sender(mutation),"worker-a",KEY)).ok,false);
    assert.equal(await binding.current("worker-a",KEY),null);
  }
});
test("duplicate ChatGPT tabs, navigations, closure, incognito and provider failure deny",async()=>{
  const changed=[
    [{id:7,url:URL,incognito:false},{id:8,url:URL,incognito:false}],
    [{id:7,url:"https://chatgpt.com/c/two",incognito:false}],
    [],[{id:7,url:URL,incognito:true}],
  ];
  for(const tabs of changed){
    const f=fixture();await f.binding.select("worker-a",KEY);
    await f.binding.observe(observed(),sender(),"worker-a",KEY);
    f.setTabs(tabs);assert.equal(await f.binding.current("worker-a",KEY),null);
  }
  const f=fixture();await f.binding.select("worker-a",KEY);
  await f.binding.observe(observed(),sender(),"worker-a",KEY);
  f.fail();assert.equal(await f.binding.current("worker-a",KEY),null);
});
test("tab events, config invalidation and new MV3 worker lose selection",async()=>{
  const f=fixture();await f.binding.select("worker-a",KEY);
  await f.binding.observe(observed(),sender(),"worker-a",KEY);
  f.binding.tabChanged(9);
  assert.deepEqual(await f.binding.current("worker-a",KEY),observed());
  f.binding.tabChanged(7);
  assert.equal(await f.binding.current("worker-a",KEY),null);
  await f.binding.select("worker-a",KEY);
  f.binding.invalidate();
  assert.equal(await f.binding.current("worker-a",KEY),null);
  const restarted=createChatGptTargetBinding(async()=>[{id:7,url:URL,incognito:false}],EXT,
    async()=>({url:URL,documentId:D1,documentLifecycle:"active",
      frameType:"outermost_frame",parentFrameId:-1}));
  assert.equal(await restarted.current("worker-a",KEY),null);
});
test("owner selection refuses ambiguous, incognito, foreign or unkeyed target",async()=>{
  const f=fixture();
  assert.equal((await f.binding.select("worker-a","a")).code,"TARGET_OWNER_INVALID");
  assert.equal((await f.binding.select("WORKER-A",KEY)).code,"TARGET_OWNER_INVALID");
  for(const tabs of [[],[{id:7,url:URL,incognito:true}],
    [{id:7,url:"https://other.test/",incognito:false}],
    [{id:7,url:URL,incognito:false},{id:9,url:URL,incognito:false}]]){
    f.setTabs(tabs);
    assert.equal((await f.binding.select("worker-a",KEY)).ok,false);
  }
  f.fail();
  assert.equal((await f.binding.select("worker-a",KEY)).code,"TARGET_TABS_UNAVAILABLE");
});
test("async stale tab reads cannot resurrect revoked owner selection",async()=>{
  let unblock;
  const binding=createChatGptTargetBinding(()=>new Promise(resolve=>{unblock=resolve;}),EXT,
    async()=>({url:URL,documentId:D1,documentLifecycle:"active",
      frameType:"outermost_frame",parentFrameId:-1}));
  const pending=binding.select("worker-a",KEY);
  binding.invalidate();
  unblock([{id:7,url:URL,incognito:false}]);
  assert.equal((await pending).code,"TARGET_SELECTION_STALE");
  assert.equal(await binding.current("worker-a",KEY),null);
});

test("same-document pushState URL change revokes cached status despite unchanged tab/document and stale tab census",async()=>{
  const f=fixture();
  await f.binding.select("worker-a",KEY);
  assert.deepEqual(await f.binding.observe(observed(),sender(),"worker-a",KEY),{ok:true});
  assert.deepEqual(await f.binding.current("worker-a",KEY),observed());
  // tabs.query still reports old URL, while webNavigation.getFrame sees new
  // current URL with the SAME tab ID and document UUID.
  f.setFrame({url:"https://chatgpt.com/c/two",documentId:D1,
    documentLifecycle:"active",frameType:"outermost_frame",parentFrameId:-1});
  assert.equal(await f.binding.current("worker-a",KEY),null);
  f.setFrame({url:URL,documentId:D1,documentLifecycle:"active",
    frameType:"outermost_frame",parentFrameId:-1});
  assert.equal((await f.binding.observe(observed(),sender(),"worker-a",KEY)).code,
    "TARGET_NOT_SELECTED");
});
test("same-document history event revokes selected target before a later status read",async()=>{
  const f=fixture();await f.binding.select("worker-a",KEY);
  await f.binding.observe(observed(),sender(),"worker-a",KEY);
  // Browser-owned top-level navigation event forwards tabId to tabChanged.
  f.binding.tabChanged(7);
  assert.equal(await f.binding.current("worker-a",KEY),null);
});
test("readback refuses changed frame UUID, lifecycle, parent, error and unavailable frame provider",async()=>{
  const bad=[
    {documentId:D2},{documentLifecycle:"prerender"},
    {frameType:"sub_frame"},{parentFrameId:1},{errorOccurred:true},
  ];
  for(const mutation of bad){
    const f=fixture();await f.binding.select("worker-a",KEY);
    await f.binding.observe(observed(),sender(),"worker-a",KEY);
    f.setFrame({url:URL,documentId:D1,documentLifecycle:"active",
      frameType:"outermost_frame",parentFrameId:-1,errorOccurred:false,...mutation});
    assert.equal(await f.binding.current("worker-a",KEY),null);
  }
  const f=fixture();await f.binding.select("worker-a",KEY);
  await f.binding.observe(observed(),sender(),"worker-a",KEY);
  f.failFrame();
  assert.equal(await f.binding.current("worker-a",KEY),null);
});
test("incoming stale same-document status is rejected against Chrome frame truth",async()=>{
  const f=fixture();await f.binding.select("worker-a",KEY);
  f.setFrame({url:"https://chatgpt.com/c/two",documentId:D1,
    documentLifecycle:"active",frameType:"outermost_frame",parentFrameId:-1});
  assert.equal((await f.binding.observe(observed(),sender(),"worker-a",KEY)).code,
    "TARGET_CENSUS_CHANGED");
  assert.equal(await f.binding.current("worker-a",KEY),null);
});

test("F1-160-02 navigation during pending owner selection cannot commit stale tab",async()=>{
  for(const tabId of [7,9]){
    let finishCensus;
    const binding=createChatGptTargetBinding(
      ()=>new Promise(resolve=>{finishCensus=resolve;}),EXT,
      async()=>({url:URL,documentId:D2,documentLifecycle:"active",
        frameType:"outermost_frame",parentFrameId:-1}));
    const pending=binding.select("worker-a",KEY);
    // Browser event arrives before tabs.query resolves and before selected exists.
    binding.tabChanged(tabId);
    finishCensus([{id:7,url:URL,incognito:false}]);
    assert.equal((await pending).code,"TARGET_SELECTION_STALE");
    assert.equal(await binding.current("worker-a",KEY),null);
    assert.equal((await binding.observe(observed(),sender({documentId:D2}),
      "worker-a",KEY)).code,"TARGET_NOT_SELECTED");
  }
});
