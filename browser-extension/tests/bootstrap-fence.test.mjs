import test from "node:test";
import assert from "node:assert/strict";
import {evaluateBootstrapFence} from "../dist/bootstrap-fence.js";

const HEAD = "a".repeat(40);
const FENCE_SHA = "b".repeat(40);
const AUTHORIZED_AT = "2026-10-20T04:00:00.000Z";
const FENCED_AT = "2026-10-20T04:00:02.000Z";

function fixture(event = "PREPARE") {
  const request = {
    protocolVersion: 1,
    repository: "jan2xo/bke-worker",
    workerId: "go-manual",
    prNumber: 119,
    headSha: HEAD,
    attemptId: "go-119-attempt-1",
    executionId: "go-execution-1",
    event,
    targetId: "target-0001",
    profileId: "profile-0001",
    targetTabId: 23
  };
  const github = {
    repository: "jan2xo/bke-worker",
    prNumber: 119,
    currentHeadSha: HEAD,
    assignedWorkerId: "go-manual",
    workerOpenPrAssignments: 1,
    prAssignedWorkerCount: 1,
    prOpen: true,
    currentAttemptId: request.attemptId,
    state: "AUTHORIZED_PREPARE",
    previousAttemptResolved: true,
    deliveryKnowledge: "NOT_SENT",
    previousConversationId: "old-chat-0001",
    priorConversationIds: ["old-chat-0001", "old-chat-0002"],
    attemptAuthorizedAt: AUTHORIZED_AT
  };
  const browser = {
    ownedTargetId: request.targetId,
    ownedProfileId: request.profileId,
    ownedTargetTabId: request.targetTabId,
    matchingWritableTargetCount: 1,
    profileIsolated: true,
    sharedWritableProfile: false,
    current: {
      targetId: request.targetId,
      profileId: request.profileId,
      tabId: request.targetTabId,
      observedAt: "2026-10-20T04:00:03.000Z",
      url: "https://chatgpt.com/",
      uiState: "NEW_CHAT_LANDING",
      visible: true,
      composerAvailable: true,
      turnBusy: false
    }
  };
  return {request, github, browser, nowIso: "2026-10-20T04:00:04.000Z"};
}

function expectBlocked(edit, code, state = "BLOCKED", event = "PREPARE") {
  const input = fixture(event);
  edit(input);
  assert.deepEqual(evaluateBootstrapFence(input), {
    decision: "BLOCKED", state, code, authority: "NONE"
  });
}

function commitFence(input) {
  input.request.event = "VERIFY_FENCE_COMMIT";
  input.github.state = "FENCED_MAY_HAVE_SENT";
  input.github.deliveryKnowledge = "MAY_HAVE_SENT";
  input.github.fence = {
    durable: true,
    fenceId: "fence-0001",
    commitSha: FENCE_SHA,
    attemptId: input.request.attemptId,
    workerId: input.request.workerId,
    headSha: input.request.headSha,
    targetId: input.request.targetId,
    profileId: input.request.profileId,
    targetTabId: input.request.targetTabId,
    executionId: input.request.executionId,
    generation: 1,
    committedAt: FENCED_AT
  };
  input.browser.fenceCommitReceipt = {
    event: "FENCE_COMMIT_RETURNED",
    fenceId: input.github.fence.fenceId,
    commitSha: input.github.fence.commitSha,
    attemptId: input.request.attemptId,
    workerId: input.request.workerId,
    headSha: input.request.headSha,
    targetId: input.request.targetId,
    profileId: input.request.profileId,
    targetTabId: input.request.targetTabId,
    executionId: input.request.executionId,
    observedAt: "2026-10-20T04:00:03.000Z"
  };
  return input;
}

function postSend(input) {
  input.request.event = "CONFIRM_NEW_CONVERSATION";
  input.github.state = "FENCED_MAY_HAVE_SENT";
  input.github.deliveryKnowledge = "MAY_HAVE_SENT";
  input.github.fence = {
    durable: true, fenceId: "fence-0001", commitSha: FENCE_SHA,
    attemptId: input.request.attemptId, workerId: input.request.workerId,
    headSha: input.request.headSha, targetId: input.request.targetId,
    profileId: input.request.profileId, targetTabId: input.request.targetTabId,
    executionId: input.request.executionId, generation: 1, committedAt: FENCED_AT
  };
  input.browser.current.uiState = "THREAD";
  input.browser.current.url = "https://chatgpt.com/c/fresh-chat-0001";
  input.browser.current.observedAt = "2026-10-20T04:00:06.000Z";
  input.nowIso = "2026-10-20T04:00:07.000Z";
  input.browser.firstMessageReceipt = {
    event: "FIRST_MESSAGE_CREATED_CONVERSATION",
    attemptId: input.request.attemptId,
    workerId: input.request.workerId,
    headSha: input.request.headSha,
    fenceId: "fence-0001",
    fenceCommitSha: FENCE_SHA,
    targetId: input.request.targetId,
    profileId: input.request.profileId,
    targetTabId: input.request.targetTabId,
    beforeUrl: "https://chatgpt.com/",
    afterUrl: "https://chatgpt.com/c/fresh-chat-0001",
    conversationId: "fresh-chat-0001",
    sendStartedAt: "2026-10-20T04:00:03.500Z",
    confirmedAt: "2026-10-20T04:00:05.000Z"
  };
  return input;
}

