/**
 * F1-02: one immutable GitHub ref per PR attempt. Pure protocol, no HTTP,
 * browser, credentials or sending. An authenticated, server-private adapter
 * must implement createRefIfAbsent with GitHub's atomic CREATE ref API;
 * GET-then-PATCH, upsert, force update and retry are NOT equivalent.
 *
 * Synthetic callback receipts never authorize a live ChatGPT send.
 */
const SHA = /^[0-9a-f]{40}$/;
const REPO = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const WORKER = /^[a-z0-9][a-z0-9-]{0,62}$/;
const ATTEMPT = /^[a-z0-9][a-z0-9-]{0,95}$/;

export interface SendOnceAttempt {
  repository: string;
  prNumber: number;
  headSha: string;
  attemptId: string;
  workerId: string;
}

/** These fields must be fetched from a trusted provider, NEVER a content script. */
export interface ClaimAuthority {
  repository: string;
  installationRepository: string;
  installationAuthenticated: boolean;
  prNumber: number;
  prOpen: boolean;
  headSha: string;
  attemptId: string;
  assignedWorkerId: string;
  authenticatedWorkerId: string;
  activeWorkerPrCount: number;
  prWorkerCount: number;
}

export interface SendOnceGitHub {
  readAuthority(): Promise<ClaimAuthority>;
  /** Null means missing; errors must not be converted to null. */
  readRef(ref: string): Promise<string | null>;
  /** One atomic POST /git/refs (201 created, 422 EXISTS). No overwrite. */
  createRefIfAbsent(ref: string, headSha: string): Promise<"CREATED" | "EXISTS">;
}

export type ClaimCode =
  | "INVALID_INPUT" | "WRONG_WORKER_OR_SCOPE" | "STALE_HEAD"
  | "ATTEMPT_NOT_ACTIVE" | "CLAIM_ALREADY_EXISTS" | "CLAIM_CONFLICT"
  | "READ_UNCERTAIN" | "WRITE_UNCERTAIN" | "READBACK_MISMATCH"
  | "CLAIM_RECORDED";

export interface ClaimResult {
  code: ClaimCode;
  /** A pure callback cannot authenticate an installation or authorize sending. */
  authority: "NONE";
  ref?: string;
}

function valid(input: SendOnceAttempt): boolean {
  return !!input && REPO.test(input.repository) &&
    Number.isSafeInteger(input.prNumber) && input.prNumber > 0 &&
    SHA.test(input.headSha) && WORKER.test(input.workerId) &&
    ATTEMPT.test(input.attemptId);
}

function authorityCode(a: ClaimAuthority, r: SendOnceAttempt): ClaimCode | null {
  if (!a || !a.installationAuthenticated ||
      a.repository !== r.repository || a.installationRepository !== r.repository ||
      a.prNumber !== r.prNumber || a.assignedWorkerId !== r.workerId ||
      a.authenticatedWorkerId !== r.workerId ||
      a.activeWorkerPrCount !== 1 || a.prWorkerCount !== 1 || !a.prOpen) {
    return "WRONG_WORKER_OR_SCOPE";
  }
  if (a.headSha !== r.headSha) return "STALE_HEAD";
  if (a.attemptId !== r.attemptId) return "ATTEMPT_NOT_ACTIVE";
  return null;
}

/**
 * No retries on ANY failure, including lost write response and same-owner replay.
 * A successful model return is only a candidate for independent provider proof.
 * The ref points at the pinned PR head commit, and is NEVER deleted or reused.
 */
export async function claimSendOnce(
  github: SendOnceGitHub, request: SendOnceAttempt,
): Promise<ClaimResult> {
  const result = (code: ClaimCode): ClaimResult => ({code, authority: "NONE"});
  if (!valid(request)) return result("INVALID_INPUT");
  const ref = `refs/bke/claims/${request.prNumber}/${request.attemptId}`;
  try {
    const prior = authorityCode(await github.readAuthority(), request);
    if (prior) return result(prior);
    const before = await github.readRef(ref);
    if (before !== null) return result("CLAIM_ALREADY_EXISTS");
  } catch {
    return result("READ_UNCERTAIN");
  }

  let created: "CREATED" | "EXISTS";
  try {
    created = await github.createRefIfAbsent(ref, request.headSha);
  } catch {
    // May have committed: no second create, regardless of any later readback.
    try { await github.readRef(ref); } catch { /* diagnostic only */ }
    return result("WRITE_UNCERTAIN");
  }
  if (created === "EXISTS") return result("CLAIM_CONFLICT");
  if (created !== "CREATED") return result("WRITE_UNCERTAIN");

  try {
    // Authoritative GitHub re-read, not a client-side echo of the write.
    if (await github.readRef(ref) !== request.headSha)
      return result("READBACK_MISMATCH");
    const after = authorityCode(await github.readAuthority(), request);
    if (after) return result(after);
  } catch {
    return result("READ_UNCERTAIN");
  }
  return {code: "CLAIM_RECORDED", authority: "NONE", ref};
}
