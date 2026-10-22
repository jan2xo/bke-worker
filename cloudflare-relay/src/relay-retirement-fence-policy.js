// G0-03 SOURCE-ONLY / DORMANT. No DO imports, writes, routes, or Admin auth.
// A proposal is NEVER authority to persist a fence or remove a GitHub label.
// Deployment, authorization, transactional CAS and runtime enforcement are
// separate owner-gated engineering intents. Do not import in src/index.js.
import {CONTROL_REPOSITORIES, isValidWorkerId} from './protocol.js';

export const RETIREMENT_FENCE_KEY = 'retirement_fence_v1';
export const FENCED_OPERATIONS = Object.freeze([
  'connect', 'register', 'dispatch', 'recover', 'send', 'ack',
  'promote', 'socket-close', 'socket-error',
]);

const SHA = /^[0-9a-f]{40}$/u;
const DECISION_ID = /^[A-Za-z0-9._:-]{1,128}$/u;
const RECORD_KEYS = Object.freeze([
  'schema_version', 'status', 'worker_id', 'repo', 'pr_number',
  'expected_head_sha', 'retirement_id', 'epoch', 'created_at_ms',
]);
const TARGET_KEYS = Object.freeze(['worker_id', 'repo', 'pr_number', 'expected_head_sha']);
const PROPOSAL_KEYS = Object.freeze(['target', 'persisted_fence', 'retirement_id', 'created_at_ms']);

const NEGATIVE = Object.freeze({
  authority: 'NONE',
  can_commit: false,
  can_dispatch: false,
  can_reconnect: false,
  can_release_assignment: false,
  can_reuse_worker_id: false,
  delivery_ack_proven: false,
  delivery_fenced: false,
  atomic_commit_proven: false,
  credential_revocation_proven: false,
});
const deny = code => Object.freeze({state: 'BLOCKED', code, ...NEGATIVE});
const object = x => x !== null && typeof x === 'object' && !Array.isArray(x);
const exact = (x, keys) => object(x) && Object.keys(x).length === keys.length &&
  keys.every(key => Object.prototype.hasOwnProperty.call(x, key));
const same = (record, target) => record.worker_id === target.worker_id &&
  record.repo === target.repo && record.pr_number === target.pr_number &&
  record.expected_head_sha === target.expected_head_sha;

export function validateRetirementTarget(target) {
  return exact(target, TARGET_KEYS) && isValidWorkerId(target.worker_id) &&
    CONTROL_REPOSITORIES.has(target.repo) &&
    Number.isSafeInteger(target.pr_number) && target.pr_number > 0 &&
    typeof target.expected_head_sha === 'string' && SHA.test(target.expected_head_sha);
}

export function validateRetiredFenceRecord(value) {
  return exact(value, RECORD_KEYS) && value.schema_version === 1 &&
    value.status === 'retired' &&
    validateRetirementTarget({
      worker_id: value.worker_id, repo: value.repo,
      pr_number: value.pr_number, expected_head_sha: value.expected_head_sha,
    }) &&
    typeof value.retirement_id === 'string' && DECISION_ID.test(value.retirement_id) &&
    Number.isSafeInteger(value.epoch) && value.epoch >= 1 &&
    Number.isSafeInteger(value.created_at_ms) && value.created_at_ms > 0;
}

/**
 * Read-only quarantine decision for all currently known WorkerSession paths.
 * This never authorizes normal dispatch when the fence is absent: it is a
 * negative-only policy, not a drop-in live routing allowlist.
 */
export function inspectRetirementOperation(persistedFence, target, operation) {
  if (!validateRetirementTarget(target)) return deny('TARGET_INVALID');
  if (typeof operation !== 'string' || !FENCED_OPERATIONS.includes(operation)) {
    return deny('OPERATION_UNKNOWN');
  }
  if (persistedFence === undefined) return deny('FENCE_ABSENT_UNVERIFIED');
  if (!validateRetiredFenceRecord(persistedFence)) return deny('FENCE_MALFORMED');
  if (!same(persistedFence, target)) return deny('FENCE_TARGET_MISMATCH');
  return Object.freeze({state: 'RETIRED_BLOCKED', code: 'WORKER_RETIRED', operation, ...NEGATIVE});
}

/**
 * Pure, non-atomic proposal. A real owner-approved integration must construct
 * authoritative target context server-side, authenticate Admin, re-read the
 * SAME WorkerSession DO state in a transaction, CAS on the exact state/head,
 * persist a tombstone and fence EVERY route before releasing GitHub ownership.
 * No owner approval, transactional storage, or live epoch has been established.
 */
export function proposeRetirementTombstone(request) {
  if (!exact(request, PROPOSAL_KEYS) || !validateRetirementTarget(request.target) ||
      typeof request.retirement_id !== 'string' || !DECISION_ID.test(request.retirement_id) ||
      !Number.isSafeInteger(request.created_at_ms) || request.created_at_ms <= 0) {
    return deny('PROPOSAL_INVALID');
  }
  if (request.persisted_fence !== undefined) {
    if (!validateRetiredFenceRecord(request.persisted_fence)) return deny('EXISTING_FENCE_MALFORMED');
    if (!same(request.persisted_fence, request.target)) return deny('EXISTING_FENCE_TARGET_MISMATCH');
    return deny('ALREADY_FENCED_REQUIRES_AUTHORITATIVE_READBACK');
  }

  const candidate = Object.freeze({
    schema_version: 1,
    status: 'retired',
    ...request.target,
    retirement_id: request.retirement_id,
    // Candidate only. Real epoch must come from serialized DO transaction.
    epoch: 1,
    created_at_ms: request.created_at_ms,
  });
  return Object.freeze({
    state: 'PROPOSAL_ONLY',
    code: 'OWNER_AUTH_AND_ATOMIC_DO_CAS_REQUIRED',
    candidate,
    ...NEGATIVE,
  });
}
