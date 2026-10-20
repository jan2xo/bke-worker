/**
 * F1-04 ordered first-message protocol.
 *
 * The live public entrypoint is intentionally inert until the F1-02 GitHub
 * provider and F1-03 trusted browser/controller adapters are integrated and
 * separately certified. The in-memory runner below executes the whole protocol
 * against private test doubles only; it cannot be configured with external ports.
 */
import {
  BOOTSTRAP_PROTOCOL_VERSION,
  evaluateBootstrapFence,
  type BootstrapBrowserObservation,
  type BootstrapEvent,
  type BootstrapFenceInput,
  type BootstrapRequest,
  type DurableFirstSendClaim,
  type DurablePreSendFence,
  type FirstMessageConversationReceipt,
  type GitHubBootstrapObservation,
  type SendClaimCommitReceipt,
} from "./bootstrap-fence.js";
import {
  ATTEMPT_PROTOCOL_VERSION,
  evaluateFreshChatLanding,
  type FreshAttemptInput,
  type FreshAttemptRequest,
  type GitHubAssignmentObservation,
  type BrowserTargetObservation,
} from "./fresh-attempt-gate.js";
import {
  FIRST_MESSAGE_LIVE_SEND_ENABLED,
  buildApprovedBootstrapPrompt,
  evaluateFirstMessageActuator,
  evaluateFirstMessageConfirmation,
} from "./first-message-actuator.js";

export type FirstMessageSimulationFault =
  | "NONE"
  | "FENCE_CAS_CONFLICT"
  | "FENCE_CAS_UNCERTAIN"
  | "FENCE_READBACK_MISMATCH"
  | "SEND_CLAIM_CAS_CONFLICT"
  | "SEND_CLAIM_CAS_UNCERTAIN"
  | "SEND_CLAIM_READBACK_MISMATCH"
  | "REOBSERVE_AFTER_CLAIM_THROW"
  | "SUBMIT_UNCERTAIN"
  | "SUBMIT_THROW_AFTER_INVOKE"
  | "POST_SEND_ID_REUSED"
  | "RECONCILE_CAS_CONFLICT"
  | "RECONCILE_READBACK_MISMATCH";

export type FirstMessageRuntimeCode =
  | "LIVE_SEND_DISABLED"
  | "TRUSTED_ADAPTERS_NOT_INSTALLED"
  | "INVALID_SIMULATION_INPUT"
  | "FRESH_LANDING_BLOCKED"
  | "PREPARE_BLOCKED"
  | "FENCE_COMMIT_FAILED"
  | "FENCE_READBACK_BLOCKED"
  | "ADAPTER_ERROR"
  | "SEND_CLAIM_COMMIT_FAILED"
  | "SEND_CLAIM_READBACK_BLOCKED"
  | "FIRST_SUBMISSION_BLOCKED"
  | "DELIVERY_UNCERTAIN"
  | "POST_SEND_CONFIRMATION_BLOCKED"
  | "LEDGER_RECONCILIATION_FAILED"
  | "SIMULATION_PASS";

export type ProtocolPhase =
  | "OBSERVE_INITIAL"
  | "VALIDATE_FRESH_LANDING"
  | "PREPARE_CANDIDATE"
  | "COMMIT_FENCE"
  | "READ_BACK_FENCE"
  | "VERIFY_FENCE"
  | "COMMIT_SEND_CLAIM"
  | "READ_BACK_SEND_CLAIM"
  | "REOBSERVE_AFTER_CLAIM"
  | "AUTHORIZE_FIRST_SUBMISSION"
  | "SIMULATED_SINGLE_SUBMIT"
  | "QUARANTINE_UNCERTAIN_DELIVERY"
  | "OBSERVE_POST_SEND"
  | "VALIDATE_CONVERSATION_RECEIPT"
  | "RECONCILE_CONVERSATION"
  | "READ_BACK_RECONCILIATION";

export interface FirstMessageRuntimeResult {
  status: "BLOCKED" | "SIMULATION_PASS";
  code: FirstMessageRuntimeCode | string;
  authority: "NONE";
  syntheticEvidence: boolean;
  externalIoPerformed: false;
  realBrowserSubmissions: 0;
  simulatedSubmitInvocations: number;
  phases: ProtocolPhase[];
  conversationIdCandidate: string | null;
  simulatedLedgerConversationId: string | null;
}

