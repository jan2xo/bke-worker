/**
 * Source-only preflight for a disposable ChatGPT conversation per execution attempt.
 *
 * This is a pure, UNTRUSTED projection. It neither verifies GitHub principals
 * nor grants browser navigation, prompt delivery, worker claim, or merge authority.
 * Live adapters MUST independently authenticate the provider, bind a dedicated
 * browser target, and reconcile durable GitHub attempt/ownership evidence.
 */
export const ATTEMPT_PROTOCOL_VERSION = 1 as const;
export const OBSERVATION_MAX_AGE_MS = 10_000;
export const CLOCK_SKEW_MS = 2_000;
const WORKER = /^[a-z0-9][a-z0-9-]{0,62}$/;
const ATTEMPT = /^[a-z0-9][a-z0-9-]{0,95}$/;
const REPO = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const SHA = /^[a-f0-9]{40}$/;

export type AttemptKind = "IMPLEMENT" | "REMEDIATE";
export type AttemptDelivery = "NOT_SENT" | "IN_FLIGHT" | "UNCERTAIN" | "COMPLETED";

export interface FreshAttemptRequest {
  protocolVersion: typeof ATTEMPT_PROTOCOL_VERSION;
  repository: string;
  workerId: string;
  prNumber: number;
  headSha: string;
  attemptId: string;
  kind: AttemptKind;
}

/** This input MUST be produced by a separately authenticated GitHub reader. */
export interface GitHubAssignmentObservation {
  repository: string;
  prNumber: number;
  currentHeadSha: string;
  assignedWorkerId: string;
  workerOpenPrAssignments: number;
  prAssignedWorkerCount: number;
  prOpen: boolean;
  previousAttemptResolved: boolean;
  currentAttemptId: string;
  currentAttemptDelivery: AttemptDelivery;
  /** Authoritative GitHub attempt ledger supplies prior target identity. */
  previousConversationId: string | null;
  /** Complete, non-truncated identities for this PR/worker, from GitHub. */
  priorConversationIds: string[];
  /** Trusted provider record timestamp, not a browser-page assertion. */
  attemptAuthorizedAt: string;
}

/** Status supplied by a browser page is observational and NOT identity proof. */
export interface ChatPageObservation {
  observedAt: string;
  url: string;
  visible: boolean;
  composerAvailable: boolean;
  turnBusy: boolean;
  tabId: number;
}

/**
 * A new-chat creation receipt from a future independently authenticated
 * isolated browser controller. No page/content-script claims can establish
 * this provenance. The pure model validates coherence ONLY; it cannot itself
 * authenticate this object or grant a send/navigation right.
 */
export interface NewConversationConfirmation {
  event: "NEW_CHAT_CREATED";
  attemptId: string;
  workerId: string;
  headSha: string;
  targetTabId: number;
  /** The URL observed by the controller immediately BEFORE New Chat. */
  beforeUrl: string;
  /** The URL observed by the controller AFTER New Chat. */
  afterUrl: string;
  newConversationId: string;
  creationStartedAt: string;
  confirmedAt: string;
}

export interface BrowserTargetObservation {
  current: ChatPageObservation;
  ownedTargetTabId: number;
  matchingWritableTargetCount: number;
  sharedWritableProfile: boolean;
  /** May be absent; absence MUST block candidate acceptance. */
  newConversation?: NewConversationConfirmation;
}

export interface FreshAttemptInput {
  request: FreshAttemptRequest;
  github: GitHubAssignmentObservation;
  browser: BrowserTargetObservation;
  nowIso: string;
}

export type GateCode =
  | "INVALID_INPUT"
  | "GITHUB_ASSIGNMENT_CONFLICT"
  | "GITHUB_HEAD_CHANGED"
  | "PR_NOT_RUNNABLE"
  | "ATTEMPT_NOT_AUTHORIZED"
  | "PREVIOUS_ATTEMPT_UNRESOLVED"
  | "DISPATCH_NOT_NEW"
  | "BROWSER_TARGET_AMBIGUOUS"
  | "CHATGPT_UI_UNAVAILABLE"
  | "CHATGPT_BUSY"
  | "CHATGPT_OBSERVATION_STALE"
  | "FRESH_CONVERSATION_UNCONFIRMED"
  | "FRESH_CONVERSATION_REUSED"
  | "FRESH_CONVERSATION_STALE"
  | "FRESH_CONVERSATION_CANDIDATE";

export interface FreshAttemptResult {
  decision: "BLOCKED" | "CANDIDATE_ONLY";
  code: GateCode;
  /** Deliberately NONE, even for a plausible fully synthetic proof. */
  authority: "NONE";
}

