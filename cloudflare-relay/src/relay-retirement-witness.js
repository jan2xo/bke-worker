// Source-only internal witness for a future privileged operator retirement gate.
// Does NOT authenticate Admin, cancel a wake, or grant dispatch/retirement authority.
// Never import into a public HTTP/WebSocket/browser/device route.
const ID = /^[a-z0-9][a-z0-9-]{0,62}$/u;
const HEAD = /^[0-9a-f]{40}$/u;
const DELIVERY = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;
const PHASES = new Set(['queued', 'sent', 'deferred', 'accepted', 'recovery_required']);
const MAX_RECENT = 64;

const blocked = code => Object.freeze({state: 'BLOCKED', code, authority: 'NONE', can_retire: false});
const record = value => value !== null && typeof value === 'object' && !Array.isArray(value);

function describeWake(value, workerId) {
  if (!record(value) || Object.keys(value).length > 20) return null;
  const {worker_id, delivery_id, pr_number, expected_head_sha} = value;
  if (worker_id !== workerId || typeof delivery_id !== 'string' ||
      !DELIVERY.test(delivery_id) || !Number.isSafeInteger(pr_number) || pr_number < 1 ||
      typeof expected_head_sha !== 'string' || !HEAD.test(expected_head_sha)) return null;
  // Copy only non-secret GitHub routing metadata into the result.
  return Object.freeze({delivery_id, pr_number, expected_head_sha});
}

/**
 * Read existing DO state without write, dispatch, registration or socket ownership.
 * Caller must use a server-owned storage handle selected by verified worker ID
 * and a separately authenticated owner context. This is NOT an atomic snapshot.
 */
export async function readRelayRetirementWitness(storage, expected) {
  if (!record(expected) || !ID.test(expected.worker_id ?? '') ||
      !Number.isSafeInteger(expected.pr_number) || expected.pr_number < 1 ||
      typeof expected.expected_head_sha !== 'string' || !HEAD.test(expected.expected_head_sha)) {
    return blocked('EXPECTED_CONTEXT_INVALID');
  }
  if (!storage || typeof storage.get !== 'function') return blocked('STORAGE_NOT_TRUSTED');

  let identity, active, queued, registered, recent;
  try {
    identity = await storage.get('worker_id');
    active = await storage.get('active_wake');
    queued = await storage.get('queued_wake');
    registered = await storage.get('active_connection_id');
    recent = await storage.get('recent_deliveries');
  } catch {
    return blocked('STORAGE_READ_FAILED');
  }
  if (identity !== expected.worker_id) return blocked('IDENTITY_MISMATCH_OR_MISSING');
  if (registered !== undefined && (typeof registered !== 'string' || !registered)) {
    return blocked('CONNECTION_METADATA_MALFORMED');
  }
  if (recent !== undefined && (!Array.isArray(recent) || recent.length > MAX_RECENT ||
      recent.some(id => typeof id !== 'string' || !DELIVERY.test(id)))) {
    return blocked('RECENT_DELIVERIES_MALFORMED');
  }

  let activeSummary = null, queuedSummary = null;
  if (active !== undefined) {
    if (!record(active) || !PHASES.has(active.phase)) return blocked('ACTIVE_PHASE_MALFORMED');
    const wake = describeWake(active.wake, expected.worker_id);
    if (!wake) return blocked('ACTIVE_WAKE_MALFORMED');
    activeSummary = Object.freeze({...wake, phase: active.phase});
  }
  if (queued !== undefined) {
    queuedSummary = describeWake(queued, expected.worker_id);
    if (!queuedSummary) return blocked('QUEUED_WAKE_MALFORMED');
  }
  for (const wake of [activeSummary, queuedSummary]) {
    if (wake && (wake.pr_number !== expected.pr_number ||
                 wake.expected_head_sha !== expected.expected_head_sha)) {
      return blocked('WAKE_CONTEXT_MISMATCH');
    }
  }

  return Object.freeze({
    state: 'OBSERVED_ONLY',
    authority: 'NONE',
    can_retire: false,
    worker_id: expected.worker_id,
    pr_number: expected.pr_number,
    expected_head_sha: expected.expected_head_sha,
    active: activeSummary,
    queued: queuedSummary,
    registered_connection_present: registered !== undefined,
    recent_delivery_count: recent?.length ?? 0,
    snapshot_atomic: false,
    delivery_ack_proven: false,
    delivery_fenced: false,
    owner_gate_required: true,
  });
}