export interface FirstMessageSimulationOptions {
  fault?: FirstMessageSimulationFault;
}

export interface RuntimeBrowserSnapshot {
  fresh: BrowserTargetObservation;
  bootstrap: BootstrapBrowserObservation;
}

/** Port contract intended for the later certified adapters. No live adapter is
 * installed by this PR yet. The in-memory implementation below is private. */
export type LedgerCasWriteResult =
  | { status: "COMMITTED"; commitSha: string }
  | { status: "CONFLICT"; commitSha: null }
  | { status: "UNCERTAIN"; commitSha: string | null };

export interface FirstMessageLedgerPort {
  loadSnapshot(
    event: BootstrapEvent,
    browser: RuntimeBrowserSnapshot,
    nowIso: string,
  ): Promise<{ freshAttempt: FreshAttemptInput; bootstrap: BootstrapFenceInput }>;
  commitPreSendFence(fence: DurablePreSendFence): Promise<LedgerCasWriteResult>;
  readBackPreSendFence(commitSha: string): Promise<boolean>;
  consumeFirstSendClaim(claim: DurableFirstSendClaim): Promise<LedgerCasWriteResult>;
  readBackFirstSendClaim(commitSha: string): Promise<boolean>;
  reconcileConversation(receipt: FirstMessageConversationReceipt): Promise<{ ok: boolean; commitSha: string | null }>;
  readBackConversation(conversationId: string): Promise<boolean>;
  markDeliveryUncertain(): Promise<void>;
}

export interface FirstMessageBrowserPort {
  observe(nowIso: string): Promise<RuntimeBrowserSnapshot>;
  readonly submissionCount: number;
  submitOnce(
    prompt: string,
    binding: { attemptId: string; fenceId: string; claimId: string; targetId: string; profileId: string; targetTabId: number },
  ): Promise<{ status: "SENT" | "UNCERTAIN"; receipt: FirstMessageConversationReceipt | null }>;
}

function result(
  status: FirstMessageRuntimeResult["status"],
  code: FirstMessageRuntimeResult["code"],
  phases: ProtocolPhase[],
  simulatedSubmitInvocations = 0,
  conversationIdCandidate: string | null = null,
  simulatedLedgerConversationId: string | null = null,
  syntheticEvidence = true,
): FirstMessageRuntimeResult {
  return {
    status,
    code,
    authority: "NONE",
    syntheticEvidence,
    externalIoPerformed: false,
    realBrowserSubmissions: 0,
    simulatedSubmitInvocations,
    phases,
    conversationIdCandidate,
    simulatedLedgerConversationId,
  };
}

function validSimulationFault(value: unknown): value is FirstMessageSimulationFault {
  return typeof value === "string" && [
    "NONE",
    "FENCE_CAS_CONFLICT",
    "FENCE_CAS_UNCERTAIN",
    "FENCE_READBACK_MISMATCH",
    "SEND_CLAIM_CAS_CONFLICT",
    "SEND_CLAIM_CAS_UNCERTAIN",
    "SEND_CLAIM_READBACK_MISMATCH",
    "REOBSERVE_AFTER_CLAIM_THROW",
    "SUBMIT_UNCERTAIN",
    "SUBMIT_THROW_AFTER_INVOKE",
    "POST_SEND_ID_REUSED",
    "RECONCILE_CAS_CONFLICT",
    "RECONCILE_READBACK_MISMATCH",
  ].includes(value);
}

const BASE_TIME = Date.parse("2026-10-20T07:00:00.000Z");
function isoPlus(milliseconds: number): string {
  return new Date(BASE_TIME + milliseconds).toISOString();
}

const WORKER = "f1-sim-worker";
const REPOSITORY = "jan2xo/bke-worker";
const PR_NUMBER = 125;
const HEAD = "a".repeat(40);
const PREVIOUS_ID = "older-chat-0001";
const NEW_ID = "simulated-chat-0002";
const FENCE_ID = "fence-sim-0001";
const FENCE_SHA = "b".repeat(40);
const CLAIM_ID = "claim-sim-0001";
const CLAIM_SHA = "c".repeat(40);
const TARGET_ID = "target-sim-0001";
const PROFILE_ID = "profile-sim-0001";
const TAB_ID = 23;
const ATTEMPT_ID = "f1-sim-attempt-01";
const EXECUTION_ID = "f1-sim-execution-01";

