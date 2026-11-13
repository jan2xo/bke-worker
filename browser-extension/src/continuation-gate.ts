/**
 * Source-only contract for F1-05 same-conversation continuation.
 *
 * Pure input projection only. This module does not call GitHub, persist a fence,
 * navigate, submit a prompt, or grant authority. Every result is non-authoritative.
 */
import {
  BOOTSTRAP_CLOCK_SKEW_MS,
  BOOTSTRAP_OBSERVATION_MAX_AGE_MS,
  MAX_PRIOR_CONVERSATION_IDS,
  type ChatUiObservation,
  type ChatUiState,
  type DurableFirstSendClaim,
  type DurablePreSendFence,
  type FenceCommitReceipt,
  type SendClaimCommitReceipt,
} from "./bootstrap-fence.js";

export const CONTINUATION_PROTOCOL_VERSION = 1 as const;

const WORKER_ID = /^[a-z0-9][a-z0-9-]{0,62}$/;
const ATTEMPT_ID = /^[a-z0-9][a-z0-9-]{0,95}$/;
const REPOSITORY = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const SHA = /^[a-f0-9]{40}$/;
const IDENTIFIER = /^[A-Za-z0-9_-]{8,128}$/;
const ISO_UTC_MILLIS = /^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\.[0-9]{3}Z$/;

export type ContinuationState =
  | "UNAUTHORIZED"
  | "AUTHORIZED_PREPARE"
  | "FENCED_READY_TO_SEND"
  | "FENCED_MAY_HAVE_SENT"
  | "CONFIRMED_SAME_CONVERSATION"
  | "DELIVERY_UNCERTAIN"
  | "BLOCKED";

export type ContinuationEvent =
  | "PREPARE_CONTINUATION"
  | "VERIFY_CONTINUATION_FENCE"
  | "AUTHORIZE_CONTINUATION_SUBMISSION"
  | "CONFIRM_SAME_CONVERSATION"
  | "MARK_CONTINUATION_UNCERTAIN"
  | "RECOVER_AFTER_RESTART";

export type ContinuationDeliveryKnowledge =
  | "NOT_SENT"
  | "MAY_HAVE_SENT"
  | "CONFIRMED"
  | "UNCERTAIN";

export interface ContinuationRequest {
  protocolVersion: typeof CONTINUATION_PROTOCOL_VERSION;
  repository: string;
  workerId: string;
  prNumber: number;
  headSha: string;
  attemptId: string;
  executionId: string;
  event: ContinuationEvent;
  expectedConversationId: string;
  expectedTurnNumber: number;
  targetId: string;
  profileId: string;
  targetTabId: number;
}

export interface ContinuationTurnReceipt {
  event: "CONTINUATION_SENT_IN_SAME_CONVERSATION";
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
  turnNumber: number;
  sendStartedAt: string;
  confirmedAt: string;
}

export interface GitHubContinuationObservation {
  repository: string;
  prNumber: number;
  currentHeadSha: string;
  assignedWorkerId: string;
  workerOpenPrAssignments: number;
  prAssignedWorkerCount: number;
  prOpen: boolean;
  currentAttemptId: string;
  state: ContinuationState;
  previousAttemptResolved: boolean;
  deliveryKnowledge: ContinuationDeliveryKnowledge;
  previousConversationId: string | null;
  priorConversationIds: string[];
  confirmedTurnCount: number;
  priorAttemptIds: string[];
  attemptAuthorizedAt: string;
  fence?: DurablePreSendFence;
  sendClaim?: DurableFirstSendClaim;
  sendClaimCommitReceipt?: SendClaimCommitReceipt;
}

export interface ContinuationBrowserObservation {
  ownedTargetId: string;
  ownedProfileId: string;
  ownedTargetTabId: number;
  matchingWritableTargetCount: number;
  profileIsolated: boolean;
  sharedWritableProfile: boolean;
  current: ChatUiObservation;
  fenceCommitReceipt?: FenceCommitReceipt;
  continuationReceipt?: ContinuationTurnReceipt;
}

