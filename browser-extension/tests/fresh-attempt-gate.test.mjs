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
      prOpen:true,previousAttemptResolved:true,currentAttemptId:"worker-a-120-2",currentAttemptDelivery:"NOT_SENT",
      previousConversationId:"older-chat",priorConversationIds:["older-chat"],
      attemptAuthorizedAt:"2026-10-20T02:59:55.000Z"},
    browser:{ownedTargetTabId:23,matchingWritableTargetCount:1,sharedWritableProfile:false,
      current:{observedAt:"2026-10-20T03:00:00.000Z",url:"https://chatgpt.com/c/new-chat-120-2",
        visible:true,composerAvailable:true,turnBusy:false,tabId:23},
      newConversation:{event:"NEW_CHAT_CREATED",attemptId:"worker-a-120-2",workerId:"worker-a",
        headSha:HEAD,targetTabId:23,beforeUrl:"https://chatgpt.com/c/older-chat",
        afterUrl:"https://chatgpt.com/c/new-chat-120-2",newConversationId:"new-chat-120-2",
        creationStartedAt:"2026-10-20T02:59:58.000Z",confirmedAt:"2026-10-20T02:59:59.000Z"}},
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

test("P1 regression: old conversation can NEVER qualify as fresh",()=>{
  blocked(f=>{f.browser.current.url="https://chatgpt.com/c/older-chat";},
    "FRESH_CONVERSATION_UNCONFIRMED");
  blocked(f=>{f.browser.current.url="https://chatgpt.com/c/older-chat";
    f.browser.newConversation.afterUrl="https://chatgpt.com/c/older-chat";
    f.browser.newConversation.newConversationId="older-chat";},
    "FRESH_CONVERSATION_REUSED");
  blocked(f=>{f.browser.current.url="https://chatgpt.com/c/older-chat";
    delete f.browser.newConversation;},
    "FRESH_CONVERSATION_UNCONFIRMED");
});

test("no trusted new-conversation confirmation means no candidate",()=>{
  blocked(f=>{delete f.browser.newConversation;},"FRESH_CONVERSATION_UNCONFIRMED");
  blocked(f=>{f.browser.newConversation=null;},"FRESH_CONVERSATION_UNCONFIRMED");
  blocked(f=>{f.browser.newConversation.event="PAGE_IDLE";},"FRESH_CONVERSATION_UNCONFIRMED");
  blocked(f=>{f.browser.newConversation.attemptId="worker-a-120-1";},"FRESH_CONVERSATION_UNCONFIRMED");
  blocked(f=>{f.browser.newConversation.workerId="worker-b";},"FRESH_CONVERSATION_UNCONFIRMED");
  blocked(f=>{f.browser.newConversation.headSha="b".repeat(40);},"FRESH_CONVERSATION_UNCONFIRMED");
  blocked(f=>{f.browser.newConversation.targetTabId=44;},"FRESH_CONVERSATION_UNCONFIRMED");
});

test("new target URL identity must match the confirmation and exact chat route",()=>{
  blocked(f=>{f.browser.newConversation.newConversationId="other-conversation";},
    "FRESH_CONVERSATION_UNCONFIRMED");
  blocked(f=>{f.browser.newConversation.afterUrl="https://chatgpt.com/c/another-chat";},
    "FRESH_CONVERSATION_UNCONFIRMED");
  blocked(f=>{f.browser.current.url="https://chatgpt.com/";},"FRESH_CONVERSATION_UNCONFIRMED");
  blocked(f=>{f.browser.current.url="https://chatgpt.com/c/new-chat-120-2?x=1";},
    "FRESH_CONVERSATION_UNCONFIRMED");
  blocked(f=>{f.browser.newConversation.beforeUrl="https://chatgpt.com/c/wrong-chat";},
    "FRESH_CONVERSATION_UNCONFIRMED");
});

test("reusing ANY GitHub recorded prior conversation blocks even with coherent receipt",()=>{
  blocked(f=>{
    f.github.priorConversationIds.push("new-chat-120-2");
  },"FRESH_CONVERSATION_REUSED");
  blocked(f=>{
    f.github.priorConversationIds=["older-chat","older-chat"];
  },"FRESH_CONVERSATION_UNCONFIRMED");
  blocked(f=>{delete f.github.priorConversationIds;},"FRESH_CONVERSATION_UNCONFIRMED");
  blocked(f=>{delete f.github.previousConversationId;},"FRESH_CONVERSATION_UNCONFIRMED");
  blocked(f=>{f.github.previousConversationId="another-chat";},"FRESH_CONVERSATION_UNCONFIRMED");
});