function blocked(code: GateCode): FreshAttemptResult {
  return { decision: "BLOCKED", code, authority: "NONE" };
}

const CONVERSATION_ID = /^[A-Za-z0-9_-]{8,128}$/;

/** Validate EVERY index, including holes ignored by Array.prototype.every().
 * An inherited element or an undefined slot must never count as GitHub history.
 */
function isDenseValidConversationHistory(value: unknown): value is string[] {
  if (!Array.isArray(value) || value.length > 1024) return false;
  for (let i = 0; i < value.length; i++) {
    if (!Object.hasOwn(value, i)) return false;
    const conversationId: unknown = value[i];
    if (typeof conversationId !== "string" ||
        !CONVERSATION_ID.test(conversationId)) return false;
  }
  return new Set(value).size === value.length;
}

function conversationIdFromUrl(raw: string): string | null {
  try {
    const url = new URL(raw);
    if (url.origin !== "https://chatgpt.com" || url.username || url.password ||
        url.search || url.hash) return null;
    const m = new RegExp("^/c/([A-Za-z0-9_-]{8,128})$").exec(url.pathname);
    return m ? (m[1] ?? null) : null;
  } catch { return null; }
}
function validIso(raw: string): number | null {
  if (!new RegExp("^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}[.][0-9]{3}Z$").test(raw)) return null;
  const ms = Date.parse(raw);
  return Number.isFinite(ms) && new Date(ms).toISOString() === raw ? ms : null;
}