export interface ContinuationGateInput {
  request: ContinuationRequest;
  github: GitHubContinuationObservation;
  browser: ContinuationBrowserObservation;
  nowIso: string;
}

export type ContinuationCode =
  | "INVALID_INPUT"
  | "GITHUB_ASSIGNMENT_CONFLICT"
  | "GITHUB_HEAD_CHANGED"
  | "PR_NOT_RUNNABLE"
  | "ATTEMPT_NOT_AUTHORIZED"
  | "ATTEMPT_REPLAY_DETECTED"
  | "PREVIOUS_ATTEMPT_UNRESOLVED"
  | "PRIOR_CONVERSATION_MISSING"
  | "PRIOR_HISTORY_INVALID"
  | "TURN_SEQUENCE_INVALID"
  | "ATTEMPT_STATE_CONFLICT"
  | "DURABLE_FENCE_REQUIRED"
  | "FENCE_INVALID"
  | "FENCE_REPLAY_OR_WRONG_EXECUTION"
  | "BROWSER_TARGET_CONFLICT"
  | "WRONG_CONVERSATION_OR_NEW_CHAT"
  | "CHATGPT_AUTH_REQUIRED"
  | "CHATGPT_BUSY"
  | "CHATGPT_UI_UNAVAILABLE"
  | "OBSERVATION_STALE"
  | "CONTINUATION_RECEIPT_INVALID"
  | "PREPARE_CONTINUATION_CANDIDATE"
  | "CONTINUATION_CAS_CANDIDATE"
  | "CONTINUATION_SUBMISSION_CANDIDATE"
  | "SAME_CONVERSATION_CANDIDATE"
  | "DELIVERY_UNCERTAIN"
  | "SAFE_TO_REEVALUATE_PREPARE"
  | "ATTEMPT_TERMINAL";

export interface ContinuationGateResult {
  decision: "BLOCKED" | "CANDIDATE_ONLY";
  state: ContinuationState;
  code: ContinuationCode;
  authority: "NONE";
}

function blocked(
  code: ContinuationCode,
  state: ContinuationState = "BLOCKED",
): ContinuationGateResult {
  return { decision: "BLOCKED", state, code, authority: "NONE" };
}

function candidate(
  state: ContinuationState,
  code: ContinuationCode,
): ContinuationGateResult {
  return { decision: "CANDIDATE_ONLY", state, code, authority: "NONE" };
}

function validIsoUtc(value: unknown): number | null {
  if (typeof value !== "string" || !ISO_UTC_MILLIS.test(value)) return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) && new Date(parsed).toISOString() === value ? parsed : null;
}

function denseValidIds(
  value: unknown,
  pattern: RegExp,
  maxLength: number,
): value is string[] {
  if (!Array.isArray(value) || value.length > maxLength) return false;
  for (let i = 0; i < value.length; i++) {
    if (!Object.hasOwn(value, i)) return false;
    const item: unknown = value[i];
    if (typeof item !== "string" || !pattern.test(item)) return false;
  }
  return new Set(value).size === value.length;
}

export function continuationConversationIdFromUrl(raw: string): string | null {
  try {
    const url = new URL(raw);
    if (
      url.origin !== "https://chatgpt.com" ||
      url.username ||
      url.password ||
      url.search ||
      url.hash
    ) {
      return null;
    }
    const match = /^\/c\/([A-Za-z0-9_-]{8,128})$/.exec(url.pathname);
    return match ? (match[1] ?? null) : null;
  } catch {
    return null;
  }
}

function targetMatchesRequest(input: ContinuationGateInput): boolean {
  const { request, browser } = input;
  const page = browser.current;
  return (
    browser.profileIsolated === true &&
    browser.sharedWritableProfile === false &&
    browser.matchingWritableTargetCount === 1 &&
    browser.ownedTargetId === request.targetId &&
    browser.ownedProfileId === request.profileId &&
    browser.ownedTargetTabId === request.targetTabId &&
    page.targetId === request.targetId &&
    page.profileId === request.profileId &&
    page.tabId === request.targetTabId
  );
}

