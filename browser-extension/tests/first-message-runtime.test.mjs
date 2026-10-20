import test from "node:test";
import assert from "node:assert/strict";
import {
  runFirstMessageAttempt,
  runFirstMessageProtocolSimulation,
} from "../dist/first-message-runtime.js";

test("live entrypoint remains inert and performs zero external IO while live sending is disabled", async () => {
  const result = await runFirstMessageAttempt({
    mode: "SIMULATION",
    forgedLiveProofs: true,
    provider: { commitPreSendFence: () => { throw new Error("must not run"); } },
    browser: { submitOnce: () => { throw new Error("must not run"); } },
  });
  assert.equal(result.status, "BLOCKED");
  assert.equal(result.code, "LIVE_SEND_DISABLED");
  assert.equal(result.authority, "NONE");
  assert.equal(result.externalIoPerformed, false);
  assert.equal(result.realBrowserSubmissions, 0);
  assert.equal(result.simulatedSubmitInvocations, 0);
  assert.deepEqual(result.phases, []);
});

test("in-memory happy path runs ordered CAS/read-back, one submit, receipt and reconciliation", async () => {
  const result = await runFirstMessageProtocolSimulation();
  assert.equal(result.status, "SIMULATION_PASS");
  assert.equal(result.code, "SIMULATION_PASS");
  assert.equal(result.authority, "NONE");
  assert.equal(result.syntheticEvidence, true);
  assert.equal(result.externalIoPerformed, false);
  assert.equal(result.realBrowserSubmissions, 0);
  assert.equal(result.simulatedSubmitInvocations, 1);
  assert.equal(result.conversationIdCandidate, "simulated-chat-0002");
  assert.equal(result.simulatedLedgerConversationId, "simulated-chat-0002");
  const phaseIndex = name => result.phases.indexOf(name);
  assert.ok(phaseIndex("COMMIT_FENCE") < phaseIndex("READ_BACK_FENCE"));
  assert.ok(phaseIndex("READ_BACK_FENCE") < phaseIndex("VERIFY_FENCE"));
  assert.ok(phaseIndex("COMMIT_SEND_CLAIM") < phaseIndex("READ_BACK_SEND_CLAIM"));
  assert.ok(phaseIndex("READ_BACK_SEND_CLAIM") < phaseIndex("REOBSERVE_AFTER_CLAIM"));
  assert.ok(phaseIndex("REOBSERVE_AFTER_CLAIM") < phaseIndex("AUTHORIZE_FIRST_SUBMISSION"));
  assert.ok(phaseIndex("AUTHORIZE_FIRST_SUBMISSION") < phaseIndex("SIMULATED_SINGLE_SUBMIT"));
  assert.ok(phaseIndex("SIMULATED_SINGLE_SUBMIT") < phaseIndex("OBSERVE_POST_SEND"));
  assert.ok(phaseIndex("OBSERVE_POST_SEND") < phaseIndex("RECONCILE_CONVERSATION"));
  assert.ok(phaseIndex("RECONCILE_CONVERSATION") < phaseIndex("READ_BACK_RECONCILIATION"));
});

test("fence CAS conflict prevents claim and submit", async () => {
  const result = await runFirstMessageProtocolSimulation({ fault: "FENCE_CAS_CONFLICT" });
  assert.equal(result.status, "BLOCKED");
  assert.equal(result.code, "FENCE_COMMIT_FAILED");
  assert.equal(result.simulatedSubmitInvocations, 0);
  assert.equal(result.phases.includes("COMMIT_SEND_CLAIM"), false);
  assert.equal(result.phases.includes("SIMULATED_SINGLE_SUBMIT"), false);
});

test("fence read-back mismatch prevents first-send claim and submit", async () => {
  const result = await runFirstMessageProtocolSimulation({ fault: "FENCE_READBACK_MISMATCH" });
  assert.equal(result.status, "BLOCKED");
  assert.equal(result.code, "FENCE_READBACK_BLOCKED");
  assert.equal(result.simulatedSubmitInvocations, 0);
  assert.equal(result.phases.includes("COMMIT_SEND_CLAIM"), false);
});

