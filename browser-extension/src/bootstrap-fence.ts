/**
 * Source-only contract for the first-message bootstrap boundary.
 *
 * Pure input projection only. This module does not call GitHub, persist a fence,
 * navigate, submit a prompt, or grant authority. Every result is non-authoritative.
 */
export const BOOTSTRAP_PROTOCOL_VERSION = 1 as const;
export const BOOTSTRAP_OBSERVATION_MAX_AGE_MS = 10_000;
export const BOOTSTRAP_CLOCK_SKEW_MS = 2_000;
export const MAX_PRIOR_CONVERSATION_IDS = 1024;

const WORKER_ID = /^[a-z0-9][a-z0-9-]{0,62}$/;
const ATTEMPT_ID = /^[a-z0-9][a-z0-9-]{0,95}$/;
const REPOSITORY = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const SHA = /^[a-f0-9]{40}$/;
const IDENTIFIER = /^[A-Za-z0-9_-]{8,128}$/;
const ISO_UTC_MILLIS = /^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\.[0-9]{3}Z$/;

export type BootstrapState =
  | "UNAUTHORIZED"
  | "AUTHORIZED_PREPARE"
  | "FENCED_READY_TO_SEND"
  | "FENCED_MAY_HAVE_SENT"
  | "CONFIRMED_NEW_CONVERSATION"
  | "DELIVERY_UNCERTAIN"
  | "BLOCKED";

export type BootstrapEvent =
  | "PREPARE"
  | "VERIFY_FENCE_COMMIT"
  | "CONFIRM_NEW_CONVERSATION"
  | "MARK_DELIVERY_UNCERTAIN"
  | "RECOVER_AFTER_RESTART";

export type DeliveryKnowledge = "NOT_SENT" | "MAY_HAVE_SENT" | "CONFIRMED" | "UNCERTAIN";
export type ChatUiState = "NEW_CHAT_LANDING" | "THREAD" | "BUSY" | "AUTH_REQUIRED" | "UNKNOWN";

export interface BootstrapRequest {
  protocolVersion: typeof BOOTSTRAP_PROTOCOL_VERSION;
  repository: string;
  workerId: string;
  prNumber: number;
  headSha: string;
  attemptId: string;
  executionId: string;
  event: BootstrapEvent;
  targetId: string;
  profileId: string;
  targetTabId: number;
}

export interface DurablePreSendFence {
  durable: boolean;
  fenceId: string;
  commitSha: string;
  attemptId: string;
  workerId: string;
  headSha: string;
  targetId: string;
  profileId: string;
  targetTabId: number;
  executionId: string;
  generation: number;
  committedAt: string;
}

export interface DurableFirstSendClaim {
  durable: boolean;
  claimId: string;
  commitSha: string;
  fenceId: string;
  fenceCommitSha: string;
  attemptId: string;
  workerId: string;
  headSha: string;
  targetId: string;
  profileId: string;
  targetTabId: number;
  executionId: string;
  generation: number;
  claimedAt: string;
}

export interface FenceCommitReceipt {
  event: "FENCE_COMMIT_RETURNED";
  fenceId: string;
  commitSha: string;
  attemptId: string;
  workerId: string;
  headSha: string;
  targetId: string;
  profileId: string;
  targetTabId: number;
  executionId: string;
  observedAt: string;
}

export interface FirstMessageConversationReceipt {
  event: "FIRST_MESSAGE_CREATED_CONVERSATION";
  attemptId: string;
  workerId: string;
  headSha: string;
  fenceId: string;
  fenceCommitSha: string;
  sendClaimId: string;
  sendClaimCommitSha: string;
  targetId: string;
  profileId: string;
  targetTabId: number;
  beforeUrl: string;
  afterUrl: string;
  conversationId: string;
  sendStartedAt: string;
  confirmedAt: string;
}

