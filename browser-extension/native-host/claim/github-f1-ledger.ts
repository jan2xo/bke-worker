/**
 * F1-02 authenticated GitHub REST authority reader and durable CAS/receipt ledger.
 * Server-private only: never run or expose tokens inside a browser context.
 *
 * Implements:
 * - Installation & single-worker PR exclusivity discovery (open PR scan)
 * - Pinned GitHub App `bke-ticket` verification (`validateTicketInventory`)
 * - Atomic pre-send fence refs (`refs/bke/fences/{pr}/{attemptId}`)
 * - Atomic one-shot send-once claim refs (`refs/bke/claims/{pr}/{attemptId}` -> headSha)
 * - Fast-forward CAS conversation & turn receipt ledger (`refs/bke/conversations/{pr}`, `refs/bke/turns/{pr}/{attemptId}`)
 * - Irreversible uncertainty quarantine refs (`refs/bke/uncertain/{pr}/{attemptId}`)
 * - Adapter implementations for FirstMessageLedgerPort (F1-04) & ContinuationLedgerPort (F1-05)
 */
import {
  BOOTSTRAP_PROTOCOL_VERSION,
  type BootstrapBrowserObservation,
  type BootstrapEvent,
  type BootstrapFenceInput,
  type DurableFirstSendClaim,
  type DurablePreSendFence,
  type FirstMessageConversationReceipt,
  type GitHubBootstrapObservation,
  type SendClaimCommitReceipt,
} from '../../src/bootstrap-fence.js';
import {
  CONTINUATION_PROTOCOL_VERSION,
  type ContinuationBrowserObservation,
  type ContinuationEvent,
  type ContinuationGateInput,
  type ContinuationTurnReceipt,
  type GitHubContinuationObservation,
} from '../../src/continuation-gate.js';
import type {
  FirstMessageLedgerPort,
  LedgerCasWriteResult,
  RuntimeBrowserSnapshot,
} from '../../src/first-message-runtime.js';
import type {ContinuationLedgerPort} from '../../src/continuation-runtime.js';
import {
  ATTEMPT_PROTOCOL_VERSION,
  type FreshAttemptInput,
} from '../../src/fresh-attempt-gate.js';
import {
  validateTicketInventory,
  type CheckRunCandidate,
  type PinnedDispatcherApp,
  type ValidTicket,
} from '../../src/ticket-contract.js';
import type {HttpFetch, HttpResponse, TokenProvider} from './send-once-claim-adapter.js';

export interface LedgerHttpResponse extends HttpResponse {
  headers?: {get(name: string): string | null} | Record<string, string>;
}
export type LedgerHttpFetch = (
  url: string,
  init: RequestInit & {signal: AbortSignal},
) => Promise<LedgerHttpResponse>;

export interface GitHubF1LedgerConfig {
  repository: string;
  prNumber: number;
  headSha: string;
  workerId: string;
  authenticatedWorkerId: string;
  pinnedApp: PinnedDispatcherApp;
  executionId: string;
  targetId: string;
  profileId: string;
  targetTabId: number;
  timeoutMs?: number;
  nowIso?: () => string;
}

export interface ConversationTurnRecord {
  turnNumber: number;
  attemptId: string;
  headSha: string;
  conversationId: string;
  beforeUrl: string;
  afterUrl: string;
  fenceId: string;
  sendClaimId: string;
  recordedAt: string;
}

export interface ConversationLedgerPayload {
  bkeEvent: 'CONVERSATION_LEDGER_V1';
  version: 1;
  repository: string;
  prNumber: number;
  workerId: string;
  conversationId: string;
  turns: ConversationTurnRecord[];
}

export interface GitHubAuthoritySnapshot {
  repository: string;
  installationRepository: string;
  installationAuthenticated: boolean;
  prNumber: number;
  prOpen: boolean;
  headSha: string;
  assignedWorkerId: string;
  authenticatedWorkerId: string;
  activeWorkerPrCount: number;
  prWorkerCount: number;
  ticket: ValidTicket;
  consumedAttemptIds: string[];
  uncertainAttemptIds: string[];
  conversationTipSha: string | null;
  conversationLedger: ConversationLedgerPayload | null;
}

const SHA40 = /^[a-f0-9]{40}$/;
const REPO = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const WORKER = /^[a-z0-9][a-z0-9-]{0,62}$/;
const ATTEMPT = /^[a-z0-9][a-z0-9-]{0,95}$/;
const IDENTIFIER = /^[A-Za-z0-9_-]{8,128}$/;

function asRecord(value: unknown, code = 'GITHUB_RESPONSE_INVALID'): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw Error(code);
  }
  return value as Record<string, unknown>;
}

function asSha(value: unknown): string {
  if (typeof value !== 'string' || !SHA40.test(value)) {
    throw Error('GITHUB_SHA_INVALID');
  }
  return value;
}

function headerValue(res: LedgerHttpResponse, name: string): string | null {
  if (!res.headers) return null;
  if (typeof (res.headers as {get?: unknown}).get === 'function') {
    return (res.headers as {get(n: string): string | null}).get(name);
  }
  const rec = res.headers as Record<string, string>;
  const lower = name.toLowerCase();
  for (const [k, v] of Object.entries(rec)) {
    if (k.toLowerCase() === lower && typeof v === 'string') return v;
  }
  return null;
}

