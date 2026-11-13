import test from "node:test";
import assert from "node:assert/strict";
import { evaluateContinuationGate } from "../dist/continuation-gate.js";
import {
  CONVERSATION_CONTINUATION_LIVE_SEND_ENABLED,
  buildApprovedContinuationPrompt,
  runContinuationAttempt,
  runContinuationProtocolSimulation,
} from "../dist/continuation-runtime.js";

const HEAD = "a".repeat(40);
const FENCE_SHA = "b".repeat(40);
const CLAIM_SHA = "c".repeat(40);
const NOW = "2026-10-20T08:00:05.000Z";
const AUTH_AT = "2026-10-20T08:00:00.000Z";
const CONV_ID = "conv-existing-0001";

function baseInput(overrides = {}) {
  return {
    request: {
      protocolVersion: 1,
      repository: "jan2xo/bke-worker",
      workerId: "worker-f1",
      prNumber: 126,
      headSha: HEAD,
      attemptId: "attempt-2",
      executionId: "exec-2",
      event: "PREPARE_CONTINUATION",
      expectedConversationId: CONV_ID,
      expectedTurnNumber: 2,
      targetId: "target-f1-0001",
      profileId: "profile-f1-0001",
      targetTabId: 7,
      ...(overrides.request ?? {}),
    },
    github: {
      repository: "jan2xo/bke-worker",
      prNumber: 126,
      currentHeadSha: HEAD,
      assignedWorkerId: "worker-f1",
      workerOpenPrAssignments: 1,
      prAssignedWorkerCount: 1,
      prOpen: true,
      currentAttemptId: "attempt-2",
      state: "AUTHORIZED_PREPARE",
      previousAttemptResolved: true,
      deliveryKnowledge: "NOT_SENT",
      previousConversationId: CONV_ID,
      priorConversationIds: [CONV_ID],
      confirmedTurnCount: 1,
      priorAttemptIds: ["attempt-1"],
      attemptAuthorizedAt: AUTH_AT,
      ...(overrides.github ?? {}),
    },
    browser: {
      ownedTargetId: "target-f1-0001",
      ownedProfileId: "profile-f1-0001",
      ownedTargetTabId: 7,
      matchingWritableTargetCount: 1,
      profileIsolated: true,
      sharedWritableProfile: false,
      current: {
        targetId: "target-f1-0001",
        profileId: "profile-f1-0001",
        tabId: 7,
        observedAt: NOW,
        url: `https://chatgpt.com/c/${CONV_ID}`,
        uiState: "THREAD",
        visible: true,
        composerAvailable: true,
        turnBusy: false,
        ...(overrides.page ?? {}),
      },
      ...(overrides.browser ?? {}),
    },
    nowIso: overrides.nowIso ?? NOW,
  };
}

test("continuation live switch remains false and runContinuationAttempt performs zero IO", async () => {
  assert.equal(CONVERSATION_CONTINUATION_LIVE_SEND_ENABLED, false);
  const res = await runContinuationAttempt({ fake: true });
  assert.equal(res.status, "BLOCKED");
  assert.equal(res.code, "LIVE_SEND_DISABLED");
  assert.equal(res.externalIoPerformed, false);
  assert.equal(res.submitInvocations, 0);
});