function currentPageIsFresh(input: ContinuationGateInput): boolean {
  const now = validIsoUtc(input.nowIso);
  const observed = validIsoUtc(input.browser.current.observedAt);
  return (
    now !== null &&
    observed !== null &&
    observed <= now + BOOTSTRAP_CLOCK_SKEW_MS &&
    now - observed <= BOOTSTRAP_OBSERVATION_MAX_AGE_MS
  );
}

function sameConversationPageReady(
  input: ContinuationGateInput,
  expectedConversationId: string,
): ContinuationCode | null {
  const page = input.browser.current;
  if (page.uiState === "AUTH_REQUIRED") return "CHATGPT_AUTH_REQUIRED";
  if (page.uiState === "BUSY" || page.turnBusy) return "CHATGPT_BUSY";
  if (!currentPageIsFresh(input)) return "OBSERVATION_STALE";
  const observedId = continuationConversationIdFromUrl(page.url);
  if (page.uiState === "NEW_CHAT_LANDING" || page.url === "https://chatgpt.com/") {
    return "WRONG_CONVERSATION_OR_NEW_CHAT";
  }
  if (observedId !== null && observedId !== expectedConversationId) {
    return "WRONG_CONVERSATION_OR_NEW_CHAT";
  }
  if (
    !page.visible ||
    !page.composerAvailable ||
    page.uiState !== "THREAD" ||
    observedId !== expectedConversationId
  ) {
    return "CHATGPT_UI_UNAVAILABLE";
  }
  return null;
}

function validFence(input: ContinuationGateInput): boolean {
  const { request, github } = input;
  const fence = github.fence;
  if (fence === undefined || fence === null || typeof fence !== "object") return false;
  const authorizedAt = validIsoUtc(github.attemptAuthorizedAt);
  const committedAt = validIsoUtc(fence.committedAt);
  return (
    fence.durable === true &&
    typeof fence.fenceId === "string" &&
    IDENTIFIER.test(fence.fenceId) &&
    typeof fence.commitSha === "string" &&
    SHA.test(fence.commitSha) &&
    fence.attemptId === request.attemptId &&
    fence.workerId === request.workerId &&
    fence.headSha === request.headSha &&
    fence.targetId === request.targetId &&
    fence.profileId === request.profileId &&
    fence.targetTabId === request.targetTabId &&
    fence.executionId === request.executionId &&
    fence.generation === request.expectedTurnNumber &&
    authorizedAt !== null &&
    committedAt !== null &&
    committedAt >= authorizedAt - BOOTSTRAP_CLOCK_SKEW_MS
  );
}

function validFenceCommitReceipt(input: ContinuationGateInput): boolean {
  const { request, github, browser } = input;
  const receipt = browser.fenceCommitReceipt;
  const fence = github.fence;
  if (
    receipt === undefined ||
    receipt === null ||
    typeof receipt !== "object" ||
    fence === undefined ||
    fence === null ||
    typeof fence !== "object"
  ) {
    return false;
  }
  const now = validIsoUtc(input.nowIso);
  const receiptAt = validIsoUtc(receipt.observedAt);
  const committedAt = validIsoUtc(fence.committedAt);
  return (
    receipt.event === "FENCE_COMMIT_RETURNED" &&
    receipt.fenceId === fence.fenceId &&
    receipt.commitSha === fence.commitSha &&
    receipt.attemptId === request.attemptId &&
    receipt.workerId === request.workerId &&
    receipt.headSha === request.headSha &&
    receipt.targetId === request.targetId &&
    receipt.profileId === request.profileId &&
    receipt.targetTabId === request.targetTabId &&
    receipt.executionId === request.executionId &&
    receiptAt !== null &&
    committedAt !== null &&
    now !== null &&
    receiptAt >= committedAt &&
    receiptAt <= now + BOOTSTRAP_CLOCK_SKEW_MS &&
    now - receiptAt <= BOOTSTRAP_OBSERVATION_MAX_AGE_MS
  );
}