export interface GitHubBootstrapObservation {
  repository: string;
  prNumber: number;
  currentHeadSha: string;
  assignedWorkerId: string;
  workerOpenPrAssignments: number;
  prAssignedWorkerCount: number;
  prOpen: boolean;
  currentAttemptId: string;
  state: BootstrapState;
  previousAttemptResolved: boolean;
  deliveryKnowledge: DeliveryKnowledge;
  previousConversationId: string | null;
  priorConversationIds: string[];
  attemptAuthorizedAt: string;
  fence?: DurablePreSendFence;
  /** Irreversible durable CAS marker; once present, this fence is consumed. */
  sendClaim?: DurableFirstSendClaim;
}

export interface ChatUiObservation {
  targetId: string;
  profileId: string;
  tabId: number;
  observedAt: string;
  url: string;
  uiState: ChatUiState;
  visible: boolean;
  composerAvailable: boolean;
  turnBusy: boolean;
}

export interface BootstrapBrowserObservation {
  ownedTargetId: string;
  ownedProfileId: string;
  ownedTargetTabId: number;
  matchingWritableTargetCount: number;
  profileIsolated: boolean;
  sharedWritableProfile: boolean;
  current: ChatUiObservation;
  fenceCommitReceipt?: FenceCommitReceipt;
  firstMessageReceipt?: FirstMessageConversationReceipt;
}

export interface BootstrapFenceInput {
  request: BootstrapRequest;
  github: GitHubBootstrapObservation;
  browser: BootstrapBrowserObservation;
  nowIso: string;
}

export type BootstrapCode =
  | "INVALID_INPUT"
  | "GITHUB_ASSIGNMENT_CONFLICT"
  | "GITHUB_HEAD_CHANGED"
  | "PR_NOT_RUNNABLE"
  | "ATTEMPT_NOT_AUTHORIZED"
  | "PREVIOUS_ATTEMPT_UNRESOLVED"
  | "PRIOR_HISTORY_INVALID"
  | "ATTEMPT_STATE_CONFLICT"
  | "DURABLE_FENCE_REQUIRED"
  | "FENCE_INVALID"
  | "FENCE_REPLAY_OR_WRONG_EXECUTION"
  | "BROWSER_TARGET_CONFLICT"
  | "CHATGPT_AUTH_REQUIRED"
  | "CHATGPT_BUSY"
  | "CHATGPT_UI_UNAVAILABLE"
  | "OBSERVATION_STALE"
  | "FIRST_MESSAGE_RECEIPT_INVALID"
  | "CONVERSATION_ID_REUSED"
  | "FENCE_CANDIDATE"
  | "PREPARE_CANDIDATE"
  | "FIRST_SEND_CAS_CANDIDATE"
  | "NEW_CONVERSATION_CANDIDATE"
  | "DELIVERY_UNCERTAIN"
  | "SAFE_TO_REEVALUATE_PREPARE"
  | "ATTEMPT_TERMINAL";

export interface BootstrapFenceResult {
  decision: "BLOCKED" | "CANDIDATE_ONLY";
  state: BootstrapState;
  code: BootstrapCode;
  /** Deliberately NONE, even for coherent synthetic or forged inputs. */
  authority: "NONE";
}

function blocked(code: BootstrapCode, state: BootstrapState = "BLOCKED"): BootstrapFenceResult {
  return { decision: "BLOCKED", state, code, authority: "NONE" };
}

function candidate(state: BootstrapState, code: BootstrapCode): BootstrapFenceResult {
  return { decision: "CANDIDATE_ONLY", state, code, authority: "NONE" };
}

function validIsoUtc(value: unknown): number | null {
  if (typeof value !== "string" || !ISO_UTC_MILLIS.test(value)) return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) && new Date(parsed).toISOString() === value ? parsed : null;
}

/** Validate all indices. Array methods such as every() alone skip sparse holes. */
function denseValidHistory(value: unknown): value is string[] {
  if (!Array.isArray(value) || value.length > MAX_PRIOR_CONVERSATION_IDS) return false;
  for (let index = 0; index < value.length; index++) {
    if (!Object.hasOwn(value, index)) return false;
    const item: unknown = value[index];
    if (typeof item !== "string" || !IDENTIFIER.test(item)) return false;
  }
  return new Set(value).size === value.length;
}