test("authorized prepare is only a candidate and cannot send or persist anything", () => {
  const result = evaluateBootstrapFence(fixture());
  assert.deepEqual(result, {
    decision: "CANDIDATE_ONLY", state: "AUTHORIZED_PREPARE",
    code: "PREPARE_CANDIDATE", authority: "NONE"
  });
  assert.equal("prompt" in result, false);
  assert.equal("send" in result, false);
  assert.equal("navigate" in result, false);
});

test("unassigned and ambiguous GitHub ownership fail closed", () => {
  expectBlocked(f => { f.github.workerOpenPrAssignments = 0; }, "GITHUB_ASSIGNMENT_CONFLICT");
  expectBlocked(f => { f.github.workerOpenPrAssignments = 2; }, "GITHUB_ASSIGNMENT_CONFLICT");
  expectBlocked(f => { f.github.prAssignedWorkerCount = 2; }, "GITHUB_ASSIGNMENT_CONFLICT");
  expectBlocked(f => { f.github.assignedWorkerId = "worker-b"; }, "GITHUB_ASSIGNMENT_CONFLICT");
  expectBlocked(f => { f.github.repository = "other/repo"; }, "GITHUB_ASSIGNMENT_CONFLICT");
  expectBlocked(f => { f.github.prNumber = 120; }, "GITHUB_ASSIGNMENT_CONFLICT");
});

test("wrong head, attempt and worker fail closed", () => {
  expectBlocked(f => { f.github.currentHeadSha = "c".repeat(40); }, "GITHUB_HEAD_CHANGED");
  expectBlocked(f => { f.github.currentAttemptId = "go-119-attempt-2"; }, "ATTEMPT_NOT_AUTHORIZED");
  expectBlocked(f => { f.request.workerId = "another-worker"; }, "GITHUB_ASSIGNMENT_CONFLICT");
});

test("closed PR, unresolved previous attempt and unauthorized state fail closed", () => {
  expectBlocked(f => { f.github.prOpen = false; }, "PR_NOT_RUNNABLE");
  expectBlocked(f => { f.github.previousAttemptResolved = false; }, "PREVIOUS_ATTEMPT_UNRESOLVED");
  expectBlocked(f => { f.github.state = "UNAUTHORIZED"; }, "ATTEMPT_NOT_AUTHORIZED");
});

test("incomplete, duplicate, sparse, oversized and malformed history blocks", () => {
  expectBlocked(f => { delete f.github.priorConversationIds; }, "INVALID_INPUT");
  expectBlocked(f => { f.github.priorConversationIds = ["old-chat-0001", "old-chat-0001"]; }, "PRIOR_HISTORY_INVALID");
  expectBlocked(f => { f.github.priorConversationIds = new Array(1); }, "PRIOR_HISTORY_INVALID");
  expectBlocked(f => { f.github.priorConversationIds = ["old-chat-0001",,]; }, "PRIOR_HISTORY_INVALID");
  expectBlocked(f => {
    const inherited = new Array(1);
    Object.setPrototypeOf(inherited, Object.assign(Object.create(Array.prototype), {"0":"old-chat-0001"}));
    f.github.priorConversationIds = inherited;
  }, "PRIOR_HISTORY_INVALID");
  expectBlocked(f => { f.github.priorConversationIds = [undefined]; }, "PRIOR_HISTORY_INVALID");
  expectBlocked(f => { f.github.priorConversationIds = Array(1025).fill("old-chat-0001"); }, "PRIOR_HISTORY_INVALID");
  expectBlocked(f => { f.github.previousConversationId = "not-in-history"; }, "PRIOR_HISTORY_INVALID");
});