class MemoryLedger implements FirstMessageLedgerPort {
  private fence: DurablePreSendFence | undefined;
  private fenceReadReceipt: BootstrapBrowserObservation["fenceCommitReceipt"];
  private claim: DurableFirstSendClaim | undefined;
  private claimReadReceipt: SendClaimCommitReceipt | undefined;
  private conversationReceipt: FirstMessageConversationReceipt | undefined;
  private state: GitHubBootstrapObservation["state"] = "AUTHORIZED_PREPARE";
  private delivery: GitHubBootstrapObservation["deliveryKnowledge"] = "NOT_SENT";
  private previousConversationId: string | null = PREVIOUS_ID;
  private priorConversationIds: string[] = [PREVIOUS_ID];
  private reconciledConversationId: string | null = null;
  private uncertain = false;

  constructor(private readonly fault: FirstMessageSimulationFault) {}

  async loadSnapshot(
    event: BootstrapEvent,
    browser: RuntimeBrowserSnapshot,
    nowIso: string,
  ): Promise<{ freshAttempt: FreshAttemptInput; bootstrap: BootstrapFenceInput }> {
    const bootstrapRequest: BootstrapRequest = {
      protocolVersion: BOOTSTRAP_PROTOCOL_VERSION,
      repository: REPOSITORY,
      workerId: WORKER,
      prNumber: PR_NUMBER,
      headSha: HEAD,
      attemptId: ATTEMPT_ID,
      executionId: EXECUTION_ID,
      event,
      targetId: TARGET_ID,
      profileId: PROFILE_ID,
      targetTabId: TAB_ID,
    };
    const github: GitHubBootstrapObservation = {
      repository: REPOSITORY,
      prNumber: PR_NUMBER,
      currentHeadSha: HEAD,
      assignedWorkerId: WORKER,
      workerOpenPrAssignments: 1,
      prAssignedWorkerCount: 1,
      prOpen: true,
      currentAttemptId: ATTEMPT_ID,
      state: this.state,
      previousAttemptResolved: true,
      deliveryKnowledge: this.delivery,
      previousConversationId: this.previousConversationId,
      priorConversationIds: [...this.priorConversationIds],
      attemptAuthorizedAt: isoPlus(0),
      ...(this.fence ? { fence: { ...this.fence } } : {}),
      ...(this.claim ? { sendClaim: { ...this.claim } } : {}),
      ...(this.claimReadReceipt ? { sendClaimCommitReceipt: { ...this.claimReadReceipt } } : {}),
    };
    const bootstrap: BootstrapFenceInput = {
      request: bootstrapRequest,
      github,
      browser: {
        ...browser.bootstrap,
        ...(this.fenceReadReceipt ? { fenceCommitReceipt: { ...this.fenceReadReceipt } } : {}),
        ...(this.conversationReceipt ? { firstMessageReceipt: { ...this.conversationReceipt } } : {}),
      },
      nowIso,
    };

    const freshRequest: FreshAttemptRequest = {
      protocolVersion: ATTEMPT_PROTOCOL_VERSION,
      repository: REPOSITORY,
      workerId: WORKER,
      prNumber: PR_NUMBER,
      headSha: HEAD,
      attemptId: ATTEMPT_ID,
      kind: "IMPLEMENT",
    };
    const freshGithub: GitHubAssignmentObservation = {
      repository: REPOSITORY,
      prNumber: PR_NUMBER,
      currentHeadSha: HEAD,
      assignedWorkerId: WORKER,
      workerOpenPrAssignments: 1,
      prAssignedWorkerCount: 1,
      prOpen: true,
      previousAttemptResolved: true,
      currentAttemptId: ATTEMPT_ID,
      currentAttemptDelivery: "NOT_SENT",
      previousConversationId: this.previousConversationId,
      priorConversationIds: [...this.priorConversationIds],
      attemptAuthorizedAt: isoPlus(0),
    };
    const freshAttempt: FreshAttemptInput = {
      request: freshRequest,
      github: freshGithub,
      browser: {
        current: {
          observedAt: browser.fresh.current.observedAt,
          url: browser.fresh.current.url,
          visible: browser.fresh.current.visible,
          composerAvailable: browser.fresh.current.composerAvailable,
          turnBusy: browser.fresh.current.turnBusy,
          tabId: browser.fresh.current.tabId,
          uiState: browser.fresh.current.uiState,
        },
        ownedTargetTabId: browser.fresh.ownedTargetTabId,
        ownedTargetId: TARGET_ID,
        ownedProfileId: PROFILE_ID,
        matchingWritableTargetCount: browser.fresh.matchingWritableTargetCount,
        sharedWritableProfile: browser.fresh.sharedWritableProfile,
        ...(browser.fresh.newConversation ? { newConversation: browser.fresh.newConversation } : {}),
      },
      nowIso,
    };
    return { freshAttempt, bootstrap };
  }