function validSendClaim(input: ContinuationGateInput): boolean {
  const { request, github } = input;
  const claim = github.sendClaim;
  const fence = github.fence;
  if (
    claim === undefined ||
    claim === null ||
    typeof claim !== "object" ||
    fence === undefined ||
    fence === null ||
    typeof fence !== "object"
  ) {
    return false;
  }
  const now = validIsoUtc(input.nowIso);
  const claimedAt = validIsoUtc(claim.claimedAt);
  const committedAt = validIsoUtc(fence.committedAt);
  return (
    claim.durable === true &&
    typeof claim.claimId === "string" &&
    IDENTIFIER.test(claim.claimId) &&
    typeof claim.commitSha === "string" &&
    SHA.test(claim.commitSha) &&
    claim.fenceId === fence.fenceId &&
    claim.fenceCommitSha === fence.commitSha &&
    claim.attemptId === request.attemptId &&
    claim.workerId === request.workerId &&
    claim.headSha === request.headSha &&
    claim.targetId === request.targetId &&
    claim.profileId === request.profileId &&
    claim.targetTabId === request.targetTabId &&
    claim.executionId === request.executionId &&
    claim.generation === request.expectedTurnNumber &&
    claimedAt !== null &&
    committedAt !== null &&
    now !== null &&
    claimedAt >= committedAt &&
    claimedAt <= now + BOOTSTRAP_CLOCK_SKEW_MS
  );
}

function validSendClaimCommitReceipt(input: ContinuationGateInput): boolean {
  const { request, github } = input;
  const receipt = github.sendClaimCommitReceipt;
  const claim = github.sendClaim;
  const fence = github.fence;
  if (
    receipt === undefined ||
    receipt === null ||
    typeof receipt !== "object" ||
    claim === undefined ||
    claim === null ||
    typeof claim !== "object" ||
    fence === undefined ||
    fence === null ||
    typeof fence !== "object"
  ) {
    return false;
  }
  const now = validIsoUtc(input.nowIso);
  const receiptAt = validIsoUtc(receipt.observedAt);
  const claimedAt = validIsoUtc(claim.claimedAt);
  return (
    receipt.event === "SEND_CLAIM_COMMIT_READ_BACK" &&
    receipt.claimId === claim.claimId &&
    receipt.commitSha === claim.commitSha &&
    receipt.fenceId === fence.fenceId &&
    receipt.fenceCommitSha === fence.commitSha &&
    receipt.attemptId === request.attemptId &&
    receipt.workerId === request.workerId &&
    receipt.headSha === request.headSha &&
    receipt.targetId === request.targetId &&
    receipt.profileId === request.profileId &&
    receipt.targetTabId === request.targetTabId &&
    receipt.executionId === request.executionId &&
    receiptAt !== null &&
    claimedAt !== null &&
    now !== null &&
    receiptAt >= claimedAt &&
    receiptAt <= now + BOOTSTRAP_CLOCK_SKEW_MS &&
    now - receiptAt <= BOOTSTRAP_OBSERVATION_MAX_AGE_MS
  );
}

const VALID_STATES = new Set<string>([
  "UNAUTHORIZED",
  "AUTHORIZED_PREPARE",
  "FENCED_READY_TO_SEND",
  "FENCED_MAY_HAVE_SENT",
  "CONFIRMED_SAME_CONVERSATION",
  "DELIVERY_UNCERTAIN",
  "BLOCKED",
]);

const VALID_UI_STATES = new Set<ChatUiState>([
  "NEW_CHAT_LANDING",
  "THREAD",
  "BUSY",
  "AUTH_REQUIRED",
  "UNKNOWN",
]);

/**
 * Pure continuation state evaluator. Validates coherence across GitHub authority,
 * durable pre-send fence/claim receipts, exact existing conversation ID, and
 * isolated target/tab observations. Performs zero IO and returns authority: "NONE".
 */
