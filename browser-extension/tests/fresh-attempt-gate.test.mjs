import test from "node:test";
import assert from "node:assert/strict";
import {evaluateFreshAttempt} from "../dist/fresh-attempt-gate.js";

const HEAD = "a".repeat(40);
function fixture() {
  return {
    request:{protocolVersion:1,repository:"jan2xo/bke-worker",workerId:"worker-a",prNumber:120,
      headSha:HEAD,attemptId:"worker-a-120-2",kind:"REMEDIATE"},
    github:{repository:"jan2xo/bke-worker",prNumber:120,currentHeadSha:HEAD,
      assignedWorkerId:"worker-a",workerOpenPrAssignments:1,prAssignedWorkerCount:1,
      prOpen:true,previousAttemptResolved:true,currentAttemptId:"worker-a-120-2",currentAttemptDelivery:"NOT_SENT"},
    browser:{ownedTargetTabId:23,matchingWritableTargetCount:1,sharedWritableProfile:false,
      current:{observedAt:"2026-10-20T03:00:00.000Z",url:"https://chatgpt.com/c/older-chat",
        visible:true,composerAvailable:true,turnBusy:false,tabId:23}},
    nowIso:"2026-10-20T03:00:02.000Z"
  };
}
function blocked(edit,code){const f=fixture();edit(f); assert.deepEqual(evaluateFreshAttempt(f),{decision:"BLOCKED",code,authority:"NONE"});}
test("valid synthetic remediation attempt remains candidate only, never authorization",()=>{
  assert.deepEqual(evaluateFreshAttempt(fixture()),{
    decision:"CANDIDATE_ONLY",code:"FRESH_CONVERSATION_CANDIDATE",authority:"NONE"});
});
test("implementation uses the same fresh-chat candidate rule",()=>{
  const f=fixture();f.request.kind="IMPLEMENT";
  assert.equal(evaluateFreshAttempt(f).decision,"CANDIDATE_ONLY");
});
test("malformed request never creates candidate",()=>{
  for(const change of [f=>f.request.headSha="FAKE",f=>f.request.prNumber=0,
    f=>f.request.kind="OTHER",f=>f.request.workerId="worker_a",
    f=>f.request.attemptId="../evil",f=>f.request.repository="oops",
    f=>f.request.protocolVersion=2,f=>f.browser.current.tabId=-1]) {
    blocked(change,"INVALID_INPUT");
  }
  assert.equal(evaluateFreshAttempt(null).authority,"NONE");
});
test("more than one worker PR assignment or shared PR owner blocks",()=>{
  for(const change of [f=>f.github.workerOpenPrAssignments=2,
    f=>f.github.prAssignedWorkerCount=0,f=>f.github.prAssignedWorkerCount=2,
    f=>f.github.assignedWorkerId="worker-b",f=>f.github.repository="other/repo",
    f=>f.github.prNumber=121])blocked(change,"GITHUB_ASSIGNMENT_CONFLICT");
});
test("changed PR SHA and closed PR block",()=>{
  blocked(f=>f.github.currentHeadSha="b".repeat(40),"GITHUB_HEAD_CHANGED");
  blocked(f=>f.github.prOpen=false,"PR_NOT_RUNNABLE");
});
test("wrong attempt cannot inherit an earlier intent",()=>{
  blocked(f=>f.github.currentAttemptId="worker-a-120-1","ATTEMPT_NOT_AUTHORIZED");
});
test("no handoff: incomplete previous attempt blocks despite idle browser",()=>{
  blocked(f=>f.github.previousAttemptResolved=false,"PREVIOUS_ATTEMPT_UNRESOLVED");
});
test("duplicate dispatch, sent, uncertain, completed attempts all block",()=>{
  for(const state of ["IN_FLIGHT","UNCERTAIN","COMPLETED"]) {
    blocked(f=>f.github.currentAttemptDelivery=state,"DISPATCH_NOT_NEW");
  }
});
test("ambiguous target identity and shared writable profiles deny",()=>{
  for(const edit of [f=>f.browser.sharedWritableProfile=true,
    f=>f.browser.matchingWritableTargetCount=0,
    f=>f.browser.matchingWritableTargetCount=2,
    f=>f.browser.current.tabId=24])blocked(edit,"BROWSER_TARGET_AMBIGUOUS");
});
test("busy, hidden, missing composer or non-ChatGPT tabs fail closed",()=>{
  blocked(f=>f.browser.current.turnBusy=true,"CHATGPT_BUSY");
  for(const edit of [f=>f.browser.current.visible=false,
    f=>f.browser.current.composerAvailable=false,
    f=>f.browser.current.url="https://evil.test/c/x",
    f=>f.browser.current.url="http://chatgpt.com/c/x",
    f=>f.browser.current.url="https://chatgpt.com.evil.test/"])blocked(edit,"CHATGPT_UI_UNAVAILABLE");
});
test("stale and future observations fail closed",()=>{
  for(const edit of [f=>f.browser.current.observedAt="2026-10-20T02:59:40.000Z",
    f=>f.browser.current.observedAt="2026-10-20T03:00:10.000Z",
    f=>f.browser.current.observedAt="tomorrow",
    f=>f.nowIso="invalid"])blocked(edit,"CHATGPT_OBSERVATION_STALE");
});
test("fresh-attempt model does not invent GitHub trust or state",()=>{
  const f=fixture();
  const result=evaluateFreshAttempt(f);
  assert.equal(result.authority,"NONE");
  assert.equal("token" in result,false);
  assert.equal("prompt" in result,false);
  assert.equal("url" in result,false);
  assert.equal("workerId" in result,false);
});