  async commitPreSendFence(fence: DurablePreSendFence): Promise<LedgerCasWriteResult> {
    if (this.fault === "FENCE_CAS_CONFLICT" || this.fence || fence.headSha !== HEAD) {
      return { status: "CONFLICT", commitSha: null };
    }
    this.fence = { ...fence };
    this.state = "FENCED_READY_TO_SEND";
    this.delivery = "NOT_SENT";
    if (this.fault === "FENCE_CAS_UNCERTAIN") {
      return { status: "UNCERTAIN", commitSha: null };
    }
    return { status: "COMMITTED", commitSha: fence.commitSha };
  }

  async readBackPreSendFence(commitSha: string): Promise<boolean> {
    if (!this.fence || commitSha !== this.fence.commitSha ||
        this.fault === "FENCE_READBACK_MISMATCH") return false;
    this.fenceReadReceipt = {
      event: "FENCE_COMMIT_RETURNED",
      fenceId: this.fence.fenceId,
      commitSha: this.fence.commitSha,
      attemptId: ATTEMPT_ID,
      workerId: WORKER,
      headSha: HEAD,
      targetId: TARGET_ID,
      profileId: PROFILE_ID,
      targetTabId: TAB_ID,
      executionId: EXECUTION_ID,
      observedAt: isoPlus(2500),
    };
    return true;
  }

  async consumeFirstSendClaim(claim: DurableFirstSendClaim): Promise<LedgerCasWriteResult> {
    if (this.fault === "SEND_CLAIM_CAS_CONFLICT" || !this.fence ||
        this.state !== "FENCED_READY_TO_SEND" || this.claim ||
        claim.fenceCommitSha !== this.fence.commitSha) {
      return { status: "CONFLICT", commitSha: null };
    }
    this.claim = { ...claim };
    this.state = "FENCED_MAY_HAVE_SENT";
    this.delivery = "MAY_HAVE_SENT";
    if (this.fault === "SEND_CLAIM_CAS_UNCERTAIN") {
      return { status: "UNCERTAIN", commitSha: null };
    }
    return { status: "COMMITTED", commitSha: claim.commitSha };
  }

  async readBackFirstSendClaim(commitSha: string): Promise<boolean> {
    if (!this.claim || !this.fence || commitSha !== this.claim.commitSha ||
        this.fault === "SEND_CLAIM_READBACK_MISMATCH") return false;
    this.claimReadReceipt = {
      event: "SEND_CLAIM_COMMIT_READ_BACK",
      claimId: this.claim.claimId,
      commitSha: this.claim.commitSha,
      fenceId: this.fence.fenceId,
      fenceCommitSha: this.fence.commitSha,
      attemptId: ATTEMPT_ID,
      workerId: WORKER,
      headSha: HEAD,
      targetId: TARGET_ID,
      profileId: PROFILE_ID,
      targetTabId: TAB_ID,
      executionId: EXECUTION_ID,
      observedAt: isoPlus(4500),
    };
    return true;
  }

