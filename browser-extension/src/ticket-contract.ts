/**
 * Version 1 of the source-only BKE dispatcher ticket contract.
 * Caller must obtain check runs from the intended repository's authenticated
 * GitHub check-runs endpoint. This PURE validator does not prove that provenance.
 * It confers no live authority; no credentials, DOM or HTTP are used here.
 *
 * v1 external_id wire format:
 * bke-ticket:v1:<worker-id>:<attempt-id>:<expires-unix-seconds>
 * A pinned dispatcher App is the issuer of that metadata. The format is not
 * a signature and cannot defend against compromise of the pinned App.
 */
export const TICKET_CONTRACT_VERSION = 1 as const;
const SHA = /^[0-9a-f]{40}$/;
const ID = /^[a-z0-9][a-z0-9-]{0,95}$/;
const WIRE = /^bke-ticket:v1:([a-z0-9][a-z0-9-]{0,62}):([a-z0-9][a-z0-9-]{0,95}):([0-9]{1,12})$/;

export interface PinnedDispatcherApp { id: number; slug: string }
export interface CheckRunCandidate {
  id?: unknown;
  name?: unknown;
  app?: { id?: unknown; slug?: unknown } | null;
  head_sha?: unknown;
  external_id?: unknown;
  status?: unknown;
  conclusion?: unknown;
}
export interface TicketValidationContext {
  pinnedApp: PinnedDispatcherApp;
  currentHead: string;
  workerId: string;
  nowMs: number;
  /** Must originate in independent GitHub claim/readback authority, not a UI. */
  consumedAttemptIds: ReadonlySet<string>;
}
export interface ValidTicket {
  contractVersion: 1;
  checkRunId: number;
  ticketId: string;
  attemptId: string;
  workerId: string;
  expiresAtMs: number;
  headSha: string;
}
export type TicketDecision =
  | { code: 'VALID'; authority: 'NONE'; ticket: ValidTicket }
  | { code: 'INVALID' | 'AMBIGUOUS'; authority: 'NONE' };

function validContext(c: TicketValidationContext): boolean {
  return !!c && !!c.pinnedApp &&
    Number.isSafeInteger(c.pinnedApp.id) && c.pinnedApp.id > 0 &&
    typeof c.pinnedApp.slug === 'string' &&
    /^[a-z][a-z0-9-]*$/.test(c.pinnedApp.slug) &&
    c.pinnedApp.slug !== 'github-actions' &&
    SHA.test(c.currentHead) && ID.test(c.workerId) &&
    Number.isSafeInteger(c.nowMs) && c.nowMs >= 0 &&
    c.consumedAttemptIds instanceof Set;
}

function parse(run: CheckRunCandidate, c: TicketValidationContext): ValidTicket | null {
  if (!run || typeof run !== 'object' ||
      !Number.isSafeInteger(run.id) || (run.id as number) < 1 ||
      run.name !== 'bke-ticket' ||
      !run.app || run.app.id !== c.pinnedApp.id ||
      run.app.slug !== c.pinnedApp.slug ||
      run.head_sha !== c.currentHead ||
      run.status !== 'completed' || run.conclusion !== 'success' ||
      typeof run.external_id !== 'string') return null;
  const m = WIRE.exec(run.external_id);
  if (!m || m[1] !== c.workerId) return null;
  const seconds = Number(m[3]);
  if (!Number.isSafeInteger(seconds) || seconds <= 0 ||
      seconds > Math.floor(Number.MAX_SAFE_INTEGER / 1000)) return null;
  const expiresAtMs = seconds * 1000;
  if (expiresAtMs <= c.nowMs || c.consumedAttemptIds.has(m[2]!)) return null;
  return {
    contractVersion: 1, checkRunId: run.id as number,
    ticketId: 'check-run:' + String(run.id),
    attemptId: m[2]!, workerId: m[1]!,
    expiresAtMs, headSha: c.currentHead,
  };
}

/**
 * All valid, unconsumed check runs must be supplied as one complete snapshot.
 * A page-limited/partial collection is NOT sufficient for safe selection.
 * Callers must fail closed if pagination, fetch, or claim-state proof is uncertain.
 */
export function validateTicketInventory(
  runs: readonly CheckRunCandidate[],
  context: TicketValidationContext,
): TicketDecision {
  if (!Array.isArray(runs) || !validContext(context)) {
    return {code: 'INVALID', authority: 'NONE'};
  }
  const valid: ValidTicket[] = [];
  for (const run of runs) {
    const ticket = parse(run, context);
    if (ticket) valid.push(ticket);
    if (valid.length > 1) return {code: 'AMBIGUOUS', authority: 'NONE'};
  }
  return valid.length === 1
    ? {code: 'VALID', authority: 'NONE', ticket: valid[0]!}
    : {code: 'INVALID', authority: 'NONE'};
}
