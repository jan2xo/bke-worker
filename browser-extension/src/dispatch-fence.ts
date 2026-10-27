/**
 * Source-only input submission fence. No DOM, browser, network, secrets or
 * ChatGPT reply inspection. The caller supplies an authenticated CREATED
 * claim and a durable atomic consumed-attempt registry; neither is proven here.
 *
 * A successful return records ONE port invocation, NOT ChatGPT delivery.
 */
const SHA = /^[0-9a-f]{40}$/;
const ID = /^[a-z0-9][a-z0-9-]{0,95}$/;

export interface DispatchAttempt {
  prNumber: number;
  attemptId: string;
  headSha: string;
}
export interface CreatedClaim {
  code: string;
  prNumber?: number;
  attemptId?: string;
  headSha?: string;
  ref?: string;
}
export interface ConsumedAttemptRegistry {
  /** Atomic, durable and fail-closed: throws/false on uncertainty/duplicate. */
  consumeOnce(attemptId: string): boolean;
}
export interface SingleClickPort {
  /** Exactly one submit/click action, never retry internally. */
  clickOnce(): Promise<void>;
}
export type DispatchFenceResult = {
  code: 'ATTEMPTED' | 'ABORT';
  authority: 'NONE';
  reason?: 'INVALID' | 'BUSY' | 'CLAIM_NOT_CREATED' |
    'ALREADY_CONSUMED' | 'CONSUMPTION_UNCERTAIN' | 'CLICK_UNCERTAIN';
};
const abort = (reason: NonNullable<DispatchFenceResult['reason']>): DispatchFenceResult =>
  ({code:'ABORT',authority:'NONE',reason});

function matches(a: DispatchAttempt, claim: CreatedClaim): boolean {
  return !!a && Number.isSafeInteger(a.prNumber) && a.prNumber > 0 &&
    ID.test(a.attemptId) && SHA.test(a.headSha) &&
    !!claim && claim.code === 'CREATED' &&
    claim.prNumber === a.prNumber &&
    claim.attemptId === a.attemptId &&
    claim.headSha === a.headSha &&
    claim.ref === 'refs/bke/claims/' + a.prNumber + '/' + a.attemptId;
}

/**
 * This is one serial dispatcher instance. Registry must protect this across
 * process restarts AND across all instances sharing an attempt namespace.
 * No retry is permitted after a claim has been observed/possibly consumed.
 */
export class DispatchFence {
  private inFlight = false;
  private readonly seen = new Set<string>();
  constructor(private readonly registry: ConsumedAttemptRegistry) {}

  async attempt(
    request: DispatchAttempt,
    claim: CreatedClaim,
    port: SingleClickPort,
  ): Promise<DispatchFenceResult> {
    if (!request || !ID.test(request.attemptId) || !SHA.test(request.headSha) ||
        !Number.isSafeInteger(request.prNumber) || request.prNumber < 1 ||
        !port || typeof port.clickOnce !== 'function') return abort('INVALID');

    // Quarantine each request ID before any asynchronous boundary.
    if (this.seen.has(request.attemptId)) return abort('ALREADY_CONSUMED');
    this.seen.add(request.attemptId);
    if (this.inFlight) {
      try { this.registry.consumeOnce(request.attemptId); } catch { /* stop */ }
      return abort('BUSY');
    }
    this.inFlight = true;
    try {
      // Even a bad claim is a terminal attempt, never a resubmission signal.
      let consumed: boolean;
      try { consumed = this.registry.consumeOnce(request.attemptId); }
      catch { return abort('CONSUMPTION_UNCERTAIN'); }
      if (consumed !== true) return abort('ALREADY_CONSUMED');
      if (!matches(request, claim)) return abort('CLAIM_NOT_CREATED');
      try { await port.clickOnce(); }
      catch { return abort('CLICK_UNCERTAIN'); }
      return {code:'ATTEMPTED',authority:'NONE'};
    } finally {
      this.inFlight = false;
    }
  }
}