  async reconcileConversation(receipt: FirstMessageConversationReceipt): Promise<{ ok: boolean; commitSha: string | null }> {
    if (this.fault === "RECONCILE_CAS_CONFLICT" || !this.claim ||
        receipt.sendClaimCommitSha !== this.claim.commitSha ||
        this.priorConversationIds.includes(receipt.conversationId)) {
      return { ok: false, commitSha: null };
    }
    this.conversationReceipt = { ...receipt };
    this.reconciledConversationId = receipt.conversationId;
    this.state = "CONFIRMED_NEW_CONVERSATION";
    this.delivery = "CONFIRMED";
    this.previousConversationId = receipt.conversationId;
    this.priorConversationIds = [...this.priorConversationIds, receipt.conversationId];
    return { ok: true, commitSha: "d".repeat(40) };
  }

  async readBackConversation(conversationId: string): Promise<boolean> {
    if (this.fault === "RECONCILE_READBACK_MISMATCH") return false;
    return this.state === "CONFIRMED_NEW_CONVERSATION" &&
      this.delivery === "CONFIRMED" &&
      this.reconciledConversationId === conversationId &&
      this.priorConversationIds.filter(id => id === conversationId).length === 1;
  }

  async markDeliveryUncertain(): Promise<void> {
    this.uncertain = true;
    this.state = "DELIVERY_UNCERTAIN";
    this.delivery = "UNCERTAIN";
  }

}

class MemoryBrowser implements FirstMessageBrowserPort {
  private submitted = false;
  private uncertain = false;
  private observedAfterSend = false;
  private receipt: FirstMessageConversationReceipt | null = null;
  submitCount = 0;

  constructor(private readonly fault: FirstMessageSimulationFault) {}

  async observe(nowIso: string): Promise<RuntimeBrowserSnapshot> {
    if (this.fault === "REOBSERVE_AFTER_CLAIM_THROW" && Date.parse(nowIso) === BASE_TIME + 4750) {
      throw new Error("synthetic controller observation failure after claim read-back");
    }
    const postSend = this.submitted && !this.uncertain;
    if (postSend) this.observedAfterSend = true;
    const observedAt = postSend ? isoPlus(6750) : (Date.parse(nowIso) > BASE_TIME + 4500 ? isoPlus(4750) : nowIso);
    const url = postSend ? `https://chatgpt.com/c/${this.receipt?.conversationId ?? NEW_ID}` : "https://chatgpt.com/";
    const uiState = postSend ? "THREAD" as const : "NEW_CHAT_LANDING" as const;
    const fresh: BrowserTargetObservation = {
      current: {
        observedAt,
        url,
        visible: true,
        composerAvailable: true,
        turnBusy: false,
        tabId: TAB_ID,
        uiState,
      },
      ownedTargetTabId: TAB_ID,
      ownedTargetId: TARGET_ID,
      ownedProfileId: PROFILE_ID,
      matchingWritableTargetCount: 1,
      sharedWritableProfile: false,
    };
    const bootstrap: BootstrapBrowserObservation = {
      ownedTargetId: TARGET_ID,
      ownedProfileId: PROFILE_ID,
      ownedTargetTabId: TAB_ID,
      matchingWritableTargetCount: 1,
      profileIsolated: true,
      sharedWritableProfile: false,
      current: {
        targetId: TARGET_ID,
        profileId: PROFILE_ID,
        tabId: TAB_ID,
        observedAt,
        url,
        uiState,
        visible: true,
        composerAvailable: true,
        turnBusy: false,
      },
      ...(this.receipt ? { firstMessageReceipt: { ...this.receipt } } : {}),
    };
    return { fresh, bootstrap };
  }