function hasNextPage(res: LedgerHttpResponse): boolean {
  const link = headerValue(res, 'link');
  return typeof link === 'string' && /;\s*rel=["']?next["']?/i.test(link);
}

function parseWorkerOwners(labels: unknown): string[] {
  if (!Array.isArray(labels)) throw Error('GITHUB_LABELS_MISSING');
  const owners: string[] = [];
  for (const raw of labels) {
    const label = asRecord(raw);
    if (typeof label.name !== 'string') throw Error('GITHUB_LABEL_INVALID');
    if (label.name.startsWith('bke-worker:')) {
      const id = label.name.slice('bke-worker:'.length);
      if (!WORKER.test(id)) throw Error('GITHUB_WORKER_LABEL_INVALID');
      owners.push(id);
    }
  }
  return owners;
}

export class GitHubF1Ledger implements FirstMessageLedgerPort, ContinuationLedgerPort {
  private readonly baseApi = 'https://api.github.com';
  private readonly repoRoot: string;
  private readonly timeoutMs: number;
  private readonly nowIsoFn: () => string;

  private authority: GitHubAuthoritySnapshot | null = null;
  private activeAttemptId: string | null = null;
  private activeAuthorizedAt: string | null = null;
  private activeFence: DurablePreSendFence | undefined;
  private activeFenceReadReceipt: BootstrapBrowserObservation['fenceCommitReceipt'];
  private activeClaim: DurableFirstSendClaim | undefined;
  private activeClaimReadReceipt: SendClaimCommitReceipt | undefined;
  private claimPostAttempted = false;
  private uncertain = false;
  private reconciledTurnConfirmed = false;
  private headTreeSha: string | null = null;

  constructor(
    private readonly config: GitHubF1LedgerConfig,
    private readonly fetch: LedgerHttpFetch | HttpFetch,
    private readonly tokenProvider: TokenProvider,
  ) {
    if (
      !config ||
      !REPO.test(config.repository) ||
      !Number.isSafeInteger(config.prNumber) ||
      config.prNumber < 1 ||
      !SHA40.test(config.headSha) ||
      !WORKER.test(config.workerId) ||
      config.authenticatedWorkerId !== config.workerId ||
      !ATTEMPT.test(config.executionId) ||
      !IDENTIFIER.test(config.targetId) ||
      !IDENTIFIER.test(config.profileId) ||
      !Number.isSafeInteger(config.targetTabId) ||
      config.targetTabId < 0
    ) {
      throw Error('GITHUB_LEDGER_CONFIG_INVALID');
    }
    const timeout = config.timeoutMs ?? 5_000;
    if (!Number.isSafeInteger(timeout) || timeout < 1 || timeout > 10_000) {
      throw Error('GITHUB_DEADLINE_INVALID');
    }
    this.timeoutMs = timeout;
    this.nowIsoFn = config.nowIso ?? (() => new Date().toISOString());
    this.repoRoot = `${this.baseApi}/repos/${config.repository}`;
  }

  private async request(
    method: 'GET' | 'POST' | 'PATCH',
    fullUrl: string,
    body?: unknown,
  ): Promise<{status: number; data: unknown; raw: LedgerHttpResponse}> {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => {
        controller.abort();
        reject(Error('GITHUB_TRANSPORT_UNCERTAIN'));
      }, this.timeoutMs);
    });
    const work = (async () => {
      let token: string;
      try {
        token = await this.tokenProvider();
      } catch {
        throw Error('GITHUB_AUTH_UNAVAILABLE');
      }
      if (typeof token !== 'string' || !token.trim()) {
        throw Error('GITHUB_AUTH_UNAVAILABLE');
      }
      if (controller.signal.aborted) {
        throw Error('GITHUB_TRANSPORT_UNCERTAIN');
      }
      let response: LedgerHttpResponse;
      try {
        response = await (this.fetch as LedgerHttpFetch)(fullUrl, {
          method,
          signal: controller.signal,
          headers: {
            Authorization: `Bearer ${token}`,
            Accept: 'application/vnd.github+json',
            'X-GitHub-Api-Version': '2022-11-28',
            ...(body === undefined ? {} : {'Content-Type': 'application/json'}),
          },
          ...(body === undefined ? {} : {body: JSON.stringify(body)}),
        });
      } catch {
        throw Error('GITHUB_TRANSPORT_UNCERTAIN');
      }
      if (response.status === 404) {
        return {status: 404, data: null, raw: response};
      }
      if (![200, 201, 422].includes(response.status)) {
        return {status: response.status, data: null, raw: response};
      }
      let parsed: unknown;
      try {
        parsed = await response.json();
      } catch {
        throw Error('GITHUB_RESPONSE_INVALID');
      }
      return {status: response.status, data: parsed, raw: response};
    })();
    try {
      return await Promise.race([work, deadline]);
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  }

  private fenceRef(attemptId: string): string {
    return `refs/bke/fences/${this.config.prNumber}/${attemptId}`;
  }

  private claimRef(attemptId: string): string {
    return `refs/bke/claims/${this.config.prNumber}/${attemptId}`;
  }

  private uncertainRef(attemptId: string): string {
    return `refs/bke/uncertain/${this.config.prNumber}/${attemptId}`;
  }

  private conversationRef(): string {
    return `refs/bke/conversations/${this.config.prNumber}`;
  }

  private turnRef(attemptId: string): string {
    return `refs/bke/turns/${this.config.prNumber}/${attemptId}`;
  }

  private async verifyInstallationRepository(): Promise<void> {
    const res = await this.request('GET', `${this.baseApi}/installation/repositories?per_page=100`);
    if (res.status !== 200) throw Error('GITHUB_INSTALLATION_UNAVAILABLE');
    if (hasNextPage(res.raw)) throw Error('GITHUB_INSTALLATION_PAGINATION_TRUNCATED');
    const body = asRecord(res.data);
    if (!Array.isArray(body.repositories)) throw Error('GITHUB_INSTALLATION_INVALID');
    const match = body.repositories.find((item) => {
      if (!item || typeof item !== 'object') return false;
      return (item as Record<string, unknown>).full_name === this.config.repository;
    });
    if (!match) throw Error('GITHUB_INSTALLATION_SCOPE_MISMATCH');
    const perms = asRecord((match as Record<string, unknown>).permissions, 'GITHUB_INSTALLATION_SCOPE_MISMATCH');
    if (perms.push !== true && perms.contents !== 'write') {
      throw Error('GITHUB_INSTALLATION_WRITE_SCOPE_MISSING');
    }
  }

  private async readTreeSha(commitSha: string): Promise<string> {
    if (this.headTreeSha && commitSha === this.config.headSha) return this.headTreeSha;
    const res = await this.request('GET', `${this.repoRoot}/git/commits/${commitSha}`);
    if (res.status !== 200) throw Error('GITHUB_COMMIT_READ_FAILED');
    const commit = asRecord(res.data);
    const tree = asRecord(commit.tree);
    const treeSha = asSha(tree.sha);
    if (commitSha === this.config.headSha) this.headTreeSha = treeSha;
    return treeSha;
  }

  private parseConversationPayload(message: string): ConversationLedgerPayload {
    let parsed: unknown;
    try {
      parsed = JSON.parse(message);
    } catch {
      throw Error('GITHUB_CONVERSATION_LEDGER_CORRUPT');
    }
    const obj = asRecord(parsed, 'GITHUB_CONVERSATION_LEDGER_CORRUPT');
    if (
      obj.bkeEvent !== 'CONVERSATION_LEDGER_V1' ||
      obj.version !== 1 ||
      obj.repository !== this.config.repository ||
      obj.prNumber !== this.config.prNumber ||
      obj.workerId !== this.config.workerId ||
      typeof obj.conversationId !== 'string' ||
      !IDENTIFIER.test(obj.conversationId) ||
      !Array.isArray(obj.turns) ||
      obj.turns.length < 1
    ) {
      throw Error('GITHUB_CONVERSATION_LEDGER_CORRUPT');
    }
    const turns: ConversationTurnRecord[] = [];
    for (let i = 0; i < obj.turns.length; i++) {
      const t = asRecord(obj.turns[i], 'GITHUB_CONVERSATION_LEDGER_CORRUPT');
      if (
        t.turnNumber !== i + 1 ||
        typeof t.attemptId !== 'string' ||
        !ATTEMPT.test(t.attemptId) ||
        typeof t.headSha !== 'string' ||
        !SHA40.test(t.headSha) ||
        t.conversationId !== obj.conversationId ||
        typeof t.beforeUrl !== 'string' ||
        typeof t.afterUrl !== 'string' ||
        typeof t.fenceId !== 'string' ||
        !IDENTIFIER.test(t.fenceId) ||
        typeof t.sendClaimId !== 'string' ||
        !IDENTIFIER.test(t.sendClaimId) ||
        typeof t.recordedAt !== 'string'
      ) {
        throw Error('GITHUB_CONVERSATION_LEDGER_CORRUPT');
      }
      turns.push(t as unknown as ConversationTurnRecord);
    }
    return {
      bkeEvent: 'CONVERSATION_LEDGER_V1',
      version: 1,
      repository: this.config.repository,
      prNumber: this.config.prNumber,
      workerId: this.config.workerId,
      conversationId: obj.conversationId,
      turns,
    };
  }

  async refreshAuthority(): Promise<GitHubAuthoritySnapshot> {
    await this.verifyInstallationRepository();

    // Enumerate open PRs (fail closed if pagination incomplete) to enforce 1:1 worker exclusivity
    const openPrs: Array<Record<string, unknown>> = [];
    for (let page = 1; page <= 5; page++) {
      const pullsRes = await this.request('GET', `${this.repoRoot}/pulls?state=open&per_page=100&page=${page}`);
      if (pullsRes.status !== 200 || !Array.isArray(pullsRes.data)) {
        throw Error('GITHUB_PULLS_READ_FAILED');
      }
      for (const p of pullsRes.data) {
        openPrs.push(asRecord(p));
      }
      if (!hasNextPage(pullsRes.raw)) break;
      if (page === 5) throw Error('GITHUB_PULLS_PAGINATION_TRUNCATED');
    }

    let activeWorkerPrCount = 0;
    let targetPr: Record<string, unknown> | null = null;
    for (const pr of openPrs) {
      const owners = parseWorkerOwners(pr.labels);
      if (owners.includes(this.config.workerId)) {
        activeWorkerPrCount++;
      }
      if (pr.number === this.config.prNumber) {
        targetPr = pr;
      }
    }

    if (!targetPr) {
      // Check if PR exists closed so state reflects prOpen = false accurately
      const singlePrRes = await this.request('GET', `${this.repoRoot}/pulls/${this.config.prNumber}`);
      if (singlePrRes.status !== 200) throw Error('GITHUB_PR_READ_FAILED');
      const closedPr = asRecord(singlePrRes.data);
      const headSha = asSha(asRecord(closedPr.head).sha);
      const owners = parseWorkerOwners(closedPr.labels);
      if (owners.length !== 1) throw Error('GITHUB_WORKER_ASSIGNMENT_AMBIGUOUS');
      throw Error('GITHUB_PR_NOT_OPEN');
    }

    const prHeadSha = asSha(asRecord(targetPr.head).sha);
    const prOwners = parseWorkerOwners(targetPr.labels);
    if (prOwners.length !== 1 || prOwners[0] !== this.config.workerId) {
      throw Error('GITHUB_WORKER_ASSIGNMENT_CONFLICT');
    }
    if (activeWorkerPrCount !== 1) {
      throw Error('GITHUB_WORKER_MULTI_PR_CONFLICT');
    }
    if (prHeadSha !== this.config.headSha) {
      throw Error('GITHUB_HEAD_CHANGED');
    }

    // Enumerate refs under refs/bke/ to discover consumed claims, uncertain markers, and conversation ledger
    const refsRes = await this.request('GET', `${this.repoRoot}/git/matching-refs/bke/`);
    if (refsRes.status !== 200 || !Array.isArray(refsRes.data)) {
      throw Error('GITHUB_REFS_READ_FAILED');
    }
    if (hasNextPage(refsRes.raw)) throw Error('GITHUB_REFS_PAGINATION_TRUNCATED');

    const claimPrefix = `refs/bke/claims/${this.config.prNumber}/`;
    const uncertainPrefix = `refs/bke/uncertain/${this.config.prNumber}/`;
    const consumedAttemptIds: string[] = [];
    const uncertainAttemptIds: string[] = [];
    let conversationTipSha: string | null = null;

    for (const rawRef of refsRes.data) {
      const refObj = asRecord(rawRef);
      if (typeof refObj.ref !== 'string') throw Error('GITHUB_REF_INVALID');
      const sha = asSha(asRecord(refObj.object).sha);
      if (refObj.ref.startsWith(claimPrefix)) {
        const id = refObj.ref.slice(claimPrefix.length);
        if (!ATTEMPT.test(id)) throw Error('GITHUB_CLAIM_REF_INVALID');
        consumedAttemptIds.push(id);
      } else if (refObj.ref.startsWith(uncertainPrefix)) {
        const id = refObj.ref.slice(uncertainPrefix.length);
        if (!ATTEMPT.test(id)) throw Error('GITHUB_UNCERTAIN_REF_INVALID');
        uncertainAttemptIds.push(id);
      } else if (refObj.ref === this.conversationRef()) {
        conversationTipSha = sha;
      }
    }

    if (uncertainAttemptIds.length > 0) {
      this.uncertain = true;
      throw Error('GITHUB_DELIVERY_UNCERTAIN_QUARANTINED');
    }

    let conversationLedger: ConversationLedgerPayload | null = null;
    if (conversationTipSha !== null) {
      const commitRes = await this.request('GET', `${this.repoRoot}/git/commits/${conversationTipSha}`);
      if (commitRes.status !== 200) throw Error('GITHUB_CONVERSATION_COMMIT_READ_FAILED');
      const commitObj = asRecord(commitRes.data);
      if (typeof commitObj.message !== 'string') throw Error('GITHUB_CONVERSATION_LEDGER_CORRUPT');
      conversationLedger = this.parseConversationPayload(commitObj.message);
    }

    // Fetch pinned check runs for exact headSha
    const checksRes = await this.request(
      'GET',
      `${this.repoRoot}/commits/${this.config.headSha}/check-runs?check_name=bke-ticket&per_page=100`,
    );
    if (checksRes.status !== 200) throw Error('GITHUB_CHECK_RUNS_READ_FAILED');
    const checksBody = asRecord(checksRes.data);
    if (!Array.isArray(checksBody.check_runs)) throw Error('GITHUB_CHECK_RUNS_INVALID');
    if (typeof checksBody.total_count === 'number' && checksBody.total_count > checksBody.check_runs.length) {
      throw Error('GITHUB_CHECK_RUNS_TRUNCATED');
    }
    if (hasNextPage(checksRes.raw)) throw Error('GITHUB_CHECK_RUNS_TRUNCATED');

    const nowMs = Date.parse(this.nowIsoFn());
    const ticketDecision = validateTicketInventory(checksBody.check_runs as CheckRunCandidate[], {
      pinnedApp: this.config.pinnedApp,
      currentHead: this.config.headSha,
      workerId: this.config.workerId,
      nowMs,
      consumedAttemptIds: new Set(consumedAttemptIds),
    });

    if (ticketDecision.code === 'AMBIGUOUS') throw Error('GITHUB_TICKET_AMBIGUOUS');
    if (ticketDecision.code !== 'VALID') throw Error('GITHUB_TICKET_INVALID_OR_CONSUMED');

    const snapshot: GitHubAuthoritySnapshot = {
      repository: this.config.repository,
      installationRepository: this.config.repository,
      installationAuthenticated: true,
      prNumber: this.config.prNumber,
      prOpen: true,
      headSha: prHeadSha,
      assignedWorkerId: prOwners[0]!,
      authenticatedWorkerId: this.config.authenticatedWorkerId,
      activeWorkerPrCount,
      prWorkerCount: prOwners.length,
      ticket: ticketDecision.ticket,
      consumedAttemptIds,
      uncertainAttemptIds,
      conversationTipSha,
      conversationLedger,
    };

    this.authority = snapshot;
    if (!this.activeAttemptId) {
      this.activeAttemptId = snapshot.ticket.attemptId;
      this.activeAuthorizedAt = this.nowIsoFn();
    } else if (this.activeAttemptId !== snapshot.ticket.attemptId) {
      throw Error('GITHUB_ATTEMPT_CHANGED_MID_EXECUTION');
    }
    return snapshot;
  }

  private async ensureAuthority(): Promise<GitHubAuthoritySnapshot> {
    if (!this.authority) {
      return this.refreshAuthority();
    }
    return this.authority;
  }

  private derivedBootstrapState(): GitHubBootstrapObservation['state'] {
    if (this.uncertain) return 'DELIVERY_UNCERTAIN';
    if (this.reconciledTurnConfirmed) return 'CONFIRMED_NEW_CONVERSATION';
    if (this.activeClaim) return 'FENCED_MAY_HAVE_SENT';
    if (this.activeFence) return 'FENCED_READY_TO_SEND';
    return 'AUTHORIZED_PREPARE';
  }

  private derivedContinuationState(): GitHubContinuationObservation['state'] {
    if (this.uncertain) return 'DELIVERY_UNCERTAIN';
    if (this.reconciledTurnConfirmed) return 'CONFIRMED_SAME_CONVERSATION';
    if (this.activeClaim) return 'FENCED_MAY_HAVE_SENT';
    if (this.activeFence) return 'FENCED_READY_TO_SEND';
    return 'AUTHORIZED_PREPARE';
  }

  private derivedDeliveryKnowledge(): 'NOT_SENT' | 'MAY_HAVE_SENT' | 'CONFIRMED' | 'UNCERTAIN' {
    if (this.uncertain) return 'UNCERTAIN';
    if (this.reconciledTurnConfirmed) return 'CONFIRMED';
    if (this.activeClaim) return 'MAY_HAVE_SENT';
    return 'NOT_SENT';
  }

  async loadSnapshot(
    event: BootstrapEvent,
    browser: RuntimeBrowserSnapshot,
    nowIso: string,
  ): Promise<{freshAttempt: FreshAttemptInput; bootstrap: BootstrapFenceInput}>;
  async loadSnapshot(
    event: ContinuationEvent,
    browser: ContinuationBrowserObservation,
    nowIso: string,
  ): Promise<ContinuationGateInput>;
  async loadSnapshot(
    event: BootstrapEvent | ContinuationEvent,
    browser: RuntimeBrowserSnapshot | ContinuationBrowserObservation,
    nowIso: string,
  ): Promise<{freshAttempt: FreshAttemptInput; bootstrap: BootstrapFenceInput} | ContinuationGateInput> {
    const auth = await this.ensureAuthority();
    const attemptId = this.activeAttemptId ?? auth.ticket.attemptId;
    const authorizedAt = this.activeAuthorizedAt ?? nowIso;
    const priorConvIds = auth.conversationLedger ? [auth.conversationLedger.conversationId] : [];
    const prevConvId = auth.conversationLedger ? auth.conversationLedger.conversationId : null;

    if (
      event === 'PREPARE_CONTINUATION' ||
      event === 'VERIFY_CONTINUATION_FENCE' ||
      event === 'AUTHORIZE_CONTINUATION_SUBMISSION' ||
      event === 'CONFIRM_SAME_CONVERSATION' ||
      event === 'MARK_CONTINUATION_UNCERTAIN' ||
      (event === 'RECOVER_AFTER_RESTART' && auth.conversationLedger !== null)
    ) {
      const contBrowser = browser as ContinuationBrowserObservation;
      const expectedConvId = auth.conversationLedger?.conversationId ?? 'missing-conversation-id';
      const confirmedTurns = auth.conversationLedger?.turns.length ?? 0;
      const priorAttemptIds = auth.conversationLedger
        ? auth.conversationLedger.turns.map((t) => t.attemptId)
        : [];
      return {
        request: {
          protocolVersion: CONTINUATION_PROTOCOL_VERSION,
          repository: this.config.repository,
          workerId: this.config.workerId,
          prNumber: this.config.prNumber,
          headSha: this.config.headSha,
          attemptId,
          executionId: this.config.executionId,
          event,
          expectedConversationId: expectedConvId,
          expectedTurnNumber: confirmedTurns + 1,
          targetId: this.config.targetId,
          profileId: this.config.profileId,
          targetTabId: this.config.targetTabId,
        },
        github: {
          repository: this.config.repository,
          prNumber: this.config.prNumber,
          currentHeadSha: auth.headSha,
          assignedWorkerId: auth.assignedWorkerId,
          workerOpenPrAssignments: auth.activeWorkerPrCount,
          prAssignedWorkerCount: auth.prWorkerCount,
          prOpen: auth.prOpen,
          currentAttemptId: attemptId,
          state: this.derivedContinuationState(),
          previousAttemptResolved: !this.uncertain,
          deliveryKnowledge: this.derivedDeliveryKnowledge(),
          previousConversationId: prevConvId,
          priorConversationIds: priorConvIds,
          confirmedTurnCount: confirmedTurns,
          priorAttemptIds,
          attemptAuthorizedAt: authorizedAt,
          ...(this.activeFence ? {fence: {...this.activeFence}} : {}),
          ...(this.activeClaim ? {sendClaim: {...this.activeClaim}} : {}),
          ...(this.activeClaimReadReceipt
            ? {sendClaimCommitReceipt: {...this.activeClaimReadReceipt}}
            : {}),
        },
        browser: {
          ...contBrowser,
          ...(this.activeFenceReadReceipt
            ? {fenceCommitReceipt: {...this.activeFenceReadReceipt}}
            : {}),
        },
        nowIso,
      };
    }

    const firstBrowser = browser as RuntimeBrowserSnapshot;
    return {
      freshAttempt: {
        request: {
          protocolVersion: ATTEMPT_PROTOCOL_VERSION,
          repository: this.config.repository,
          workerId: this.config.workerId,
          prNumber: this.config.prNumber,
          headSha: this.config.headSha,
          attemptId,
          kind: 'IMPLEMENT',
        },
        github: {
          repository: this.config.repository,
          prNumber: this.config.prNumber,
          currentHeadSha: auth.headSha,
          assignedWorkerId: auth.assignedWorkerId,
          workerOpenPrAssignments: auth.activeWorkerPrCount,
          prAssignedWorkerCount: auth.prWorkerCount,
          prOpen: auth.prOpen,
          previousAttemptResolved: !this.uncertain,
          currentAttemptId: attemptId,
          currentAttemptDelivery: 'NOT_SENT',
          previousConversationId: prevConvId,
          priorConversationIds: priorConvIds,
          attemptAuthorizedAt: authorizedAt,
        },
        browser: firstBrowser.fresh,
        nowIso,
      },
      bootstrap: {
        request: {
          protocolVersion: BOOTSTRAP_PROTOCOL_VERSION,
          repository: this.config.repository,
          workerId: this.config.workerId,
          prNumber: this.config.prNumber,
          headSha: this.config.headSha,
          attemptId,
          executionId: this.config.executionId,
          event,
          targetId: this.config.targetId,
          profileId: this.config.profileId,
          targetTabId: this.config.targetTabId,
        },
        github: {
          repository: this.config.repository,
          prNumber: this.config.prNumber,
          currentHeadSha: auth.headSha,
          assignedWorkerId: auth.assignedWorkerId,
          workerOpenPrAssignments: auth.activeWorkerPrCount,
          prAssignedWorkerCount: auth.prWorkerCount,
          prOpen: auth.prOpen,
          currentAttemptId: attemptId,
          state: this.derivedBootstrapState(),
          previousAttemptResolved: !this.uncertain,
          deliveryKnowledge: this.derivedDeliveryKnowledge(),
          previousConversationId: prevConvId,
          priorConversationIds: priorConvIds,
          attemptAuthorizedAt: authorizedAt,
          ...(this.activeFence ? {fence: {...this.activeFence}} : {}),
          ...(this.activeClaim ? {sendClaim: {...this.activeClaim}} : {}),
          ...(this.activeClaimReadReceipt
            ? {sendClaimCommitReceipt: {...this.activeClaimReadReceipt}}
            : {}),
        },
        browser: {
          ...firstBrowser.bootstrap,
          ...(this.activeFenceReadReceipt
            ? {fenceCommitReceipt: {...this.activeFenceReadReceipt}}
            : {}),
        },
        nowIso,
      },
    };
  }

  async commitPreSendFence(fence: DurablePreSendFence): Promise<LedgerCasWriteResult> {
    if (this.uncertain || this.activeFence) {
      return {status: 'CONFLICT', commitSha: null};
    }
    const auth = await this.ensureAuthority();
    if (fence.attemptId !== auth.ticket.attemptId || fence.headSha !== auth.headSha) {
      return {status: 'CONFLICT', commitSha: null};
    }
    try {
      const treeSha = await this.readTreeSha(fence.headSha);
      const commitPayload = {
        bkeEvent: 'PRE_SEND_FENCE',
        version: 1,
        fenceId: fence.fenceId,
        attemptId: fence.attemptId,
        workerId: fence.workerId,
        headSha: fence.headSha,
        targetId: fence.targetId,
        profileId: fence.profileId,
        targetTabId: fence.targetTabId,
        executionId: fence.executionId,
        generation: fence.generation,
        committedAt: fence.committedAt,
      };
      const commitRes = await this.request('POST', `${this.repoRoot}/git/commits`, {
        message: JSON.stringify(commitPayload),
        tree: treeSha,
        parents: [fence.headSha],
      });
      if (commitRes.status !== 201) return {status: 'UNCERTAIN', commitSha: null};
      const commitSha = asSha(asRecord(commitRes.data).sha);
      const ref = this.fenceRef(fence.attemptId);
      const refRes = await this.request('POST', `${this.repoRoot}/git/refs`, {
        ref,
        sha: commitSha,
      });
      if (refRes.status === 422) {
        const err = asRecord(refRes.data);
        if (err.message === 'Reference already exists') {
          return {status: 'CONFLICT', commitSha: null};
        }
        return {status: 'UNCERTAIN', commitSha: null};
      }
      if (refRes.status !== 201) return {status: 'UNCERTAIN', commitSha: null};
      const refBody = asRecord(refRes.data);
      if (refBody.ref !== ref || asSha(asRecord(refBody.object).sha) !== commitSha) {
        return {status: 'UNCERTAIN', commitSha: null};
      }
      this.activeFence = {...fence, commitSha};
      return {status: 'COMMITTED', commitSha};
    } catch {
      return {status: 'UNCERTAIN', commitSha: null};
    }
  }

  async readBackPreSendFence(commitSha: string): Promise<boolean> {
    if (!this.activeFence || this.activeFence.commitSha !== commitSha) return false;
    try {
      const ref = this.fenceRef(this.activeFence.attemptId);
      const refRes = await this.request(
        'GET',
        `${this.repoRoot}/git/ref/${ref.slice('refs/'.length)}`,
      );
      if (refRes.status !== 200) return false;
      const refBody = asRecord(refRes.data);
      if (refBody.ref !== ref || asSha(asRecord(refBody.object).sha) !== commitSha) {
        return false;
      }
      const commitRes = await this.request('GET', `${this.repoRoot}/git/commits/${commitSha}`);
      if (commitRes.status !== 200) return false;
      const msg = asRecord(JSON.parse(String(asRecord(commitRes.data).message)));
      if (
        msg.bkeEvent !== 'PRE_SEND_FENCE' ||
        msg.fenceId !== this.activeFence.fenceId ||
        msg.attemptId !== this.activeFence.attemptId ||
        msg.workerId !== this.activeFence.workerId ||
        msg.headSha !== this.activeFence.headSha ||
        msg.targetId !== this.activeFence.targetId ||
        msg.profileId !== this.activeFence.profileId ||
        msg.targetTabId !== this.activeFence.targetTabId ||
        msg.executionId !== this.activeFence.executionId
      ) {
        return false;
      }
      this.activeFenceReadReceipt = {
        event: 'FENCE_COMMIT_RETURNED',
        fenceId: this.activeFence.fenceId,
        commitSha,
        attemptId: this.activeFence.attemptId,
        workerId: this.activeFence.workerId,
        headSha: this.activeFence.headSha,
        targetId: this.activeFence.targetId,
        profileId: this.activeFence.profileId,
        targetTabId: this.activeFence.targetTabId,
        executionId: this.activeFence.executionId,
        observedAt: this.nowIsoFn(),
      };
      return true;
    } catch {
      return false;
    }
  }

  private async consumeClaimInternal(claim: DurableFirstSendClaim): Promise<LedgerCasWriteResult> {
    if (
      this.uncertain ||
      this.claimPostAttempted ||
      this.activeClaim ||
      !this.activeFence ||
      claim.fenceId !== this.activeFence.fenceId ||
      claim.fenceCommitSha !== this.activeFence.commitSha ||
      claim.attemptId !== this.activeFence.attemptId
    ) {
      return {status: 'CONFLICT', commitSha: null};
    }

    // Re-check live PR head and single-worker ownership before irrevocable claim POST.
    let prCheck;
    try {
      prCheck = await this.request('GET', `${this.repoRoot}/pulls/${this.config.prNumber}`);
    } catch {
      return {status: 'CONFLICT', commitSha: null};
    }
    if (prCheck.status !== 200) return {status: 'CONFLICT', commitSha: null};
    const pr = asRecord(prCheck.data);
    const prOwners = parseWorkerOwners(pr.labels);
    if (
      pr.state !== 'open' ||
      asSha(asRecord(pr.head).sha) !== this.config.headSha ||
      prOwners.length !== 1 ||
      prOwners[0] !== this.config.workerId
    ) {
      return {status: 'CONFLICT', commitSha: null};
    }

    this.claimPostAttempted = true;
    const ref = this.claimRef(claim.attemptId);
    try {
      const refRes = await this.request('POST', `${this.repoRoot}/git/refs`, {
        ref,
        sha: claim.headSha,
      });
      if (refRes.status === 422) {
        const err = asRecord(refRes.data);
        if (err.message === 'Reference already exists') {
          return {status: 'CONFLICT', commitSha: null};
        }
        return {status: 'UNCERTAIN', commitSha: null};
      }
      if (refRes.status !== 201) {
        return {status: 'UNCERTAIN', commitSha: null};
      }
      const data = asRecord(refRes.data);
      if (data.ref !== ref || asSha(asRecord(data.object).sha) !== claim.headSha) {
        return {status: 'UNCERTAIN', commitSha: null};
      }
      this.activeClaim = {...claim, commitSha: claim.headSha};
      return {status: 'COMMITTED', commitSha: claim.headSha};
    } catch {
      return {status: 'UNCERTAIN', commitSha: null};
    }
  }

  private async readBackClaimInternal(commitSha: string): Promise<boolean> {
    if (!this.activeClaim || !this.activeFence || commitSha !== this.config.headSha) {
      return false;
    }
    try {
      const ref = this.claimRef(this.activeClaim.attemptId);
      const refRes = await this.request(
        'GET',
        `${this.repoRoot}/git/ref/${ref.slice('refs/'.length)}`,
      );
      if (refRes.status !== 200) return false;
      const data = asRecord(refRes.data);
      if (data.ref !== ref || asSha(asRecord(data.object).sha) !== commitSha) {
        return false;
      }
      // Also confirm PR head & assignment remained unchanged
      const prRes = await this.request('GET', `${this.repoRoot}/pulls/${this.config.prNumber}`);
      if (prRes.status !== 200) return false;
      const pr = asRecord(prRes.data);
      const owners = parseWorkerOwners(pr.labels);
      if (
        pr.state !== 'open' ||
        asSha(asRecord(pr.head).sha) !== this.config.headSha ||
        owners.length !== 1 ||
        owners[0] !== this.config.workerId
      ) {
        return false;
      }
      this.activeClaimReadReceipt = {
        event: 'SEND_CLAIM_COMMIT_READ_BACK',
        claimId: this.activeClaim.claimId,
        commitSha,
        fenceId: this.activeFence.fenceId,
        fenceCommitSha: this.activeFence.commitSha,
        attemptId: this.activeClaim.attemptId,
        workerId: this.activeClaim.workerId,
        headSha: this.activeClaim.headSha,
        targetId: this.activeClaim.targetId,
        profileId: this.activeClaim.profileId,
        targetTabId: this.activeClaim.targetTabId,
        executionId: this.activeClaim.executionId,
        observedAt: this.nowIsoFn(),
      };
      return true;
    } catch {
      return false;
    }
  }

  consumeFirstSendClaim(claim: DurableFirstSendClaim): Promise<LedgerCasWriteResult> {
    return this.consumeClaimInternal(claim);
  }

  readBackFirstSendClaim(commitSha: string): Promise<boolean> {
    return this.readBackClaimInternal(commitSha);
  }

  consumeContinuationSendClaim(claim: DurableFirstSendClaim): Promise<LedgerCasWriteResult> {
    return this.consumeClaimInternal(claim);
  }

  readBackContinuationSendClaim(commitSha: string): Promise<boolean> {
    return this.readBackClaimInternal(commitSha);
  }

  private async commitConversationLedgerUpdate(
    turnRecord: ConversationTurnRecord,
    isFirstTurn: boolean,
  ): Promise<{ok: boolean; commitSha: string | null}> {
    const auth = await this.ensureAuthority();
    try {
      const treeSha = await this.readTreeSha(turnRecord.headSha);
      const existing = auth.conversationLedger;
      if (isFirstTurn && existing !== null) {
        return {ok: false, commitSha: null};
      }
      if (!isFirstTurn && (!existing || existing.conversationId !== turnRecord.conversationId)) {
        return {ok: false, commitSha: null};
      }
      const nextPayload: ConversationLedgerPayload = {
        bkeEvent: 'CONVERSATION_LEDGER_V1',
        version: 1,
        repository: this.config.repository,
        prNumber: this.config.prNumber,
        workerId: this.config.workerId,
        conversationId: turnRecord.conversationId,
        turns: existing ? [...existing.turns, turnRecord] : [turnRecord],
      };
      const parents = auth.conversationTipSha ? [auth.conversationTipSha] : [turnRecord.headSha];
      const commitRes = await this.request('POST', `${this.repoRoot}/git/commits`, {
        message: JSON.stringify(nextPayload),
        tree: treeSha,
        parents,
      });
      if (commitRes.status !== 201) return {ok: false, commitSha: null};
      const commitSha = asSha(asRecord(commitRes.data).sha);
      const convRef = this.conversationRef();
      if (isFirstTurn) {
        const refRes = await this.request('POST', `${this.repoRoot}/git/refs`, {
          ref: convRef,
          sha: commitSha,
        });
        if (refRes.status !== 201) return {ok: false, commitSha: null};
      } else {
        const refRes = await this.request(
          'PATCH',
          `${this.repoRoot}/git/refs/${convRef.slice('refs/'.length)}`,
          {sha: commitSha, force: false},
        );
        if (refRes.status !== 200) return {ok: false, commitSha: null};
      }

      // Record per-turn immutable ref as well
      const turnRef = this.turnRef(turnRecord.attemptId);
      const turnRefRes = await this.request('POST', `${this.repoRoot}/git/refs`, {
        ref: turnRef,
        sha: commitSha,
      });
      if (turnRefRes.status !== 201) return {ok: false, commitSha: null};

      auth.conversationTipSha = commitSha;
      auth.conversationLedger = nextPayload;
      this.reconciledTurnConfirmed = true;
      return {ok: true, commitSha};
    } catch {
      return {ok: false, commitSha: null};
    }
  }

  async reconcileConversation(
    receipt: FirstMessageConversationReceipt,
  ): Promise<{ok: boolean; commitSha: string | null}> {
    if (!this.activeClaim || receipt.sendClaimCommitSha !== this.activeClaim.commitSha) {
      return {ok: false, commitSha: null};
    }
    return this.commitConversationLedgerUpdate(
      {
        turnNumber: 1,
        attemptId: receipt.attemptId,
        headSha: receipt.headSha,
        conversationId: receipt.conversationId,
        beforeUrl: receipt.beforeUrl,
        afterUrl: receipt.afterUrl,
        fenceId: receipt.fenceId,
        sendClaimId: receipt.sendClaimId,
        recordedAt: receipt.confirmedAt,
      },
      true,
    );
  }

  async reconcileContinuationTurn(
    receipt: ContinuationTurnReceipt,
  ): Promise<{ok: boolean; commitSha: string | null}> {
    if (!this.activeClaim || receipt.sendClaimCommitSha !== this.activeClaim.commitSha) {
      return {ok: false, commitSha: null};
    }
    return this.commitConversationLedgerUpdate(
      {
        turnNumber: receipt.turnNumber,
        attemptId: receipt.attemptId,
        headSha: receipt.headSha,
        conversationId: receipt.conversationId,
        beforeUrl: receipt.beforeUrl,
        afterUrl: receipt.afterUrl,
        fenceId: receipt.fenceId,
        sendClaimId: receipt.sendClaimId,
        recordedAt: receipt.confirmedAt,
      },
      false,
    );
  }

  private async verifyConversationTip(
    conversationId: string,
    expectedTurnNumber: number,
    expectedAttemptId: string,
  ): Promise<boolean> {
    try {
      const convRef = this.conversationRef();
      const refRes = await this.request(
        'GET',
        `${this.repoRoot}/git/ref/${convRef.slice('refs/'.length)}`,
      );
      if (refRes.status !== 200) return false;
      const tipSha = asSha(asRecord(asRecord(refRes.data).object).sha);
      const commitRes = await this.request('GET', `${this.repoRoot}/git/commits/${tipSha}`);
      if (commitRes.status !== 200) return false;
      const payload = this.parseConversationPayload(String(asRecord(commitRes.data).message));
      if (payload.conversationId !== conversationId) return false;
      const turn = payload.turns.find(
        (t) => t.turnNumber === expectedTurnNumber && t.attemptId === expectedAttemptId,
      );
      return Boolean(turn && turn.headSha === this.config.headSha);
    } catch {
      return false;
    }
  }

  readBackConversation(conversationId: string): Promise<boolean> {
    return this.verifyConversationTip(conversationId, 1, this.activeAttemptId ?? '');
  }

  readBackContinuationTurn(
    conversationId: string,
    turnNumber: number,
    attemptId: string,
  ): Promise<boolean> {
    return this.verifyConversationTip(conversationId, turnNumber, attemptId);
  }

  async markDeliveryUncertain(): Promise<void> {
    this.uncertain = true;
    const attemptId = this.activeAttemptId;
    if (!attemptId) return;
    try {
      await this.request('POST', `${this.repoRoot}/git/refs`, {
        ref: this.uncertainRef(attemptId),
        sha: this.config.headSha,
      });
    } catch {
      // Local uncertain state stays latched even if remote quarantine ref write fails.
    }
  }
}