export function evaluateContinuationGate(input: unknown): ContinuationGateResult {
  if (input === null || typeof input !== "object" || Array.isArray(input)) {
    return blocked("INVALID_INPUT");
  }
  const root = input as Partial<ContinuationGateInput>;
  const request = root.request;
  const github = root.github;
  const browser = root.browser;
  if (!request || !github || !browser || !browser.current) {
    return blocked("INVALID_INPUT");
  }
  const page = browser.current;

  if (
    request.protocolVersion !== CONTINUATION_PROTOCOL_VERSION ||
    typeof request.repository !== "string" ||
    !REPOSITORY.test(request.repository) ||
    typeof request.workerId !== "string" ||
    !WORKER_ID.test(request.workerId) ||
    typeof request.prNumber !== "number" ||
    !Number.isSafeInteger(request.prNumber) ||
    request.prNumber < 1 ||
    typeof request.headSha !== "string" ||
    !SHA.test(request.headSha) ||
    typeof request.attemptId !== "string" ||
    !ATTEMPT_ID.test(request.attemptId) ||
    typeof request.executionId !== "string" ||
    !ATTEMPT_ID.test(request.executionId) ||
    ![
      "PREPARE_CONTINUATION",
      "VERIFY_CONTINUATION_FENCE",
      "AUTHORIZE_CONTINUATION_SUBMISSION",
      "CONFIRM_SAME_CONVERSATION",
      "MARK_CONTINUATION_UNCERTAIN",
      "RECOVER_AFTER_RESTART",
    ].includes(request.event) ||
    typeof request.expectedConversationId !== "string" ||
    !IDENTIFIER.test(request.expectedConversationId) ||
    typeof request.expectedTurnNumber !== "number" ||
    !Number.isSafeInteger(request.expectedTurnNumber) ||
    request.expectedTurnNumber < 2 ||
    typeof request.targetId !== "string" ||
    !IDENTIFIER.test(request.targetId) ||
    typeof request.profileId !== "string" ||
    !IDENTIFIER.test(request.profileId) ||
    !Number.isSafeInteger(request.targetTabId) ||
    request.targetTabId < 0 ||
    typeof github.repository !== "string" ||
    typeof github.prNumber !== "number" ||
    typeof github.currentHeadSha !== "string" ||
    !SHA.test(github.currentHeadSha) ||
    typeof github.assignedWorkerId !== "string" ||
    typeof github.workerOpenPrAssignments !== "number" ||
    typeof github.prAssignedWorkerCount !== "number" ||
    typeof github.prOpen !== "boolean" ||
    typeof github.currentAttemptId !== "string" ||
    !VALID_STATES.has(github.state) ||
    typeof github.previousAttemptResolved !== "boolean" ||
    !["NOT_SENT", "MAY_HAVE_SENT", "CONFIRMED", "UNCERTAIN"].includes(
      github.deliveryKnowledge,
    ) ||
    !(
      github.previousConversationId === null ||
      (typeof github.previousConversationId === "string" &&
        IDENTIFIER.test(github.previousConversationId))
    ) ||
    typeof github.confirmedTurnCount !== "number" ||
    !Number.isSafeInteger(github.confirmedTurnCount) ||
    github.confirmedTurnCount < 0 ||
    typeof github.attemptAuthorizedAt !== "string" ||
    typeof browser.ownedTargetId !== "string" ||
    typeof browser.ownedProfileId !== "string" ||
    !Number.isSafeInteger(browser.ownedTargetTabId) ||
    browser.ownedTargetTabId < 0 ||
    !Number.isSafeInteger(browser.matchingWritableTargetCount) ||
    typeof browser.profileIsolated !== "boolean" ||
    typeof browser.sharedWritableProfile !== "boolean" ||
    typeof page.targetId !== "string" ||
    typeof page.profileId !== "string" ||
    !Number.isSafeInteger(page.tabId) ||
    page.tabId < 0 ||
    typeof page.observedAt !== "string" ||
    typeof page.url !== "string" ||
    !VALID_UI_STATES.has(page.uiState) ||
    typeof page.visible !== "boolean" ||
    typeof page.composerAvailable !== "boolean" ||
    typeof page.turnBusy !== "boolean" ||
    typeof root.nowIso !== "string"
  ) {
    return blocked("INVALID_INPUT");
  }

  const typed = input as ContinuationGateInput;

  if (
    github.repository !== request.repository ||
    github.prNumber !== request.prNumber ||
    github.assignedWorkerId !== request.workerId ||
    github.workerOpenPrAssignments !== 1 ||
    github.prAssignedWorkerCount !== 1
  ) {
    return blocked("GITHUB_ASSIGNMENT_CONFLICT");
  }
  if (github.currentHeadSha !== request.headSha) return blocked("GITHUB_HEAD_CHANGED");
  if (!github.prOpen) return blocked("PR_NOT_RUNNABLE");
  if (github.currentAttemptId !== request.attemptId) return blocked("ATTEMPT_NOT_AUTHORIZED");
  if (!denseValidIds(github.priorAttemptIds, ATTEMPT_ID, 4096)) {
    return blocked("PRIOR_HISTORY_INVALID");
  }
  if (github.priorAttemptIds.includes(request.attemptId)) {
    return blocked("ATTEMPT_REPLAY_DETECTED");
  }
  if (!github.previousAttemptResolved) return blocked("PREVIOUS_ATTEMPT_UNRESOLVED");
  if (!denseValidIds(github.priorConversationIds, IDENTIFIER, MAX_PRIOR_CONVERSATION_IDS)) {
    return blocked("PRIOR_HISTORY_INVALID");
  }
  if (
    github.previousConversationId === null ||
    !github.priorConversationIds.includes(github.previousConversationId) ||
    github.previousConversationId !== request.expectedConversationId
  ) {
    return blocked("PRIOR_CONVERSATION_MISSING");
  }
  if (
    github.confirmedTurnCount < 1 ||
    github.confirmedTurnCount !== request.expectedTurnNumber - 1
  ) {
    return blocked("TURN_SEQUENCE_INVALID");
  }
  if (validIsoUtc(github.attemptAuthorizedAt) === null) return blocked("INVALID_INPUT");

  if (github.sendClaim !== undefined && github.state !== "FENCED_MAY_HAVE_SENT") {
    return blocked("FENCE_REPLAY_OR_WRONG_EXECUTION", github.state);
  }

  if (request.event === "RECOVER_AFTER_RESTART") {
    if (
      github.state === "FENCED_MAY_HAVE_SENT" ||
      github.state === "DELIVERY_UNCERTAIN" ||
      github.deliveryKnowledge === "MAY_HAVE_SENT" ||
      github.deliveryKnowledge === "UNCERTAIN"
    ) {
      return blocked("DELIVERY_UNCERTAIN", "DELIVERY_UNCERTAIN");
    }
    if (
      github.state === "AUTHORIZED_PREPARE" &&
      github.deliveryKnowledge === "NOT_SENT" &&
      github.fence === undefined
    ) {
      return candidate("AUTHORIZED_PREPARE", "SAFE_TO_REEVALUATE_PREPARE");
    }
    return blocked("ATTEMPT_TERMINAL", github.state);
  }

  if (github.state === "UNAUTHORIZED") return blocked("ATTEMPT_NOT_AUTHORIZED");
  if (github.state === "BLOCKED") return blocked("ATTEMPT_TERMINAL", "BLOCKED");
  if (
    github.state === "CONFIRMED_SAME_CONVERSATION" ||
    github.deliveryKnowledge === "CONFIRMED"
  ) {
    return blocked("ATTEMPT_TERMINAL", "CONFIRMED_SAME_CONVERSATION");
  }
  if (github.state === "DELIVERY_UNCERTAIN" || github.deliveryKnowledge === "UNCERTAIN") {
    return blocked("DELIVERY_UNCERTAIN", "DELIVERY_UNCERTAIN");
  }

  if (github.state === "FENCED_MAY_HAVE_SENT" || github.deliveryKnowledge === "MAY_HAVE_SENT") {
    if (
      github.state !== "FENCED_MAY_HAVE_SENT" ||
      github.deliveryKnowledge !== "MAY_HAVE_SENT"
    ) {
      return blocked("DELIVERY_UNCERTAIN", "DELIVERY_UNCERTAIN");
    }
    if (
      request.event !== "AUTHORIZE_CONTINUATION_SUBMISSION" &&
      request.event !== "CONFIRM_SAME_CONVERSATION"
    ) {
      return blocked("DELIVERY_UNCERTAIN", "DELIVERY_UNCERTAIN");
    }
  }

  if (github.state === "FENCED_READY_TO_SEND" && github.deliveryKnowledge !== "NOT_SENT") {
    return blocked("ATTEMPT_STATE_CONFLICT", github.state);
  }

  if (!targetMatchesRequest(typed)) {
    return blocked("BROWSER_TARGET_CONFLICT");
  }

  if (request.event === "PREPARE_CONTINUATION") {
    if (github.state !== "AUTHORIZED_PREPARE" || github.deliveryKnowledge !== "NOT_SENT") {
      return blocked(
        github.state === "FENCED_MAY_HAVE_SENT"
          ? "FENCE_REPLAY_OR_WRONG_EXECUTION"
          : "ATTEMPT_STATE_CONFLICT",
        github.state,
      );
    }
    if (github.fence !== undefined) return blocked("ATTEMPT_STATE_CONFLICT", github.state);
    const pageError = sameConversationPageReady(typed, request.expectedConversationId);
    if (pageError) return blocked(pageError, github.state);
    return candidate("AUTHORIZED_PREPARE", "PREPARE_CONTINUATION_CANDIDATE");
  }

  if (request.event === "VERIFY_CONTINUATION_FENCE") {
    if (github.state !== "FENCED_READY_TO_SEND" || github.deliveryKnowledge !== "NOT_SENT") {
      return blocked(
        github.state === "AUTHORIZED_PREPARE"
          ? "DURABLE_FENCE_REQUIRED"
          : "ATTEMPT_STATE_CONFLICT",
        github.state,
      );
    }
    if (github.sendClaim !== undefined) {
      return blocked("FENCE_REPLAY_OR_WRONG_EXECUTION", github.state);
    }
    if (!validFence(typed)) return blocked("FENCE_INVALID", github.state);
    if (!validFenceCommitReceipt(typed)) {
      return blocked("FENCE_REPLAY_OR_WRONG_EXECUTION", github.state);
    }
    const pageError = sameConversationPageReady(typed, request.expectedConversationId);
    if (pageError) return blocked(pageError, github.state);
    return candidate("FENCED_READY_TO_SEND", "CONTINUATION_CAS_CANDIDATE");
  }

  if (request.event === "AUTHORIZE_CONTINUATION_SUBMISSION") {
    if (github.state !== "FENCED_MAY_HAVE_SENT" || github.deliveryKnowledge !== "MAY_HAVE_SENT") {
      return blocked(
        github.state === "AUTHORIZED_PREPARE"
          ? "DURABLE_FENCE_REQUIRED"
          : "ATTEMPT_STATE_CONFLICT",
        github.state,
      );
    }
    if (!validFence(typed)) return blocked("FENCE_INVALID", github.state);
    if (!validSendClaim(typed)) return blocked("DELIVERY_UNCERTAIN", "DELIVERY_UNCERTAIN");
    if (!validSendClaimCommitReceipt(typed)) {
      return blocked("FENCE_REPLAY_OR_WRONG_EXECUTION", github.state);
    }
    const claimReadAt = validIsoUtc(github.sendClaimCommitReceipt?.observedAt);
    const pageObservedAt = validIsoUtc(page.observedAt);
    if (claimReadAt === null || pageObservedAt === null || pageObservedAt < claimReadAt) {
      return blocked("OBSERVATION_STALE", github.state);
    }
    const pageError = sameConversationPageReady(typed, request.expectedConversationId);
    if (pageError) return blocked(pageError, github.state);
    return candidate("FENCED_MAY_HAVE_SENT", "CONTINUATION_SUBMISSION_CANDIDATE");
  }

  if (request.event === "CONFIRM_SAME_CONVERSATION") {
    if (github.state !== "FENCED_MAY_HAVE_SENT" || github.deliveryKnowledge !== "MAY_HAVE_SENT") {
      return blocked(
        github.state === "AUTHORIZED_PREPARE"
          ? "DURABLE_FENCE_REQUIRED"
          : "ATTEMPT_STATE_CONFLICT",
        github.state,
      );
    }
    if (!validFence(typed)) return blocked("FENCE_INVALID", github.state);
    if (!validSendClaim(typed)) return blocked("DELIVERY_UNCERTAIN", "DELIVERY_UNCERTAIN");
    const pageError = sameConversationPageReady(typed, request.expectedConversationId);
    if (pageError) return blocked(pageError, github.state);

    const receipt = browser.continuationReceipt;
    const fence = github.fence;
    const sendClaim = github.sendClaim;
    const now = validIsoUtc(typed.nowIso);
    const observed = validIsoUtc(page.observedAt);
    const sentAt = validIsoUtc(receipt?.sendStartedAt);
    const confirmedAt = validIsoUtc(receipt?.confirmedAt);
    const expectedUrl = `https://chatgpt.com/c/${request.expectedConversationId}`;
    const observedId = continuationConversationIdFromUrl(page.url);
    const beforeId =
      typeof receipt?.beforeUrl === "string"
        ? continuationConversationIdFromUrl(receipt.beforeUrl)
        : null;
    const afterId =
      typeof receipt?.afterUrl === "string"
        ? continuationConversationIdFromUrl(receipt.afterUrl)
        : null;

    if (
      !receipt ||
      receipt.event !== "CONTINUATION_SENT_IN_SAME_CONVERSATION" ||
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
      receipt.beforeUrl !== expectedUrl ||
      receipt.afterUrl !== expectedUrl ||
      beforeId !== request.expectedConversationId ||
      afterId !== request.expectedConversationId ||
      observedId !== request.expectedConversationId ||
      receipt.conversationId !== request.expectedConversationId ||
      receipt.turnNumber !== request.expectedTurnNumber ||
      !sentAt ||
      !confirmedAt ||
      now === null ||
      observed === null ||
      sentAt < (validIsoUtc(sendClaim?.claimedAt) ?? Number.POSITIVE_INFINITY) ||
      confirmedAt < sentAt ||
      confirmedAt > observed + BOOTSTRAP_CLOCK_SKEW_MS ||
      confirmedAt > now + BOOTSTRAP_CLOCK_SKEW_MS
    ) {
      if (
        (afterId !== null && afterId !== request.expectedConversationId) ||
        (typeof receipt?.conversationId === "string" &&
          receipt.conversationId !== request.expectedConversationId)
      ) {
        return blocked("WRONG_CONVERSATION_OR_NEW_CHAT", github.state);
      }
      return blocked("CONTINUATION_RECEIPT_INVALID", github.state);
    }
    return candidate("CONFIRMED_SAME_CONVERSATION", "SAME_CONVERSATION_CANDIDATE");
  }

  if (request.event === "MARK_CONTINUATION_UNCERTAIN") {
    if (github.state === "FENCED_MAY_HAVE_SENT" && github.deliveryKnowledge === "MAY_HAVE_SENT") {
      return blocked("DELIVERY_UNCERTAIN", "DELIVERY_UNCERTAIN");
    }
    return blocked(
      github.state === "AUTHORIZED_PREPARE" ? "DURABLE_FENCE_REQUIRED" : "ATTEMPT_STATE_CONFLICT",
      github.state,
    );
  }

  return blocked("INVALID_INPUT");
}