test("prepare rejects landing page that is busy, auth-required or not isolated", () => {
  expectBlocked(f => { f.browser.current.uiState = "AUTH_REQUIRED"; }, "CHATGPT_AUTH_REQUIRED");
  expectBlocked(f => { f.browser.current.uiState = "BUSY"; }, "CHATGPT_BUSY");
  expectBlocked(f => { f.browser.current.turnBusy = true; }, "CHATGPT_BUSY");
  expectBlocked(f => { f.browser.current.url = "https://chatgpt.com/c/old-chat-0001"; }, "CHATGPT_UI_UNAVAILABLE");
  expectBlocked(f => { f.browser.profileIsolated = false; }, "BROWSER_TARGET_CONFLICT");
  expectBlocked(f => { f.browser.sharedWritableProfile = true; }, "BROWSER_TARGET_CONFLICT");
  expectBlocked(f => { f.browser.matchingWritableTargetCount = 2; }, "BROWSER_TARGET_CONFLICT");
  expectBlocked(f => { f.browser.current.tabId = 24; }, "BROWSER_TARGET_CONFLICT");
  expectBlocked(f => { f.browser.current.targetId = "other-target"; }, "BROWSER_TARGET_CONFLICT");
  expectBlocked(f => { f.browser.current.profileId = "other-profile"; }, "BROWSER_TARGET_CONFLICT");
});

test("stale observation and malformed timestamp block", () => {
  expectBlocked(f => { f.browser.current.observedAt = "2026-10-20T03:59:00.000Z"; }, "OBSERVATION_STALE");
  expectBlocked(f => { f.browser.current.observedAt = "not-a-time"; }, "OBSERVATION_STALE");
  expectBlocked(f => { f.nowIso = "invalid"; }, "OBSERVATION_STALE");
});

test("first-message candidate requires already durable matching fence", () => {
  const noFence = fixture("VERIFY_FENCE_COMMIT");
  assert.deepEqual(evaluateBootstrapFence(noFence), {
    decision: "BLOCKED", state: "AUTHORIZED_PREPARE",
    code: "DURABLE_FENCE_REQUIRED", authority: "NONE"
  });
  const valid = commitFence(fixture());
  assert.deepEqual(evaluateBootstrapFence(valid), {
    decision: "CANDIDATE_ONLY", state: "FENCED_MAY_HAVE_SENT",
    code: "FIRST_MESSAGE_CANDIDATE", authority: "NONE"
  });
});

test("fence mismatch, missing durable proof and replay/wrong execution block", () => {
  expectBlocked(f => {
    f.request.event = "VERIFY_FENCE_COMMIT";
    f.github.state = "FENCED_MAY_HAVE_SENT";
    f.github.deliveryKnowledge = "MAY_HAVE_SENT";
  }, "FENCE_INVALID", "FENCED_MAY_HAVE_SENT", "VERIFY_FENCE_COMMIT");
  const wrongCommit = commitFence(fixture());
  wrongCommit.github.fence.commitSha = "not-a-sha";
  assert.equal(evaluateBootstrapFence(wrongCommit).code, "FENCE_INVALID");
  const wrongExecution = commitFence(fixture());
  wrongExecution.request.executionId = "go-execution-2";
  assert.equal(evaluateBootstrapFence(wrongExecution).code, "FENCE_INVALID");
  const replayed = commitFence(fixture());
  replayed.browser.fenceCommitReceipt.observedAt = "2026-10-20T03:59:00.000Z";
  assert.equal(evaluateBootstrapFence(replayed).code, "FENCE_REPLAY_OR_WRONG_EXECUTION");
  expectBlocked(f => {
    f.request.event = "PREPARE";
    f.github.state = "FENCED_MAY_HAVE_SENT";
    f.github.deliveryKnowledge = "MAY_HAVE_SENT";
  }, "FENCE_REPLAY_OR_WRONG_EXECUTION", "FENCED_MAY_HAVE_SENT");
});

test("missing durable fence cannot transition to the first-message event", () => {
  expectBlocked(f => { f.request.event = "VERIFY_FENCE_COMMIT"; }, "DURABLE_FENCE_REQUIRED");
});

test("matching post-send conversation ID is a candidate only, never authority", () => {
  const result = evaluateBootstrapFence(postSend(fixture()));
  assert.deepEqual(result, {
    decision: "CANDIDATE_ONLY", state: "CONFIRMED_NEW_CONVERSATION",
    code: "NEW_CONVERSATION_CANDIDATE", authority: "NONE"
  });
});

test("first-message confirmation rejects a previously used conversation ID", () => {
  expectBlocked(f => {
    const input = postSend(f);
    input.browser.current.url = "https://chatgpt.com/c/old-chat-0001";
    input.browser.firstMessageReceipt.afterUrl = "https://chatgpt.com/c/old-chat-0001";
    input.browser.firstMessageReceipt.conversationId = "old-chat-0001";
    return input;
  }, "CONVERSATION_ID_REUSED", "FENCED_MAY_HAVE_SENT", "CONFIRM_NEW_CONVERSATION");
});

