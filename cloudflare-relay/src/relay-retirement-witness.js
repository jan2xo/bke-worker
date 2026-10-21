// Source-only internal witness for a future privileged operator retirement gate.
// Does NOT authenticate Admin, cancel a wake, or grant dispatch/retirement authority.
// Never import into a public HTTP/WebSocket/browser/device route.
import {CONTROL_REPOSITORIES, isValidDeliveryId, isValidWorkerId, validateWake, validateRelayObservation} from './protocol.js';
const HEAD = /^[0-9a-f]{40}$/u;
const PHASES = new Set(['queued', 'sent', 'deferred', 'accepted', 'recovery_required']);
const MAX_RECENT = 64;

const blocked = code => Object.freeze({state: 'BLOCKED', code, authority: 'NONE', can_retire: false});
const record = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const exactKeys = (value, keys) => record(value) &&
  Object.keys(value).length === keys.length && keys.every(key =>
    Object.prototype.hasOwnProperty.call(value, key));

function describeWake(value, workerId) {
  // Reuse the exact persisted wire contract; a partial or corrupted wake is blocked.
  if (!validateWake(value, workerId)) return null;
  const {delivery_id, repo, pr_number, expected_head_sha} = value;
  // Copy only non-secret GitHub routing metadata into the result.
  return Object.freeze({delivery_id, repo, pr_number, expected_head_sha});
}

/**
 * Read existing DO state without write, dispatch, registration or socket ownership.
 * Caller must use a server-owned storage handle selected by verified worker ID
 * and a separately authenticated owner context. This is NOT an atomic snapshot.
 */
export async function readRelayRetirementWitness(storage, expected) {
  if (!exactKeys(expected, ['worker_id', 'repo', 'pr_number', 'expected_head_sha']) ||
      !isValidWorkerId(expected.worker_id) || !CONTROL_REPOSITORIES.has(expected.repo) ||
      !Number.isSafeInteger(expected.pr_number) || expected.pr_number < 1 ||
      typeof expected.expected_head_sha !== 'string' || !HEAD.test(expected.expected_head_sha)) {
    return blocked('EXPECTED_CONTEXT_INVALID');
  }
  if (!storage || typeof storage.get !== 'function') return blocked('STORAGE_NOT_TRUSTED');

  let identity, active, queued, registered, recent, observation;
  try {
    identity = await storage.get('worker_id');
    active = await storage.get('active_wake');
    queued = await storage.get('queued_wake');
    registered = await storage.get('active_connection_id');
    recent = await storage.get('recent_deliveries');
    observation = await storage.get('relay_observation_v1');
    // Normal v1 dispatch can supersede earlier deliveries while preserving
    // their context in a separate internal ledger. Do not call the remaining
    // active+queued pair a COMPLETE retirement witness if such history exists.
    const displaced = await storage.get('supersession_evidence_v1');
    if (displaced !== undefined) return blocked('SUPERSESSION_EVIDENCE_REQUIRES_OWNER_RECONCILIATION');
  } catch {
    return blocked('STORAGE_READ_FAILED');
  }
  if (identity !== expected.worker_id) return blocked('IDENTITY_MISMATCH_OR_MISSING');
  if (observation !== undefined &&
      !validateRelayObservation(observation, expected.worker_id)) {
    return blocked('RELAY_OBSERVATION_MALFORMED');
  }
  if (registered !== undefined && (typeof registered !== 'string' || !registered)) {
    return blocked('CONNECTION_METADATA_MALFORMED');
  }
  if (recent !== undefined && (!Array.isArray(recent) || recent.length > MAX_RECENT ||
      recent.some(id => !isValidDeliveryId(id)))) {
    return blocked('RECENT_DELIVERIES_MALFORMED');
  }

  let activeSummary = null, queuedSummary = null;
  if (active !== undefined) {
    if (!exactKeys(active, ['wake', 'phase']) || !PHASES.has(active.phase)) {
      return blocked('ACTIVE_PHASE_MALFORMED');
    }
    const wake = describeWake(active.wake, expected.worker_id);
    if (!wake) return blocked('ACTIVE_WAKE_MALFORMED');
    activeSummary = Object.freeze({...wake, phase: active.phase});
  }
  if (queued !== undefined) {
    queuedSummary = describeWake(queued, expected.worker_id);
    if (!queuedSummary) return blocked('QUEUED_WAKE_MALFORMED');
  }
  for (const wake of [activeSummary, queuedSummary]) {
    if (wake && (wake.repo !== expected.repo || wake.pr_number !== expected.pr_number ||
                 wake.expected_head_sha !== expected.expected_head_sha)) {
      return blocked('WAKE_CONTEXT_MISMATCH');
    }
  }

  return Object.freeze({
    state: 'OBSERVED_ONLY',
    authority: 'NONE',
    can_retire: false,
    worker_id: expected.worker_id,
    repo: expected.repo,
    pr_number: expected.pr_number,
    expected_head_sha: expected.expected_head_sha,
    active: activeSummary,
    queued: queuedSummary,
    // Stored metadata only. An authoritative live WebSocket requires a separate
    // ctx.getWebSockets() membership/identity check, which this helper cannot perform.
    active_connection_id_present: registered !== undefined,
    recent_delivery_count: recent?.length ?? 0,
    // A DO-local timestamp proves neither remote execution nor ChatGPT
    // cancellation. No connection ID, session ID or profile data is returned.
    registration_admitted_at_ms: observation?.last_registration?.observed_at_ms ?? null,
    last_ack_observed: observation?.last_ack ? Object.freeze({
      ...observation.last_ack,
      matches_expected_target:
        observation.last_ack.repo === expected.repo &&
        observation.last_ack.pr_number === expected.pr_number &&
        observation.last_ack.expected_head_sha === expected.expected_head_sha,
    }) : null,
    snapshot_atomic: false,
    delivery_ack_proven: false,
    delivery_fenced: false,
    owner_gate_required: true,
  });
}