/** No side effects, no HTTP, no browser APIs, no automatic retry or navigation. */
export function evaluateFreshAttempt(input: unknown): FreshAttemptResult {
  if (input === null || typeof input !== "object") return blocked("INVALID_INPUT");
  const root = input as Partial<FreshAttemptInput>;
  const req = root.request;
  const gh = root.github;
  const target = root.browser;
  if (!req || !gh || !target || !target.current) return blocked("INVALID_INPUT");
  const page = target.current;
  if (
    req.protocolVersion !== ATTEMPT_PROTOCOL_VERSION ||
    typeof req.workerId !== "string" || !WORKER.test(req.workerId) ||
    typeof req.repository !== "string" || !REPO.test(req.repository) ||
    typeof req.prNumber !== "number" || !Number.isSafeInteger(req.prNumber) || req.prNumber < 1 ||
    typeof req.headSha !== "string" || !SHA.test(req.headSha) ||
    typeof req.attemptId !== "string" || !ATTEMPT.test(req.attemptId) ||
    (req.kind !== "IMPLEMENT" && req.kind !== "REMEDIATE") ||
    typeof gh.currentHeadSha !== "string" || !SHA.test(gh.currentHeadSha) ||
    typeof gh.assignedWorkerId !== "string" ||
    typeof gh.workerOpenPrAssignments !== "number" ||
    typeof gh.prAssignedWorkerCount !== "number" ||
    typeof gh.previousAttemptResolved !== "boolean" ||
    typeof gh.prOpen !== "boolean" ||
    typeof gh.currentAttemptId !== "string" ||
    !["NOT_SENT", "IN_FLIGHT", "UNCERTAIN", "COMPLETED"].includes(gh.currentAttemptDelivery) ||
    typeof target.sharedWritableProfile !== "boolean" ||
    typeof page.url !== "string" || typeof page.observedAt !== "string" ||
    typeof page.visible !== "boolean" || typeof page.composerAvailable !== "boolean" ||
    typeof page.turnBusy !== "boolean" ||
    !Number.isSafeInteger(page.tabId) || page.tabId < 0 ||
    !Number.isSafeInteger(target.ownedTargetTabId) || target.ownedTargetTabId < 0 ||
    !Number.isSafeInteger(target.matchingWritableTargetCount) ||
    typeof root.nowIso !== "string"
  ) return blocked("INVALID_INPUT");

  if (gh.repository !== req.repository || gh.prNumber !== req.prNumber ||
      gh.assignedWorkerId !== req.workerId ||
      gh.workerOpenPrAssignments !== 1 || gh.prAssignedWorkerCount !== 1) {
    return blocked("GITHUB_ASSIGNMENT_CONFLICT");
  }
  if (gh.currentHeadSha !== req.headSha) return blocked("GITHUB_HEAD_CHANGED");
  if (!gh.prOpen) return blocked("PR_NOT_RUNNABLE");
  if (gh.currentAttemptId !== req.attemptId) return blocked("ATTEMPT_NOT_AUTHORIZED");
  if (!gh.previousAttemptResolved) return blocked("PREVIOUS_ATTEMPT_UNRESOLVED");
  if (gh.currentAttemptDelivery !== "NOT_SENT") return blocked("DISPATCH_NOT_NEW");
  if ((gh.previousConversationId !== null &&
       (typeof gh.previousConversationId !== "string" ||
        !CONVERSATION_ID.test(gh.previousConversationId))) ||
      !isDenseValidConversationHistory(gh.priorConversationIds) ||
      (gh.previousConversationId !== null &&
       !gh.priorConversationIds.includes(gh.previousConversationId)) ||
      typeof gh.attemptAuthorizedAt !== "string") {
    return blocked("FRESH_CONVERSATION_UNCONFIRMED");
  }
  if (target.sharedWritableProfile || target.matchingWritableTargetCount !== 1 ||
      page.tabId !== target.ownedTargetTabId) return blocked("BROWSER_TARGET_AMBIGUOUS");
  let url: URL;
  try { url = new URL(page.url); } catch { return blocked("CHATGPT_UI_UNAVAILABLE"); }
  if (url.protocol !== "https:" || url.origin !== "https://chatgpt.com" ||
      !page.visible || !page.composerAvailable) {
    return blocked("CHATGPT_UI_UNAVAILABLE");
  }
  if (page.turnBusy) return blocked("CHATGPT_BUSY");
  const now = Date.parse(root.nowIso);
  const observed = Date.parse(page.observedAt);
  if (!Number.isFinite(now) || !Number.isFinite(observed) ||
      !/^\d{4}-\d\d-\d\dT/.test(page.observedAt) ||
      !/^\d{4}-\d\d-\d\dT/.test(root.nowIso) ||
      observed > now + CLOCK_SKEW_MS || now - observed > OBSERVATION_MAX_AGE_MS) {
    return blocked("CHATGPT_OBSERVATION_STALE");
  }
  // Old-chat UI idle is NEVER fresh-chat proof. The authenticated future
  // controller must have made and observed a new chat for THIS attempt.
  const confirmed = target.newConversation;
  if (!confirmed || confirmed.event !== "NEW_CHAT_CREATED" ||
      confirmed.attemptId !== req.attemptId ||
      confirmed.workerId !== req.workerId ||
      confirmed.headSha !== req.headSha ||
      confirmed.targetTabId !== target.ownedTargetTabId ||
      typeof confirmed.beforeUrl !== "string" ||
      typeof confirmed.afterUrl !== "string" ||
      typeof confirmed.newConversationId !== "string" ||
      typeof confirmed.creationStartedAt !== "string" ||
      typeof confirmed.confirmedAt !== "string") {
    return blocked("FRESH_CONVERSATION_UNCONFIRMED");
  }
  const currentId = conversationIdFromUrl(page.url);
  const afterId = conversationIdFromUrl(confirmed.afterUrl);
  const beforeId = conversationIdFromUrl(confirmed.beforeUrl);
  if (!currentId || !afterId || !CONVERSATION_ID.test(confirmed.newConversationId) ||
      currentId !== afterId || currentId !== confirmed.newConversationId ||
      (gh.previousConversationId !== null && beforeId !== gh.previousConversationId) ||
      (gh.previousConversationId === null &&
       confirmed.beforeUrl !== "https://chatgpt.com/")) {
    return blocked("FRESH_CONVERSATION_UNCONFIRMED");
  }
  if (currentId === beforeId || currentId === gh.previousConversationId ||
      gh.priorConversationIds.includes(currentId)) {
    return blocked("FRESH_CONVERSATION_REUSED");
  }
  const authorizedAt = validIso(gh.attemptAuthorizedAt);
  const start = validIso(confirmed.creationStartedAt);
  const confirmedAt = validIso(confirmed.confirmedAt);
  if (authorizedAt === null || start === null || confirmedAt === null ||
      start < authorizedAt - CLOCK_SKEW_MS ||
      confirmedAt < start || confirmedAt > observed + CLOCK_SKEW_MS ||
      confirmedAt > now + CLOCK_SKEW_MS) {
    return blocked("FRESH_CONVERSATION_STALE");
  }
  // A structurally consistent receipt (even if forged) is ONLY a candidate.
  // The eventual actor MUST independently establish authenticated provider +
  // controller provenance and atomically fence delivery before ANY prompt.
  return { decision: "CANDIDATE_ONLY", code: "FRESH_CONVERSATION_CANDIDATE", authority: "NONE" };
}