function conversationIdFromUrl(raw: string): string | null {
  try {
    const url = new URL(raw);
    if (url.origin !== "https://chatgpt.com" || url.username || url.password ||
        url.search || url.hash) return null;
    const match = /^\/c\/([A-Za-z0-9_-]{8,128})$/.exec(url.pathname);
    return match ? (match[1] ?? null) : null;
  } catch {
    return null;
  }
}

function targetMatchesRequest(input: BootstrapFenceInput): boolean {
  const request = input.request;
  const browser = input.browser;
  const page = browser.current;
  return browser.profileIsolated === true &&
    browser.sharedWritableProfile === false &&
    browser.matchingWritableTargetCount === 1 &&
    browser.ownedTargetId === request.targetId &&
    browser.ownedProfileId === request.profileId &&
    browser.ownedTargetTabId === request.targetTabId &&
    page.targetId === request.targetId &&
    page.profileId === request.profileId &&
    page.tabId === request.targetTabId;
}

function currentPageIsFresh(input: BootstrapFenceInput): boolean {
  const now = validIsoUtc((input as BootstrapFenceInput).nowIso);
  const observed = validIsoUtc(input.browser.current.observedAt);
  return now !== null && observed !== null &&
    observed <= now + BOOTSTRAP_CLOCK_SKEW_MS &&
    now - observed <= BOOTSTRAP_OBSERVATION_MAX_AGE_MS;
}

function landingPageReady(input: BootstrapFenceInput): BootstrapCode | null {
  const page = input.browser.current;
  if (page.uiState === "AUTH_REQUIRED") return "CHATGPT_AUTH_REQUIRED";
  if (page.uiState === "BUSY" || page.turnBusy) return "CHATGPT_BUSY";
  if (!currentPageIsFresh(input)) return "OBSERVATION_STALE";
  if (page.uiState !== "NEW_CHAT_LANDING" ||
      page.url !== "https://chatgpt.com/" ||
      !page.visible || !page.composerAvailable) return "CHATGPT_UI_UNAVAILABLE";
  return null;
}

function threadPageReady(input: BootstrapFenceInput): BootstrapCode | null {
  const page = input.browser.current;
  if (page.uiState === "AUTH_REQUIRED") return "CHATGPT_AUTH_REQUIRED";
  if (page.uiState === "BUSY" || page.turnBusy) return "CHATGPT_BUSY";
  if (!currentPageIsFresh(input)) return "OBSERVATION_STALE";
  if (!page.visible || !page.composerAvailable ||
      page.uiState !== "THREAD" || conversationIdFromUrl(page.url) === null) {
    return "CHATGPT_UI_UNAVAILABLE";
  }
  return null;
}

function validFence(input: BootstrapFenceInput): boolean {
  const { request, github } = input;
  const fence = github.fence;
  if (fence === undefined || fence === null || typeof fence !== "object") return false;
  const authorizedAt = validIsoUtc(github.attemptAuthorizedAt);
  const committedAt = validIsoUtc(fence.committedAt);
  return (
    fence.durable === true &&
    IDENTIFIER.test(fence.fenceId) &&
    SHA.test(fence.commitSha) &&
    fence.attemptId === request.attemptId &&
    fence.workerId === request.workerId &&
    fence.headSha === request.headSha &&
    fence.targetId === request.targetId &&
    fence.profileId === request.profileId &&
    fence.targetTabId === request.targetTabId &&
    fence.executionId === request.executionId &&
    fence.generation === 1 &&
    authorizedAt !== null &&
    committedAt !== null &&
    committedAt >= authorizedAt - BOOTSTRAP_CLOCK_SKEW_MS
  );
}