test("confirmation must follow authorized attempt and precede observation",()=>{
  blocked(f=>{f.github.attemptAuthorizedAt="2026-10-20T03:00:01.000Z";},
    "FRESH_CONVERSATION_STALE");
  blocked(f=>{f.browser.newConversation.creationStartedAt="2026-10-20T02:59:30.000Z";},
    "FRESH_CONVERSATION_STALE");
  blocked(f=>{f.browser.newConversation.confirmedAt="2026-10-20T03:00:04.000Z";},
    "FRESH_CONVERSATION_STALE");
  blocked(f=>{f.browser.newConversation.confirmedAt="2026-10-20T02:59:40.000Z";},
    "FRESH_CONVERSATION_STALE");
  blocked(f=>{f.browser.newConversation.confirmedAt="invalid";},
    "FRESH_CONVERSATION_STALE");
});

test("first attempt from new-chat landing page requires own newly-created conversation",()=>{
  const f=fixture();
  f.github.previousConversationId=null;
  f.github.priorConversationIds=[];
  f.browser.newConversation.beforeUrl="https://chatgpt.com/";
  assert.equal(evaluateFreshAttempt(f).decision,"CANDIDATE_ONLY");
  f.browser.newConversation.beforeUrl="https://chatgpt.com/c/older-chat";
  assert.equal(evaluateFreshAttempt(f).code,"FRESH_CONVERSATION_UNCONFIRMED");
});

test("even a self-consistent entirely forged confirmation grants no authority",()=>{
  const f=fixture();
  // Every input here is a caller-owned fixture, not verified browser provenance.
  const result=evaluateFreshAttempt(f);
  assert.equal(result.authority,"NONE");
  assert.equal(result.decision,"CANDIDATE_ONLY");
  assert.equal("send" in result,false);
  assert.equal("navigate" in result,false);
});

test("P2 regression: first attempt rejects a single sparse prior-history hole",()=>{
  blocked(f=>{
    f.github.previousConversationId=null;
    f.github.priorConversationIds=new Array(1);
    f.browser.newConversation.beforeUrl="https://chatgpt.com/";
  },"FRESH_CONVERSATION_UNCONFIRMED");
});

test("P2 regression: first attempt rejects multiple sparse holes",()=>{
  blocked(f=>{
    f.github.previousConversationId=null;
    const sparse=new Array(4);
    sparse[1]="older-chat";
    sparse[3]="another-chat";
    f.github.priorConversationIds=sparse;
    f.browser.newConversation.beforeUrl="https://chatgpt.com/";
  },"FRESH_CONVERSATION_UNCONFIRMED");
  blocked(f=>{
    f.github.previousConversationId=null;
    f.github.priorConversationIds=new Array(3);
    f.browser.newConversation.beforeUrl="https://chatgpt.com/";
  },"FRESH_CONVERSATION_UNCONFIRMED");
});

test("P2 regression: known previous chat plus a sparse hole is invalid",()=>{
  blocked(f=>{
    const sparse=new Array(2);
    sparse[1]="older-chat";
    f.github.priorConversationIds=sparse;
  },"FRESH_CONVERSATION_UNCONFIRMED");
  blocked(f=>{
    f.github.priorConversationIds=["older-chat",,];
  },"FRESH_CONVERSATION_UNCONFIRMED");
});

test("history must contain own valid entries, not inherited or explicit undefined",()=>{
  blocked(f=>{
    const inherited=new Array(2);
    inherited[1]="older-chat";
    const proto=Object.create(Array.prototype);
    Object.defineProperty(proto,"0",{value:"another-chat",configurable:true});
    Object.setPrototypeOf(inherited,proto);
    f.github.priorConversationIds=inherited;
  },"FRESH_CONVERSATION_UNCONFIRMED");
  blocked(f=>{
    f.github.priorConversationIds=["older-chat",undefined];
  },"FRESH_CONVERSATION_UNCONFIRMED");
});