test("first-message receipt must match fence, attempt, head, target and chronology", () => {
  expectBlocked(f => { postSend(f).browser.firstMessageReceipt.fenceCommitSha = "c".repeat(40); },
    "FIRST_MESSAGE_RECEIPT_INVALID", "FENCED_MAY_HAVE_SENT", "CONFIRM_NEW_CONVERSATION");
  expectBlocked(f => { postSend(f).browser.firstMessageReceipt.attemptId = "go-119-attempt-2"; },
    "FIRST_MESSAGE_RECEIPT_INVALID", "FENCED_MAY_HAVE_SENT", "CONFIRM_NEW_CONVERSATION");
  expectBlocked(f => { postSend(f).browser.firstMessageReceipt.sendStartedAt = "2026-10-20T04:00:01.000Z"; },
    "FIRST_MESSAGE_RECEIPT_INVALID", "FENCED_MAY_HAVE_SENT", "CONFIRM_NEW_CONVERSATION");
  expectBlocked(f => { postSend(f).browser.firstMessageReceipt.afterUrl = "https://chatgpt.com/c/other-chat-0001"; },
    "FIRST_MESSAGE_RECEIPT_INVALID", "FENCED_MAY_HAVE_SENT", "CONFIRM_NEW_CONVERSATION");
});

test("uncertain send and crash/restart after fence never authorize a retry", () => {
  const recoverFenced = fixture("RECOVER_AFTER_RESTART");
  recoverFenced.github.state = "FENCED_MAY_HAVE_SENT";
  recoverFenced.github.deliveryKnowledge = "MAY_HAVE_SENT";
  assert.deepEqual(evaluateBootstrapFence(recoverFenced), {
    decision: "BLOCKED", state: "DELIVERY_UNCERTAIN",
    code: "DELIVERY_UNCERTAIN", authority: "NONE"
  });
  const alreadyUncertain = fixture("RECOVER_AFTER_RESTART");
  alreadyUncertain.github.state = "DELIVERY_UNCERTAIN";
  alreadyUncertain.github.deliveryKnowledge = "UNCERTAIN";
  assert.deepEqual(evaluateBootstrapFence(alreadyUncertain), {
    decision: "BLOCKED", state: "DELIVERY_UNCERTAIN",
    code: "DELIVERY_UNCERTAIN", authority: "NONE"
  });
  expectBlocked(f => {
    f.request.event = "VERIFY_FENCE_COMMIT";
    f.github.state = "FENCED_MAY_HAVE_SENT";
    f.github.deliveryKnowledge = "UNCERTAIN";
  }, "ATTEMPT_STATE_CONFLICT", "FENCED_MAY_HAVE_SENT", "VERIFY_FENCE_COMMIT");
});

test("restart before fence can resume prepare only, never first send", () => {
  const f = fixture("RECOVER_AFTER_RESTART");
  assert.deepEqual(evaluateBootstrapFence(f), {
    decision: "CANDIDATE_ONLY", state: "AUTHORIZED_PREPARE",
    code: "SAFE_TO_REEVALUATE_PREPARE", authority: "NONE"
  });
  const directSend = fixture("VERIFY_FENCE_COMMIT");
  assert.equal(evaluateBootstrapFence(directSend).code, "DURABLE_FENCE_REQUIRED");
});

test("coherent forged GitHub and browser records never grant authority", () => {
  for (const input of [fixture(), commitFence(fixture()), postSend(fixture())]) {
    const result = evaluateBootstrapFence(input);
    assert.equal(result.authority, "NONE");
    assert.equal("prompt" in result, false);
    assert.equal("send" in result, false);
    assert.equal("navigate" in result, false);
    assert.equal("githubWrite" in result, false);
  }
});

test("malformed root and invalid protocol fail closed", () => {
  assert.deepEqual(evaluateBootstrapFence(null), {
    decision: "BLOCKED", state: "BLOCKED", code: "INVALID_INPUT", authority: "NONE"
  });
  expectBlocked(f => { f.request.protocolVersion = 3; }, "INVALID_INPUT");
  expectBlocked(f => { f.request.prNumber = 0; }, "INVALID_INPUT");
  expectBlocked(f => { f.request.targetTabId = -1; }, "INVALID_INPUT");
  expectBlocked(f => { f.github.deliveryKnowledge = "UNKNOWN"; }, "INVALID_INPUT");
});

test("confirmed or blocked attempts are terminal", () => {
  expectBlocked(f => {
    f.github.state = "CONFIRMED_NEW_CONVERSATION";
    f.github.deliveryKnowledge = "CONFIRMED";
    f.request.event = "PREPARE";
  }, "ATTEMPT_TERMINAL", "CONFIRMED_NEW_CONVERSATION");
  expectBlocked(f => { f.github.state = "BLOCKED"; }, "ATTEMPT_TERMINAL", "BLOCKED");
});