test("continuation prompt strictly allowlists validated identifiers without untrusted text", () => {
  const prompt = buildApprovedContinuationPrompt(baseInput().request);
  assert.ok(prompt);
  assert.match(prompt, /Authorized pull request: #126/);
  assert.match(prompt, new RegExp(`Expected existing ChatGPT conversation ID: ${CONV_ID}`));
  assert.match(prompt, /Authorized engineering turn number: 2/);
  assert.equal(buildApprovedContinuationPrompt({ ...baseInput().request, expectedTurnNumber: 1 }), null);
  assert.equal(buildApprovedContinuationPrompt({ ...baseInput().request, repository: "evil/fork" }), null);
});

test("evaluateContinuationGate rejects blank new chat landing and mismatched conversation IDs", () => {
  const landing = evaluateContinuationGate(
    baseInput({ page: { url: "https://chatgpt.com/", uiState: "NEW_CHAT_LANDING" } }),
  );
  assert.equal(landing.decision, "BLOCKED");
  assert.equal(landing.code, "WRONG_CONVERSATION_OR_NEW_CHAT");

  const wrongThread = evaluateContinuationGate(
    baseInput({ page: { url: "https://chatgpt.com/c/conv-other-9999", uiState: "THREAD" } }),
  );
  assert.equal(wrongThread.decision, "BLOCKED");
  assert.equal(wrongThread.code, "WRONG_CONVERSATION_OR_NEW_CHAT");
});

test("evaluateContinuationGate rejects missing prior conversation, replay, head drift, and restart after claim", () => {
  assert.equal(
    evaluateContinuationGate(baseInput({ github: { previousConversationId: null } })).code,
    "PRIOR_CONVERSATION_MISSING",
  );
  assert.equal(
    evaluateContinuationGate(baseInput({ github: { priorAttemptIds: ["attempt-1", "attempt-2"] } })).code,
    "ATTEMPT_REPLAY_DETECTED",
  );
  assert.equal(
    evaluateContinuationGate(baseInput({ github: { currentHeadSha: "b".repeat(40) } })).code,
    "GITHUB_HEAD_CHANGED",
  );
  assert.equal(
    evaluateContinuationGate(
      baseInput({
        request: { event: "RECOVER_AFTER_RESTART" },
        github: { state: "FENCED_MAY_HAVE_SENT", deliveryKnowledge: "MAY_HAVE_SENT" },
      }),
    ).code,
    "DELIVERY_UNCERTAIN",
  );
});

test("continuation simulation succeeds cleanly on same conversation with zero duplicate sends", async () => {
  const res = await runContinuationProtocolSimulation();
  assert.equal(res.status, "SIMULATION_PASS");
  assert.equal(res.submitInvocations, 1);
  assert.equal(res.conversationId, "simulated-chat-0002");
  assert.equal(res.turnNumber, 2);
});

test("continuation simulation faults fail closed and quarantine uncertain deliveries without retry", async () => {
  for (const [fault, expectedCode, expectedSubmits] of [
    ["MISSING_PRIOR_CONVERSATION", "PRIOR_CONVERSATION_MISSING", 0],
    ["LANDING_PAGE_INSTEAD_OF_THREAD", "WRONG_CONVERSATION_OR_NEW_CHAT", 0],
    ["WRONG_CONVERSATION_URL", "WRONG_CONVERSATION_OR_NEW_CHAT", 0],
    ["ATTEMPT_REPLAY", "ATTEMPT_REPLAY_DETECTED", 0],
    ["FENCE_CAS_CONFLICT", "FENCE_COMMIT_FAILED", 0],
    ["FENCE_READBACK_MISMATCH", "FENCE_READBACK_BLOCKED", 0],
    ["SEND_CLAIM_CAS_CONFLICT", "SEND_CLAIM_COMMIT_FAILED", 0],
    ["SEND_CLAIM_CAS_UNCERTAIN", "DELIVERY_UNCERTAIN", 0],
    ["SEND_CLAIM_READBACK_MISMATCH", "SEND_CLAIM_READBACK_BLOCKED", 0],
    ["REOBSERVE_AFTER_CLAIM_THROW", "DELIVERY_UNCERTAIN", 0],
    ["SUBMIT_UNCERTAIN", "DELIVERY_UNCERTAIN", 1],
    ["SUBMIT_THROW_AFTER_INVOKE", "DELIVERY_UNCERTAIN", 1],
    ["POST_SEND_NEW_CONVERSATION_CREATED", "WRONG_CONVERSATION_OR_NEW_CHAT", 1],
    ["RECONCILE_CAS_CONFLICT", "LEDGER_RECONCILIATION_FAILED", 1],
    ["RECONCILE_READBACK_MISMATCH", "LEDGER_RECONCILIATION_FAILED", 1],
  ]) {
    const res = await runContinuationProtocolSimulation({ fault });
    assert.equal(res.status, "BLOCKED", `fault=${fault}`);
    assert.equal(res.code, expectedCode, `fault=${fault} got=${res.code}`);
    assert.equal(res.submitInvocations, expectedSubmits, `fault=${fault}`);
  }
});