  async submitOnce(
    _prompt: string,
    binding: { attemptId: string; fenceId: string; claimId: string; targetId: string; profileId: string; targetTabId: number },
  ): Promise<{ status: "SENT" | "UNCERTAIN"; receipt: FirstMessageConversationReceipt | null }> {
    if (this.submitted || this.uncertain ||
        binding.attemptId !== ATTEMPT_ID || binding.fenceId !== FENCE_ID ||
        binding.claimId !== CLAIM_ID || binding.targetId !== TARGET_ID ||
        binding.profileId !== PROFILE_ID || binding.targetTabId !== TAB_ID) {
      return { status: "UNCERTAIN", receipt: null };
    }
    this.submitCount++;
    this.submitted = true;
    if (this.fault === "SUBMIT_THROW_AFTER_INVOKE") {
      this.uncertain = true;
      throw new Error("synthetic submit adapter threw after invocation");
    }
    if (this.fault === "SUBMIT_UNCERTAIN") {
      this.uncertain = true;
      return { status: "UNCERTAIN", receipt: null };
    }
    const conversationId = this.fault === "POST_SEND_ID_REUSED" ? PREVIOUS_ID : NEW_ID;
    this.receipt = {
      event: "FIRST_MESSAGE_CREATED_CONVERSATION",
      attemptId: ATTEMPT_ID,
      workerId: WORKER,
      headSha: HEAD,
      fenceId: FENCE_ID,
      fenceCommitSha: FENCE_SHA,
      sendClaimId: CLAIM_ID,
      sendClaimCommitSha: CLAIM_SHA,
      targetId: TARGET_ID,
      profileId: PROFILE_ID,
      targetTabId: TAB_ID,
      beforeUrl: "https://chatgpt.com/",
      afterUrl: `https://chatgpt.com/c/${conversationId}`,
      conversationId,
      sendStartedAt: isoPlus(5500),
      confirmedAt: isoPlus(6500),
    };
    return { status: "SENT", receipt: { ...this.receipt } };
  }

  get submissionCount(): number { return this.submitCount; }
}

function makeFence(): DurablePreSendFence {
  return {
    durable: true,
    fenceId: FENCE_ID,
    commitSha: FENCE_SHA,
    attemptId: ATTEMPT_ID,
    workerId: WORKER,
    headSha: HEAD,
    targetId: TARGET_ID,
    profileId: PROFILE_ID,
    targetTabId: TAB_ID,
    executionId: EXECUTION_ID,
    generation: 1,
    committedAt: isoPlus(2000),
  };
}

function makeClaim(): DurableFirstSendClaim {
  return {
    durable: true,
    claimId: CLAIM_ID,
    commitSha: CLAIM_SHA,
    fenceId: FENCE_ID,
    fenceCommitSha: FENCE_SHA,
    attemptId: ATTEMPT_ID,
    workerId: WORKER,
    headSha: HEAD,
    targetId: TARGET_ID,
    profileId: PROFILE_ID,
    targetTabId: TAB_ID,
    executionId: EXECUTION_ID,
    generation: 1,
    claimedAt: isoPlus(4000),
  };
}