function validateFenceCommitReceipt(input: BootstrapFenceInput): boolean {
  const request = input.request;
  const receipt = input.browser.fenceCommitReceipt;
  const fence = input.github.fence;
  if (receipt === undefined || receipt === null || typeof receipt !== "object" ||
      fence === undefined || fence === null || typeof fence !== "object") return false;
  const now = validIsoUtc((input as BootstrapFenceInput).nowIso);
  const receiptAt = validIsoUtc(receipt.observedAt);
  const committedAt = validIsoUtc(fence.committedAt);
  return (
    receipt.event === "FENCE_COMMIT_RETURNED" &&
    fence !== undefined &&
    receipt.fenceId === fence.fenceId &&
    receipt.commitSha === fence.commitSha &&
    receipt.attemptId === request.attemptId &&
    receipt.workerId === request.workerId &&
    receipt.headSha === request.headSha &&
    receipt.targetId === request.targetId &&
    receipt.profileId === request.profileId &&
    receipt.targetTabId === request.targetTabId &&
    receipt.executionId === request.executionId &&
    receiptAt !== null && committedAt !== null && now !== null &&
    receiptAt >= committedAt &&
    receiptAt <= now + BOOTSTRAP_CLOCK_SKEW_MS &&
    now - receiptAt <= BOOTSTRAP_OBSERVATION_MAX_AGE_MS
  );
}

/**
 * Validate the durable compare-and-swap marker that consumes the one-shot send
 * opportunity. Its presence is terminal for first-send eligibility, even when
 * the surrounding caller-projected state appears to have regressed.
 */
function validSendClaim(input: BootstrapFenceInput): boolean {
  const request = input.request;
  const github = input.github;
  const claim = github.sendClaim;
  const fence = github.fence;
  if (claim === undefined || claim === null || typeof claim !== "object" ||
      fence === undefined || fence === null || typeof fence !== "object") return false;
  const now = validIsoUtc(input.nowIso);
  const claimedAt = validIsoUtc(claim?.claimedAt);
  const committedAt = validIsoUtc(fence?.committedAt);
  return claim !== undefined &&
    claim.durable === true &&
    IDENTIFIER.test(claim.claimId) &&
    SHA.test(claim.commitSha) &&
    claim.fenceId === fence?.fenceId &&
    claim.fenceCommitSha === fence?.commitSha &&
    claim.attemptId === request.attemptId &&
    claim.workerId === request.workerId &&
    claim.headSha === request.headSha &&
    claim.targetId === request.targetId &&
    claim.profileId === request.profileId &&
    claim.targetTabId === request.targetTabId &&
    claim.executionId === request.executionId &&
    claim.generation === 1 &&
    claimedAt !== null && committedAt !== null && now !== null &&
    claimedAt >= committedAt &&
    claimedAt <= now + BOOTSTRAP_CLOCK_SKEW_MS;
}

/**
 * Evaluate a proposed bootstrap transition from provider observations.
 * This function is pure and cannot authenticate those observations or perform a transition.
 */
