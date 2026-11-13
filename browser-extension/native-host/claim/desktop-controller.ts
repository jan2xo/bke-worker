/**
 * F1-03 Local Desktop Controller daemon/orchestrator.
 *
 * Coordinates:
 * - Authenticated HMAC-SHA256 webhook verification + delivery deduplication
 * - Atomic crash-safe local execution journal (quarantining mid-send restarts)
 * - Authenticated GitHub F1-02 ledger (`GitHubF1Ledger`)
 * - Authenticated F1-03 / F1-04 / F1-05 Chrome extension browser adapter
 * - Automatic turn routing: Turn 1 (new conversation) vs Turn 2+ (same-conversation continuation)
 * - Preserves human-only live-send consent gate (`humanLiveSendAuthorized` must be explicitly true)
 */
import { createHmac, timingSafeEqual } from 'node:crypto';
import { constants } from 'node:fs';
import { open, readFile, rename, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { FirstMessageLiveProofs } from '../../src/first-message-actuator.js';
import {
  executeFirstMessageWithAdapters,
  type FirstMessageBrowserPort,
  type FirstMessageLedgerPort,
  type LedgerCasWriteResult,
} from '../../src/first-message-runtime.js';
import {
  executeContinuationWithAdapters,
  type ContinuationBrowserPort,
  type ContinuationLedgerPort,
} from '../../src/continuation-runtime.js';
import type { GitHubAuthoritySnapshot, GitHubF1Ledger } from './github-f1-ledger.js';

export type JournalPhase =
  | 'IDLE'
  | 'FENCED'
  | 'DISPATCHING'
  | 'CONFIRMED_CONVERSATION'
  | 'CONTINUING'
  | 'DELIVERY_UNCERTAIN'
  | 'HALTED';

export interface ExecutionJournalState {
  version: 1;
  repository: string;
  prNumber: number;
  workerId: string;
  phase: JournalPhase;
  activeAttemptId: string | null;
  conversationId: string | null;
  confirmedTurnCount: number;
  processedAttempts: string[];
  processedDeliveries: string[];
  uncertainReason: string | null;
  updatedAt: string;
}

const SHA256_SIG_RE = /^sha256=([a-f0-9]{64})$/;

export function verifyGitHubWebhookSignature(opts: {
  secret: string;
  signatureHeader: string | null | undefined;
  rawBody: string | Buffer;
}): boolean {
  if (typeof opts.secret !== 'string' || opts.secret.length === 0) return false;
  if (typeof opts.signatureHeader !== 'string') return false;
  const match = SHA256_SIG_RE.exec(opts.signatureHeader.trim());
  if (!match || !match[1]) return false;
  const expected = createHmac('sha256', opts.secret).update(opts.rawBody).digest();
  const actual = Buffer.from(match[1], 'hex');
  if (expected.length !== actual.length) return false;
  return timingSafeEqual(expected, actual);
}

export class FileExecutionJournal {
  private state: ExecutionJournalState | null = null;

  constructor(
    private readonly filePath: string,
    private readonly identity: { repository: string; prNumber: number; workerId: string },
    private readonly nowIso: () => string = () => new Date().toISOString(),
  ) {}

  private initial(): ExecutionJournalState {
    return {
      version: 1,
      repository: this.identity.repository,
      prNumber: this.identity.prNumber,
      workerId: this.identity.workerId,
      phase: 'IDLE',
      activeAttemptId: null,
      conversationId: null,
      confirmedTurnCount: 0,
      processedAttempts: [],
      processedDeliveries: [],
      uncertainReason: null,
      updatedAt: this.nowIso(),
    };
  }

  private async atomicWrite(next: ExecutionJournalState): Promise<void> {
    await mkdir(dirname(this.filePath), { recursive: true, mode: 0o700 });
    const tmpPath = `${this.filePath}.${process.pid}.${Date.now()}.tmp`;
    const handle = await open(
      tmpPath,
      constants.O_WRONLY | constants.O_CREAT | constants.O_TRUNC | constants.O_NOFOLLOW,
      0o600,
    );
    try {
      await handle.writeFile(JSON.stringify(next, null, 2) + '\n', { encoding: 'utf8' });
      await handle.sync();
    } finally {
      await handle.close();
    }
    await rename(tmpPath, this.filePath);
    this.state = next;
  }

  async openAndRecover(): Promise<ExecutionJournalState> {
    let raw: string | null = null;
    try {
      raw = await readFile(this.filePath, 'utf8');
    } catch (err) {
      if ((err as NodeJS.ErrnoException)?.code === 'ENOENT') {
        const fresh = this.initial();
        await this.atomicWrite(fresh);
        return structuredClone(fresh);
      }
      throw err;
    }

    const parsed = JSON.parse(raw) as ExecutionJournalState;
    if (
      parsed.version !== 1 ||
      parsed.repository !== this.identity.repository ||
      parsed.prNumber !== this.identity.prNumber ||
      parsed.workerId !== this.identity.workerId
    ) {
      throw Error('JOURNAL_IDENTITY_MISMATCH');
    }

    // Fail-closed crash recovery: if controller died while DISPATCHING or CONTINUING,
    // delivery status in Chrome/ChatGPT is unknown and MUST stay quarantined.
    if (parsed.phase === 'DISPATCHING' || parsed.phase === 'CONTINUING') {
      const quarantined: ExecutionJournalState = {
        ...parsed,
        phase: 'DELIVERY_UNCERTAIN',
        uncertainReason: `CRASH_DURING_${parsed.phase}`,
        updatedAt: this.nowIso(),
      };
      await this.atomicWrite(quarantined);
      return structuredClone(quarantined);
    }

    this.state = parsed;
    return structuredClone(parsed);
  }

  current(): ExecutionJournalState {
    if (!this.state) throw Error('JOURNAL_NOT_OPEN');
    return structuredClone(this.state);
  }

  async transition(patch: Partial<ExecutionJournalState>): Promise<ExecutionJournalState> {
    if (!this.state) throw Error('JOURNAL_NOT_OPEN');
    const next: ExecutionJournalState = {
      ...this.state,
      ...patch,
      updatedAt: this.nowIso(),
    };
    await this.atomicWrite(next);
    return structuredClone(next);
  }

  async recordDelivery(deliveryId: string): Promise<boolean> {
    if (!this.state) throw Error('JOURNAL_NOT_OPEN');
    if (!deliveryId || this.state.processedDeliveries.includes(deliveryId)) {
      return false;
    }
    const deliveries = [...this.state.processedDeliveries, deliveryId].slice(-512);
    await this.transition({ processedDeliveries: deliveries });
    return true;
  }
}

export interface DesktopControllerConfig {
  journal: FileExecutionJournal;
  createLedger: (headSha: string) => GitHubF1Ledger;
  createBrowserPorts: (headSha: string) => {
    firstMessage: FirstMessageBrowserPort;
    continuation: ContinuationBrowserPort;
  };
  liveProofs: FirstMessageLiveProofs;
  webhookSecret?: string;
  nowIso?: () => string;
}

export interface ControllerWakeOutcome {
  status: 'CONFIRMED_TURN_1' | 'CONFIRMED_CONTINUATION' | 'BLOCKED';
  code: string;
  turnNumber: number | null;
  conversationId: string | null;
  journalPhase: JournalPhase;
  submitInvocations: number;
}

export class DesktopController {
  private busy = false;

  constructor(private readonly config: DesktopControllerConfig) {}

  async initialize(): Promise<ExecutionJournalState> {
    return this.config.journal.openAndRecover();
  }

  async halt(reason: string): Promise<ExecutionJournalState> {
    return this.config.journal.transition({
      phase: 'HALTED',
      uncertainReason: reason || 'OWNER_HALTED',
    });
  }

  async handleWebhookWake(params: {
    signatureHeader: string | null | undefined;
    deliveryId: string | null | undefined;
    rawBody: string | Buffer;
    headSha: string;
    prNumber: number;
    humanLiveSendAuthorized: boolean;
  }): Promise<ControllerWakeOutcome> {
    if (this.config.webhookSecret) {
      const valid = verifyGitHubWebhookSignature({
        secret: this.config.webhookSecret,
        signatureHeader: params.signatureHeader,
        rawBody: params.rawBody,
      });
      if (!valid) {
        const state = this.config.journal.current();
        return {
          status: 'BLOCKED',
          code: 'WEBHOOK_SIGNATURE_INVALID',
          turnNumber: state.confirmedTurnCount || null,
          conversationId: state.conversationId,
          journalPhase: state.phase,
          submitInvocations: 0,
        };
      }
    }

    const deliveryId = typeof params.deliveryId === 'string' ? params.deliveryId.trim() : '';
    if (!deliveryId) {
      const state = this.config.journal.current();
      return {
        status: 'BLOCKED',
        code: 'WEBHOOK_DELIVERY_ID_MISSING',
        turnNumber: state.confirmedTurnCount || null,
        conversationId: state.conversationId,
        journalPhase: state.phase,
        submitInvocations: 0,
      };
    }

    const admitted = await this.config.journal.recordDelivery(deliveryId);
    if (!admitted) {
      const state = this.config.journal.current();
      return {
        status: 'BLOCKED',
        code: 'WEBHOOK_DELIVERY_DUPLICATE',
        turnNumber: state.confirmedTurnCount || null,
        conversationId: state.conversationId,
        journalPhase: state.phase,
        submitInvocations: 0,
      };
    }

    return this.processAuthorizedWake({
      headSha: params.headSha,
      prNumber: params.prNumber,
      humanLiveSendAuthorized: params.humanLiveSendAuthorized,
    });
  }

  async processAuthorizedWake(params: {
    headSha: string;
    prNumber: number;
    humanLiveSendAuthorized: boolean;
  }): Promise<ControllerWakeOutcome> {
    const journal = this.config.journal;
    const state = journal.current();

    if (this.busy) {
      return {
        status: 'BLOCKED',
        code: 'CONTROLLER_BUSY',
        turnNumber: state.confirmedTurnCount || null,
        conversationId: state.conversationId,
        journalPhase: state.phase,
        submitInvocations: 0,
      };
    }
    if (state.phase === 'DELIVERY_UNCERTAIN') {
      return {
        status: 'BLOCKED',
        code: state.uncertainReason || 'DELIVERY_UNCERTAIN_QUARANTINED',
        turnNumber: state.confirmedTurnCount || null,
        conversationId: state.conversationId,
        journalPhase: state.phase,
        submitInvocations: 0,
      };
    }
    if (state.phase === 'HALTED') {
      return {
        status: 'BLOCKED',
        code: 'CONTROLLER_HALTED',
        turnNumber: state.confirmedTurnCount || null,
        conversationId: state.conversationId,
        journalPhase: state.phase,
        submitInvocations: 0,
      };
    }
    if (params.prNumber !== state.prNumber) {
      return {
        status: 'BLOCKED',
        code: 'CONTROLLER_PR_MISMATCH',
        turnNumber: state.confirmedTurnCount || null,
        conversationId: state.conversationId,
        journalPhase: state.phase,
        submitInvocations: 0,
      };
    }
    if (params.humanLiveSendAuthorized !== true) {
      return {
        status: 'BLOCKED',
        code: 'LIVE_SEND_DISABLED',
        turnNumber: state.confirmedTurnCount || null,
        conversationId: state.conversationId,
        journalPhase: state.phase,
        submitInvocations: 0,
      };
    }

    this.busy = true;
    try {
      const ledger = this.config.createLedger(params.headSha);
      let auth: GitHubAuthoritySnapshot;
      try {
        auth = await ledger.refreshAuthority();
      } catch (err) {
        const msg = err instanceof Error ? err.message : 'GITHUB_AUTHORITY_REJECTED';
        if (msg.includes('UNCERTAIN')) {
          await journal.transition({ phase: 'DELIVERY_UNCERTAIN', uncertainReason: msg });
        }
        return {
          status: 'BLOCKED',
          code: msg,
          turnNumber: state.confirmedTurnCount || null,
          conversationId: state.conversationId,
          journalPhase: journal.current().phase,
          submitInvocations: 0,
        };
      }

      const attemptId = auth.ticket.attemptId;
      if (state.processedAttempts.includes(attemptId)) {
        return {
          status: 'BLOCKED',
          code: 'ATTEMPT_ALREADY_PROCESSED_BY_JOURNAL',
          turnNumber: state.confirmedTurnCount || null,
          conversationId: state.conversationId,
          journalPhase: state.phase,
          submitInvocations: 0,
        };
      }

      const ports = this.config.createBrowserPorts(params.headSha);
      const isTurn1 = auth.conversationLedger === null && state.conversationId === null;
      const nowFn = this.config.nowIso ?? (() => new Date().toISOString());

      if (isTurn1) {
        // Wrap ledger methods to persist crash-safe journal phases synchronously around CAS & submit
        const wrappedLedger: FirstMessageLedgerPort = {
          loadSnapshot: (e, b, t) => ledger.loadSnapshot(e, b, t),
          commitPreSendFence: async (fence) => {
            const res = await ledger.commitPreSendFence(fence);
            if (res.status === 'COMMITTED') {
              await journal.transition({ phase: 'FENCED', activeAttemptId: attemptId });
            }
            return res;
          },
          readBackPreSendFence: (sha) => ledger.readBackPreSendFence(sha),
          consumeFirstSendClaim: async (claim): Promise<LedgerCasWriteResult> => {
            const res = await ledger.consumeFirstSendClaim(claim);
            if (res.status === 'COMMITTED') {
              await journal.transition({ phase: 'DISPATCHING', activeAttemptId: attemptId });
            } else if (res.status === 'UNCERTAIN') {
              await journal.transition({
                phase: 'DELIVERY_UNCERTAIN',
                activeAttemptId: attemptId,
                uncertainReason: 'SEND_CLAIM_UNCERTAIN',
              });
            }
            return res;
          },
          readBackFirstSendClaim: (sha) => ledger.readBackFirstSendClaim(sha),
          reconcileConversation: (rec) => ledger.reconcileConversation(rec),
          readBackConversation: (id) => ledger.readBackConversation(id),
          markDeliveryUncertain: async () => {
            await ledger.markDeliveryUncertain();
            await journal.transition({
              phase: 'DELIVERY_UNCERTAIN',
              activeAttemptId: attemptId,
              uncertainReason: 'FIRST_MESSAGE_DELIVERY_UNCERTAIN',
            });
          },
        };

        const outcome = await executeFirstMessageWithAdapters(wrappedLedger, ports.firstMessage, {
          humanLiveSendAuthorized: params.humanLiveSendAuthorized,
          liveProofs: this.config.liveProofs,
          nowIso: nowFn,
        });

        if (outcome.status === 'FIRST_MESSAGE_CONFIRMED' && outcome.conversationId) {
          const updated = await journal.transition({
            phase: 'CONFIRMED_CONVERSATION',
            activeAttemptId: null,
            conversationId: outcome.conversationId,
            confirmedTurnCount: 1,
            processedAttempts: [...state.processedAttempts, attemptId],
          });
          return {
            status: 'CONFIRMED_TURN_1',
            code: outcome.code,
            turnNumber: 1,
            conversationId: updated.conversationId,
            journalPhase: updated.phase,
            submitInvocations: outcome.submitInvocations,
          };
        }

        return {
          status: 'BLOCKED',
          code: outcome.code,
          turnNumber: state.confirmedTurnCount || null,
          conversationId: state.conversationId,
          journalPhase: journal.current().phase,
          submitInvocations: outcome.submitInvocations,
        };
      }

      // Turn 2+: Same-conversation continuation
      if (!auth.conversationLedger || !state.conversationId) {
        await journal.transition({
          phase: 'DELIVERY_UNCERTAIN',
          activeAttemptId: attemptId,
          uncertainReason: 'CONVERSATION_LEDGER_STATE_DESYNC',
        });
        return {
          status: 'BLOCKED',
          code: 'CONVERSATION_LEDGER_STATE_DESYNC',
          turnNumber: state.confirmedTurnCount || null,
          conversationId: state.conversationId,
          journalPhase: 'DELIVERY_UNCERTAIN',
          submitInvocations: 0,
        };
      }

      const wrappedContLedger: ContinuationLedgerPort = {
        loadSnapshot: (e, b, t) => ledger.loadSnapshot(e, b, t),
        commitPreSendFence: async (fence) => {
          const res = await ledger.commitPreSendFence(fence);
          if (res.status === 'COMMITTED') {
            await journal.transition({ phase: 'FENCED', activeAttemptId: attemptId });
          }
          return res;
        },
        readBackPreSendFence: (sha) => ledger.readBackPreSendFence(sha),
        consumeContinuationSendClaim: async (claim): Promise<LedgerCasWriteResult> => {
          const res = await ledger.consumeContinuationSendClaim(claim);
          if (res.status === 'COMMITTED') {
            await journal.transition({ phase: 'CONTINUING', activeAttemptId: attemptId });
          } else if (res.status === 'UNCERTAIN') {
            await journal.transition({
              phase: 'DELIVERY_UNCERTAIN',
              activeAttemptId: attemptId,
              uncertainReason: 'CONTINUATION_CLAIM_UNCERTAIN',
            });
          }
          return res;
        },
        readBackContinuationSendClaim: (sha) => ledger.readBackContinuationSendClaim(sha),
        reconcileContinuationTurn: (rec) => ledger.reconcileContinuationTurn(rec),
        readBackContinuationTurn: (id, turn, aid) => ledger.readBackContinuationTurn(id, turn, aid),
        markDeliveryUncertain: async () => {
          await ledger.markDeliveryUncertain();
          await journal.transition({
            phase: 'DELIVERY_UNCERTAIN',
            activeAttemptId: attemptId,
            uncertainReason: 'CONTINUATION_DELIVERY_UNCERTAIN',
          });
        },
      };

      const outcome = await executeContinuationWithAdapters(wrappedContLedger, ports.continuation, {
        humanLiveSendAuthorized: params.humanLiveSendAuthorized,
        liveProofs: this.config.liveProofs,
        executionAuthoritative: true,
        syntheticEvidence: false,
        nowIso: nowFn,
      });

      if (outcome.status === 'CONTINUATION_CONFIRMED' && outcome.conversationId && outcome.turnNumber) {
        const updated = await journal.transition({
          phase: 'CONFIRMED_CONVERSATION',
          activeAttemptId: null,
          conversationId: outcome.conversationId,
          confirmedTurnCount: outcome.turnNumber,
          processedAttempts: [...state.processedAttempts, attemptId],
        });
        return {
          status: 'CONFIRMED_CONTINUATION',
          code: outcome.code,
          turnNumber: updated.confirmedTurnCount,
          conversationId: updated.conversationId,
          journalPhase: updated.phase,
          submitInvocations: outcome.submitInvocations,
        };
      }

      return {
        status: 'BLOCKED',
        code: outcome.code,
        turnNumber: state.confirmedTurnCount || null,
        conversationId: state.conversationId,
        journalPhase: journal.current().phase,
        submitInvocations: outcome.submitInvocations,
      };
    } finally {
      this.busy = false;
    }
  }
}
