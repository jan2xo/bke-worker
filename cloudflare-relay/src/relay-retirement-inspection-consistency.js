// G0-04 SOURCE-ONLY / DORMANT. NOT imported by src/index.js.
// Two-pass consistency is NOT an atomic snapshot or owner authentication.
// Only a future owner-authenticated internal WorkerSession integration may pass
// that same DO's ctx.storage + ctx.getWebSockets; input cannot prove provenance.
import {readRelaySocketMembershipWitness} from './relay-socket-membership-witness.js';
import {
  RETIREMENT_FENCE_KEY, validateRetirementTarget, validateRetiredFenceRecord,
} from './relay-retirement-fence-policy.js';

const OBSERVED_KEYS = Object.freeze([
  'worker_id', 'active_wake', 'queued_wake', 'recent_deliveries',
  'active_connection_id', 'relay_observation_v1', RETIREMENT_FENCE_KEY,
]);
const MAX_SNAPSHOT_BYTES = 65536;
// UTF-16 string.length is not an encoded-byte count (e.g., emoji and CJK).
const UTF8_ENCODER = new TextEncoder();
const NEGATIVE = Object.freeze({
  authority: 'NONE',
  can_retire: false,
  can_dispatch: false,
  can_release_assignment: false,
  can_reuse_worker_id: false,
  delivery_ack_proven: false,
  delivery_fenced: false,
  atomic_commit_proven: false,
  credential_revocation_proven: false,
  owner_authenticated: false,
  do_provenance_verified: false,
  snapshot_atomic: false,
  socket_sample_atomic: false,
  socket_liveness_proven: false,
  owner_gate_required: true,
});
const block = code => Object.freeze({state: 'BLOCKED', code, ...NEGATIVE});
const object = x => x !== null && typeof x === 'object' && !Array.isArray(x);
const exact = (x, keys) => object(x) &&
  Object.keys(x).length === keys.length &&
  keys.every(key => Object.prototype.hasOwnProperty.call(x, key));

async function capture(storage) {
  const parts = [];
  let fence;
  for (const key of OBSERVED_KEYS) {
    const value = await storage.get(key);
    if (key === RETIREMENT_FENCE_KEY) fence = value;
    // Stringify each value immediately, not after later asynchronous reads.
    // The missing marker must distinguish undefined from an explicit null.
    const encoded = JSON.stringify([value === undefined, value]);
    if (typeof encoded !== 'string' ||
        UTF8_ENCODER.encode(encoded).byteLength > MAX_SNAPSHOT_BYTES) {
      return null;
    }
    parts.push(encoded);
  }
  const fingerprint = JSON.stringify(parts);
  if (UTF8_ENCODER.encode(fingerprint).byteLength > MAX_SNAPSHOT_BYTES) return null;
  return {fingerprint, fence};
}

/**
 * Pure read-only composition of previously certified source witnesses.
 *
 * This API is intentionally NOT a public RPC, authorization verifier, owner
 * token, release gate, dispatch allowlist or atomic DO operation. The caller
 * cannot set "authenticated" or inject a fake owner approval field.
 * A match means two sampled JSON representations were equal, and nothing more.
 */
export async function readRetirementInspectionConsistency(deps, expected) {
  if (!validateRetirementTarget(expected)) return block('TARGET_INVALID');
  if (!exact(deps, ['storage', 'getWebSockets']) ||
      !deps.storage || typeof deps.storage.get !== 'function' ||
      typeof deps.getWebSockets !== 'function') return block('DO_CONTEXT_REQUIRED');

  let before, sampled, after;
  try {
    before = await capture(deps.storage);
    if (!before) return block('SNAPSHOT_INVALID_OR_OVERSIZED');
    sampled = await readRelaySocketMembershipWitness(deps, expected);
    after = await capture(deps.storage);
    if (!after) return block('SNAPSHOT_INVALID_OR_OVERSIZED');
  } catch {
    return block('INSPECTION_READ_FAILED');
  }
  if (before.fingerprint !== after.fingerprint) {
    return block('DO_STATE_CHANGED_DURING_INSPECTION');
  }
  if (!sampled || sampled.state !== 'OBSERVED_ONLY') {
    return block(sampled?.state === 'BLOCKED' ? sampled.code : 'SOCKET_WITNESS_UNAVAILABLE');
  }

  const fence = before.fence;
  if (fence !== undefined) {
    if (!validateRetiredFenceRecord(fence)) return block('FENCE_RECORD_MALFORMED');
    if (fence.worker_id !== expected.worker_id ||
        fence.repo !== expected.repo ||
        fence.pr_number !== expected.pr_number ||
        fence.expected_head_sha !== expected.expected_head_sha) {
      return block('FENCE_TARGET_MISMATCH');
    }
  }

  return Object.freeze({
    state: 'OBSERVED_ONLY',
    worker_id: expected.worker_id,
    repo: expected.repo,
    pr_number: expected.pr_number,
    expected_head_sha: expected.expected_head_sha,
    active: sampled.active,
    queued: sampled.queued,
    recent_delivery_count: sampled.recent_delivery_count,
    active_connection_id_present: sampled.active_connection_id_present,
    registered_socket_id_match_observed: sampled.registered_socket_id_match_observed,
    socket_collection_sample_size: sampled.socket_collection_sample_size,
    // Schema only: even a candidate tombstone can pass this test.
    retired_record_schema_observed: fence !== undefined,
    retired_epoch_shape_observed: fence === undefined ? null : fence.epoch,
    ...NEGATIVE,
  });
}