export function evaluateBootstrapFence(input: unknown): BootstrapFenceResult {
  if (input === null || typeof input !== "object" || Array.isArray(input)) {
    return blocked("INVALID_INPUT");
  }
  const root = input as Partial<BootstrapFenceInput>;
  const request = root.request;
  const github = root.github;
  const browser = root.browser;
  if (!request || !github || !browser || !browser.current) return blocked("INVALID_INPUT");
  const page = browser.current;

  if (request.protocolVersion !== BOOTSTRAP_PROTOCOL_VERSION ||
      typeof request.repository !== "string" || !REPOSITORY.test(request.repository) ||
      typeof request.workerId !== "string" || !WORKER_ID.test(request.workerId) ||
      typeof request.prNumber !== "number" || !Number.isSafeInteger(request.prNumber) || request.prNumber < 1 ||
      typeof request.headSha !== "string" || !SHA.test(request.headSha) ||
      typeof request.attemptId !== "string" || !ATTEMPT_ID.test(request.attemptId) ||
      typeof request.executionId !== "string" || !ATTEMPT_ID.test(request.executionId) ||
      !["PREPARE", "VERIFY_FENCE_COMMIT", "CONFIRM_NEW_CONVERSATION",
        "MARK_DELIVERY_UNCERTAIN", "RECOVER_AFTER_RESTART"].includes(request.event) ||
      typeof request.targetId !== "string" || !IDENTIFIER.test(request.targetId) ||
      typeof request.profileId !== "string" || !IDENTIFIER.test(request.profileId) ||
      !Number.isSafeInteger(request.targetTabId) || request.targetTabId < 0 ||
      typeof github.repository !== "string" ||
      typeof github.prNumber !== "number" ||
      typeof github.currentHeadSha !== "string" || !SHA.test(github.currentHeadSha) ||
      typeof github.assignedWorkerId !== "string" ||
      typeof github.workerOpenPrAssignments !== "number" ||
      typeof github.prAssignedWorkerCount !== "number" ||
      typeof github.prOpen !== "boolean" ||
      typeof github.currentAttemptId !== "string" ||
      !["UNAUTHORIZED", "AUTHORIZED_PREPARE", "FENCED_READY_TO_SEND",
        "FENCED_MAY_HAVE_SENT", "CONFIRMED_NEW_CONVERSATION", "DELIVERY_UNCERTAIN", "BLOCKED"].includes(github.state) ||
      typeof github.previousAttemptResolved !== "boolean" ||
      !["NOT_SENT", "MAY_HAVE_SENT", "CONFIRMED", "UNCERTAIN"].includes(github.deliveryKnowledge) ||
      !(github.previousConversationId === null ||
        (typeof github.previousConversationId === "string" && IDENTIFIER.test(github.previousConversationId))) ||
      typeof github.attemptAuthorizedAt !== "string" ||
      typeof browser.ownedTargetId !== "string" ||
      typeof browser.ownedProfileId !== "string" ||
      !Number.isSafeInteger(browser.ownedTargetTabId) || browser.ownedTargetTabId < 0 ||
      !Number.isSafeInteger(browser.matchingWritableTargetCount) ||
      typeof browser.profileIsolated !== "boolean" ||
      typeof browser.sharedWritableProfile !== "boolean" ||
      typeof page.targetId !== "string" || typeof page.profileId !== "string" ||
      !Number.isSafeInteger(page.tabId) || page.tabId < 0 ||
      typeof page.observedAt !== "string" || typeof page.url !== "string" ||
      !["NEW_CHAT_LANDING", "THREAD", "BUSY", "AUTH_REQUIRED", "UNKNOWN"].includes(page.uiState) ||
      typeof page.visible !== "boolean" || typeof page.composerAvailable !== "boolean" ||
      typeof page.turnBusy !== "boolean" || typeof root.nowIso !== "string") {
    return blocked("INVALID_INPUT");
  }

  if (github.repository !== request.repository || github.prNumber !== request.prNumber ||
      github.assignedWorkerId !== request.workerId ||
      github.workerOpenPrAssignments !== 1 || github.prAssignedWorkerCount !== 1) {
    return blocked("GITHUB_ASSIGNMENT_CONFLICT");
  }
  if (github.currentHeadSha !== request.headSha) return blocked("GITHUB_HEAD_CHANGED");
  if (!github.prOpen) return blocked("PR_NOT_RUNNABLE");
  if (github.currentAttemptId !== request.attemptId) return blocked("ATTEMPT_NOT_AUTHORIZED");
  if (!github.previousAttemptResolved) return blocked("PREVIOUS_ATTEMPT_UNRESOLVED");
  if (!denseValidHistory(github.priorConversationIds) ||
      (github.previousConversationId !== null &&
       !github.priorConversationIds.includes(github.previousConversationId))) {
    return blocked("PRIOR_HISTORY_INVALID");
  }
  if (validIsoUtc(github.attemptAuthorizedAt) === null) return blocked("INVALID_INPUT");

  // Recovery is special: no browser observation can turn a post-fence crash into permission to resend.
  if (request.event === "RECOVER_AFTER_RESTART") {
    if (github.state === "FENCED_MAY_HAVE_SENT" ||
        github.state === "DELIVERY_UNCERTAIN" ||
        github.deliveryKnowledge === "MAY_HAVE_SENT" ||
        github.deliveryKnowledge === "UNCERTAIN") {
      return blocked("DELIVERY_UNCERTAIN", "DELIVERY_UNCERTAIN");
    }
    if (github.state === "AUTHORIZED_PREPARE" && github.deliveryKnowledge === "NOT_SENT" &&
        github.fence === undefined) {
      return candidate("AUTHORIZED_PREPARE", "SAFE_TO_REEVALUATE_PREPARE");
    }
    return blocked("ATTEMPT_TERMINAL", github.state);
  }

  if (github.state === "UNAUTHORIZED") return blocked("ATTEMPT_NOT_AUTHORIZED");
  if (github.state === "BLOCKED") return blocked("ATTEMPT_TERMINAL", "BLOCKED");
  if (github.state === "CONFIRMED_NEW_CONVERSATION" ||
      github.deliveryKnowledge === "CONFIRMED") return blocked("ATTEMPT_TERMINAL", "CONFIRMED_NEW_CONVERSATION");
  if (github.state === "DELIVERY_UNCERTAIN" ||
      github.deliveryKnowledge === "UNCERTAIN") {
    return blocked("DELIVERY_UNCERTAIN", "DELIVERY_UNCERTAIN");
  }

  // The pre-send fence and the one-shot send claim are separate durable phases.
  // A claimed/maybe-sent attempt is terminal for send-related events; only
  // identity confirmation may continue, and it must validate that same claim.
  if (github.state === "FENCED_MAY_HAVE_SENT" || github.deliveryKnowledge === "MAY_HAVE_SENT") {
    if (github.state !== "FENCED_MAY_HAVE_SENT" ||
        github.deliveryKnowledge !== "MAY_HAVE_SENT") {
      return blocked("DELIVERY_UNCERTAIN", "DELIVERY_UNCERTAIN");
    }
    if (request.event !== "CONFIRM_NEW_CONVERSATION") {
      return blocked("DELIVERY_UNCERTAIN", "DELIVERY_UNCERTAIN");
    }
  }

  // Even if a stale/in-memory state projection says NOT_SENT, the durable
  // sendClaim marker makes this fence consumed and permanently ineligible.
  if (github.sendClaim !== undefined && github.state !== "FENCED_MAY_HAVE_SENT") {
    return blocked("FENCE_REPLAY_OR_WRONG_EXECUTION", github.state);
  }

  if (github.state === "FENCED_READY_TO_SEND" && github.deliveryKnowledge !== "NOT_SENT") {
    return blocked("ATTEMPT_STATE_CONFLICT", github.state);
  }

  if (!targetMatchesRequest(input as BootstrapFenceInput)) {
    return blocked("BROWSER_TARGET_CONFLICT");
  }

  if (request.event === "PREPARE") {
    if (github.state !== "AUTHORIZED_PREPARE" || github.deliveryKnowledge !== "NOT_SENT") {
      return blocked(github.state === "FENCED_MAY_HAVE_SENT" ? "FENCE_REPLAY_OR_WRONG_EXECUTION" :
        "ATTEMPT_STATE_CONFLICT", github.state);
    }
    if (github.fence !== undefined) return blocked("ATTEMPT_STATE_CONFLICT", github.state);
    const pageError = landingPageReady(input as BootstrapFenceInput);
    if (pageError) return blocked(pageError, github.state);
    return candidate("AUTHORIZED_PREPARE", "PREPARE_CANDIDATE");
  }

  if (request.event === "VERIFY_FENCE_COMMIT") {
    // This event may only propose a CAS reservation while the durable pre-send
    // fence is still unconsumed. The returned candidate is NOT a send permit.
    if (github.state !== "FENCED_READY_TO_SEND" || github.deliveryKnowledge !== "NOT_SENT") {
      return blocked(github.state === "AUTHORIZED_PREPARE" ? "DURABLE_FENCE_REQUIRED" :
        github.state === "FENCED_MAY_HAVE_SENT" || github.deliveryKnowledge === "MAY_HAVE_SENT" ?
          "DELIVERY_UNCERTAIN" : "ATTEMPT_STATE_CONFLICT",
        github.state === "FENCED_MAY_HAVE_SENT" || github.deliveryKnowledge === "MAY_HAVE_SENT" ?
          "DELIVERY_UNCERTAIN" : github.state);
    }
    if (github.sendClaim !== undefined) {
      return blocked("FENCE_REPLAY_OR_WRONG_EXECUTION", github.state);
    }
    if (!validFence(input as BootstrapFenceInput)) return blocked("FENCE_INVALID", github.state);
    if (!validateFenceCommitReceipt(input as BootstrapFenceInput)) {
      return blocked("FENCE_REPLAY_OR_WRONG_EXECUTION", github.state);
    }
    const pageError = landingPageReady(input as BootstrapFenceInput);
    if (pageError) return blocked(pageError, github.state);
    return candidate("FENCED_READY_TO_SEND", "FIRST_SEND_CAS_CANDIDATE");
  }

  if (request.event === "CONFIRM_NEW_CONVERSATION") {
    if (github.state !== "FENCED_MAY_HAVE_SENT" || github.deliveryKnowledge !== "MAY_HAVE_SENT") {
      return blocked(github.state === "AUTHORIZED_PREPARE" ? "DURABLE_FENCE_REQUIRED" :
        "ATTEMPT_STATE_CONFLICT", github.state);
    }
    if (!validFence(input as BootstrapFenceInput)) return blocked("FENCE_INVALID", github.state);
    if (!validSendClaim(input as BootstrapFenceInput)) {
      return blocked("DELIVERY_UNCERTAIN", "DELIVERY_UNCERTAIN");
    }
    const pageError = threadPageReady(input as BootstrapFenceInput);
    if (pageError) return blocked(pageError, github.state);
    const receipt = browser.firstMessageReceipt;
    const fence = github.fence;
    const sendClaim = github.sendClaim;
    const now = validIsoUtc((input as BootstrapFenceInput).nowIso);
    const observed = validIsoUtc(page.observedAt);
    const sentAt = validIsoUtc(receipt?.sendStartedAt);
    const confirmedAt = validIsoUtc(receipt?.confirmedAt);
    const conversationId = conversationIdFromUrl(page.url);
    const afterId = typeof receipt?.afterUrl === "string" ? conversationIdFromUrl(receipt.afterUrl) : null;
    if (!receipt || receipt.event !== "FIRST_MESSAGE_CREATED_CONVERSATION" ||
        receipt.attemptId !== request.attemptId ||
        receipt.workerId !== request.workerId ||
        receipt.headSha !== request.headSha ||
        receipt.fenceId !== fence?.fenceId ||
        receipt.fenceCommitSha !== fence?.commitSha ||
        receipt.sendClaimId !== sendClaim?.claimId ||
        receipt.sendClaimCommitSha !== sendClaim?.commitSha ||
        receipt.targetId !== request.targetId ||
        receipt.profileId !== request.profileId ||
        receipt.targetTabId !== request.targetTabId ||
        receipt.beforeUrl !== "https://chatgpt.com/" ||
        !conversationId || conversationId !== afterId ||
        receipt.conversationId !== conversationId ||
        !sentAt || !confirmedAt || now === null || observed === null ||
        sentAt < (validIsoUtc(sendClaim?.claimedAt) ?? Number.POSITIVE_INFINITY) ||
        confirmedAt < sentAt ||
        confirmedAt > observed + BOOTSTRAP_CLOCK_SKEW_MS ||
        confirmedAt > now + BOOTSTRAP_CLOCK_SKEW_MS ||
        github.priorConversationIds.includes(conversationId)) {
      return blocked(github.priorConversationIds.includes(typeof receipt?.conversationId === "string" ? receipt.conversationId : "") ?
        "CONVERSATION_ID_REUSED" : "FIRST_MESSAGE_RECEIPT_INVALID", github.state);
    }
    return candidate("CONFIRMED_NEW_CONVERSATION", "NEW_CONVERSATION_CANDIDATE");
  }

  if (request.event === "MARK_DELIVERY_UNCERTAIN") {
    if (github.state === "FENCED_MAY_HAVE_SENT" &&
        github.deliveryKnowledge === "MAY_HAVE_SENT") {
      return blocked("DELIVERY_UNCERTAIN", "DELIVERY_UNCERTAIN");
    }
    return blocked(github.state === "AUTHORIZED_PREPARE" ? "DURABLE_FENCE_REQUIRED" :
      "ATTEMPT_STATE_CONFLICT", github.state);
  }

  return blocked("INVALID_INPUT");
}