test("send-claim CAS conflict prevents submit", async () => {
  const result = await runFirstMessageProtocolSimulation({ fault: "SEND_CLAIM_CAS_CONFLICT" });
  assert.equal(result.status, "BLOCKED");
  assert.equal(result.code, "SEND_CLAIM_COMMIT_FAILED");
  assert.equal(result.simulatedSubmitInvocations, 0);
  assert.equal(result.phases.includes("SIMULATED_SINGLE_SUBMIT"), false);
});

test("send-claim read-back mismatch prevents submit", async () => {
  const result = await runFirstMessageProtocolSimulation({ fault: "SEND_CLAIM_READBACK_MISMATCH" });
  assert.equal(result.status, "BLOCKED");
  assert.equal(result.code, "SEND_CLAIM_READBACK_BLOCKED");
  assert.equal(result.simulatedSubmitInvocations, 0);
  assert.equal(result.phases.includes("SIMULATED_SINGLE_SUBMIT"), false);
});

test("uncertain submit is quarantined and never retried", async () => {
  const result = await runFirstMessageProtocolSimulation({ fault: "SUBMIT_UNCERTAIN" });
  assert.equal(result.status, "BLOCKED");
  assert.equal(result.code, "DELIVERY_UNCERTAIN");
  assert.equal(result.simulatedSubmitInvocations, 1);
  assert.equal(result.phases.filter(p => p === "SIMULATED_SINGLE_SUBMIT").length, 1);
  assert.equal(result.phases.includes("OBSERVE_POST_SEND"), false);
  assert.equal(result.phases.includes("RECONCILE_CONVERSATION"), false);
});

test("reused post-send conversation ID cannot be reconciled", async () => {
  const result = await runFirstMessageProtocolSimulation({ fault: "POST_SEND_ID_REUSED" });
  assert.equal(result.status, "BLOCKED");
  assert.equal(result.code, "CONVERSATION_ID_REUSED");
  assert.equal(result.simulatedSubmitInvocations, 1);
  assert.equal(result.simulatedLedgerConversationId, null);
  assert.equal(result.phases.includes("RECONCILE_CONVERSATION"), false);
});

test("reconciliation CAS conflict leaves the sent attempt unreconciled", async () => {
  const result = await runFirstMessageProtocolSimulation({ fault: "RECONCILE_CAS_CONFLICT" });
  assert.equal(result.status, "BLOCKED");
  assert.equal(result.code, "LEDGER_RECONCILIATION_FAILED");
  assert.equal(result.simulatedSubmitInvocations, 1);
  assert.equal(result.conversationIdCandidate, "simulated-chat-0002");
  assert.equal(result.simulatedLedgerConversationId, null);
});

test("reconciliation read-back mismatch is not reported as success", async () => {
  const result = await runFirstMessageProtocolSimulation({ fault: "RECONCILE_READBACK_MISMATCH" });
  assert.equal(result.status, "BLOCKED");
  assert.equal(result.code, "LEDGER_RECONCILIATION_FAILED");
  assert.equal(result.simulatedSubmitInvocations, 1);
  assert.equal(result.simulatedLedgerConversationId, null);
});

test("malformed simulation requests are rejected", async () => {
  for (const input of [null, 1, "bad", [], { fault: "RETRY_UNCERTAIN" }]) {
    const result = await runFirstMessageProtocolSimulation(input);
    assert.equal(result.status, "BLOCKED");
    assert.equal(result.code, "INVALID_SIMULATION_INPUT");
    assert.equal(result.authority, "NONE");
    assert.equal(result.externalIoPerformed, false);
    assert.equal(result.realBrowserSubmissions, 0);
  }
});