async function executeProtocol(
  ledger: FirstMessageLedgerPort,
  browser: FirstMessageBrowserPort,
): Promise<FirstMessageRuntimeResult> {
  const phases: ProtocolPhase[] = [];
  let claimConsumed = false;
  let reconciliationCommitted = false;
  try {
    phases.push("OBSERVE_INITIAL");
    const initialObservation = await browser.observe(isoPlus(1000));
    const initialSnapshot = await ledger.loadSnapshot("PREPARE", initialObservation, isoPlus(1000));
    phases.push("VALIDATE_FRESH_LANDING");
    const freshResult = evaluateFreshChatLanding(initialSnapshot.freshAttempt);
    if (freshResult.decision !== "CANDIDATE_ONLY" || freshResult.code !== "FRESH_CHAT_LANDING_CANDIDATE") {
      return result("BLOCKED", "FRESH_LANDING_BLOCKED", phases);
    }
    const prepare = evaluateBootstrapFence(initialSnapshot.bootstrap);
    if (prepare.decision !== "CANDIDATE_ONLY" || prepare.code !== "PREPARE_CANDIDATE") {
      return result("BLOCKED", "PREPARE_BLOCKED", phases);
    }
    phases.push("PREPARE_CANDIDATE");
    const prompt = buildApprovedBootstrapPrompt(initialSnapshot.bootstrap.request);
    if (!prompt) return result("BLOCKED", "PREPARE_BLOCKED", phases);

    phases.push("COMMIT_FENCE");
    const fenceWrite = await ledger.commitPreSendFence(makeFence());
    if (fenceWrite.status !== "COMMITTED" || !fenceWrite.commitSha) {
      return result("BLOCKED", "FENCE_COMMIT_FAILED", phases);
    }
    phases.push("READ_BACK_FENCE");
    const fenceReadOk = await ledger.readBackPreSendFence(fenceWrite.commitSha);
    if (!fenceReadOk) return result("BLOCKED", "FENCE_READBACK_BLOCKED", phases);

    const fenceObservation = await browser.observe(isoPlus(3000));
    const fenceSnapshot = await ledger.loadSnapshot("VERIFY_FENCE_COMMIT", fenceObservation, isoPlus(3000));
    phases.push("VERIFY_FENCE");
    const fenceGate = evaluateBootstrapFence(fenceSnapshot.bootstrap);
    if (fenceGate.decision !== "CANDIDATE_ONLY" || fenceGate.code !== "FIRST_SEND_CAS_CANDIDATE") {
      return result("BLOCKED", "FENCE_READBACK_BLOCKED", phases);
    }

    phases.push("COMMIT_SEND_CLAIM");
    const claimWrite = await ledger.consumeFirstSendClaim(makeClaim());
    if (claimWrite.status === "CONFLICT") {
      return result("BLOCKED", "SEND_CLAIM_COMMIT_FAILED", phases);
    }
    if (claimWrite.status === "UNCERTAIN" || !claimWrite.commitSha) {
      claimConsumed = true;
      await ledger.markDeliveryUncertain();
      phases.push("QUARANTINE_UNCERTAIN_DELIVERY");
      return result("BLOCKED", "DELIVERY_UNCERTAIN", phases);
    }
    claimConsumed = true;

    phases.push("READ_BACK_SEND_CLAIM");
    const claimReadOk = await ledger.readBackFirstSendClaim(claimWrite.commitSha);
    if (!claimReadOk) {
      await ledger.markDeliveryUncertain();
      phases.push("QUARANTINE_UNCERTAIN_DELIVERY");
      return result("BLOCKED", "SEND_CLAIM_READBACK_BLOCKED", phases);
    }

    phases.push("REOBSERVE_AFTER_CLAIM");
    const afterClaimObservation = await browser.observe(isoPlus(4750));
    const submissionSnapshot = await ledger.loadSnapshot(
      "AUTHORIZE_FIRST_SUBMISSION",
      afterClaimObservation,
      isoPlus(5000),
    );
    phases.push("AUTHORIZE_FIRST_SUBMISSION");
    const authorization = evaluateFirstMessageActuator({
      freshAttempt: initialSnapshot.freshAttempt,
      bootstrap: submissionSnapshot.bootstrap,
      liveProofs: {
        githubCasOwnerCertified: true,
        nativePairingOwnerCertified: true,
        realBrowserOwnerAccepted: true,
      },
    });
    if (authorization.status !== "CANDIDATE_ONLY" || authorization.code !== "LIVE_SEND_DISABLED") {
      await ledger.markDeliveryUncertain();
      phases.push("QUARANTINE_UNCERTAIN_DELIVERY");
      return result("BLOCKED", "DELIVERY_UNCERTAIN", phases);
    }

    // This call is reachable only from the private simulation with in-memory
    // ports. The exported live entrypoint below never calls this protocol while
    // FIRST_MESSAGE_LIVE_SEND_ENABLED is false.
    phases.push("SIMULATED_SINGLE_SUBMIT");
    const binding = {
      attemptId: ATTEMPT_ID,
      fenceId: FENCE_ID,
      claimId: CLAIM_ID,
      targetId: TARGET_ID,
      profileId: PROFILE_ID,
      targetTabId: TAB_ID,
    };
    const submitted = await browser.submitOnce(prompt, binding);
    if (submitted.status === "UNCERTAIN" || !submitted.receipt) {
      await ledger.markDeliveryUncertain();
      phases.push("QUARANTINE_UNCERTAIN_DELIVERY");
      return result("BLOCKED", "DELIVERY_UNCERTAIN", phases, browser.submissionCount);
    }

    phases.push("OBSERVE_POST_SEND");
    const postSendObservation = await browser.observe(isoPlus(7000));
    const confirmationSnapshot = await ledger.loadSnapshot(
      "CONFIRM_NEW_CONVERSATION",
      postSendObservation,
      isoPlus(7000),
    );
    phases.push("VALIDATE_CONVERSATION_RECEIPT");
    const confirmation = evaluateFirstMessageConfirmation({
      freshAttempt: initialSnapshot.freshAttempt,
      bootstrap: confirmationSnapshot.bootstrap,
      liveProofs: {
        githubCasOwnerCertified: true,
        nativePairingOwnerCertified: true,
        realBrowserOwnerAccepted: true,
      },
    });
    if (confirmation.status !== "CANDIDATE_ONLY" ||
        confirmation.code !== "FIRST_MESSAGE_DELIVERY_CANDIDATE" ||
        confirmation.conversationIdCandidate !== submitted.receipt.conversationId) {
      await ledger.markDeliveryUncertain();
      phases.push("QUARANTINE_UNCERTAIN_DELIVERY");
      return result(
        "BLOCKED",
        confirmation.code,
        phases,
        browser.submissionCount,
        confirmation.conversationIdCandidate,
      );
    }

    phases.push("RECONCILE_CONVERSATION");
    const reconciled = await ledger.reconcileConversation(submitted.receipt);
    if (!reconciled.ok || !reconciled.commitSha) {
      await ledger.markDeliveryUncertain();
      phases.push("QUARANTINE_UNCERTAIN_DELIVERY");
      return result("BLOCKED", "LEDGER_RECONCILIATION_FAILED", phases, browser.submissionCount, submitted.receipt.conversationId);
    }
    reconciliationCommitted = true;

    phases.push("READ_BACK_RECONCILIATION");
    const reconciledReadBack = await ledger.readBackConversation(submitted.receipt.conversationId);
    if (!reconciledReadBack) {
      return result("BLOCKED", "LEDGER_RECONCILIATION_FAILED", phases, browser.submissionCount, submitted.receipt.conversationId);
    }
    return result(
      "SIMULATION_PASS",
      "SIMULATION_PASS",
      phases,
      browser.submissionCount,
      submitted.receipt.conversationId,
      submitted.receipt.conversationId,
    );
  } catch {
    if (reconciliationCommitted) {
      return result("BLOCKED", "LEDGER_RECONCILIATION_FAILED", phases, browser.submissionCount);
    }
    if (claimConsumed) {
      await ledger.markDeliveryUncertain().catch(() => undefined);
      if (!phases.includes("QUARANTINE_UNCERTAIN_DELIVERY")) {
        phases.push("QUARANTINE_UNCERTAIN_DELIVERY");
      }
      return result("BLOCKED", "DELIVERY_UNCERTAIN", phases, browser.submissionCount);
    }
    return result("BLOCKED", "ADAPTER_ERROR", phases, browser.submissionCount);
  }
}

async function executeInMemoryProtocol(fault: FirstMessageSimulationFault): Promise<FirstMessageRuntimeResult> {
  return executeProtocol(new MemoryLedger(fault), new MemoryBrowser(fault));
}

/** Snapshot used to preserve the first, pre-send GitHub history while validating
 * the later confirmation receipt against the same task/attempt identity. */
function initialObservationFreshSnapshot(
  snapshot: { freshAttempt: FreshAttemptInput; bootstrap: BootstrapFenceInput },
): FreshAttemptInput {
  return snapshot.freshAttempt;
}

/**
 * Production-call boundary. No input can install adapters. While the literal
 * live-send switch is false, this call performs zero IO and zero submissions.
 */
export async function runFirstMessageAttempt(_input: unknown): Promise<FirstMessageRuntimeResult> {
  if (!FIRST_MESSAGE_LIVE_SEND_ENABLED) {
    return result("BLOCKED", "LIVE_SEND_DISABLED", [], 0, null, null, false);
  }
  return result("BLOCKED", "TRUSTED_ADAPTERS_NOT_INSTALLED", []);
}

/**
 * Execute a deterministic end-to-end protocol simulation using only private
 * in-memory adapters. Output is explicitly synthetic and never authority.
 */
export async function runFirstMessageProtocolSimulation(
  input: unknown = {},
): Promise<FirstMessageRuntimeResult> {
  if (input === null || typeof input !== "object" || Array.isArray(input)) {
    return result("BLOCKED", "INVALID_SIMULATION_INPUT", []);
  }
  const faultValue = (input as Partial<FirstMessageSimulationOptions>).fault ?? "NONE";
  if (!validSimulationFault(faultValue)) {
    return result("BLOCKED", "INVALID_SIMULATION_INPUT", []);
  }
  return executeInMemoryProtocol(faultValue);
}
