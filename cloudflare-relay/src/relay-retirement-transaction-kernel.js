// G0-07 SOURCE-ONLY, UNIMPORTED transactional retirement-fence kernel.
//
// DANGER: This module contains a storage writer. NEVER import into runtime,
// invoke on a live DO, or expose as an RPC before separate trusted owner Access,
// action consent, GitHub assignment, private issuer/nonce authorization, AND
// all-path monotonic fence enforcement are independently certified.
// Its inputs have NO authenticated owner provenance. Its outputs grant NONE.
import {isValidDeliveryId} from './protocol.js';
import {readRelayRetirementWitness} from './relay-retirement-witness.js';
import {
  RETIREMENT_FENCE_KEY, validateRetirementTarget, validateRetiredFenceRecord,
} from './relay-retirement-fence-policy.js';

export const RETIREMENT_EPOCH_KEY = 'retirement_epoch_v1';

const REQUEST_KEYS = Object.freeze([
  'target','retirement_id','created_at_ms','expected_delivery_ids',
]);
const DECISION_ID = /^[A-Za-z0-9._:-]{1,128}$/u;
const NEGATIVE = Object.freeze({
  authority: 'NONE',
  human_owner_authenticated: false,
  human_consent_verified: false,
  current_github_assignment_verified: false,
  same_do_provenance_verified: false,
  nonce_consumed: false,
  replay_protection_proven: false,
  can_commit: false,
  can_retire: false,
  can_dispatch: false,
  can_reconnect: false,
  can_release_assignment: false,
  can_reuse_worker_id: false,
  delivery_fenced: false,
  delivery_ack_proven: false,
  socket_membership_verified: false,
  all_paths_fenced: false,
  atomic_commit_proven: false,
  credential_revocation_proven: false,
});
const blocked = code => Object.freeze({state:'BLOCKED',code,...NEGATIVE});
const object = value => value !== null && typeof value === 'object' &&
  !Array.isArray(value);
const exact = (value, keys) => object(value) &&
  Object.keys(value).length === keys.length &&
  keys.every(key => Object.prototype.hasOwnProperty.call(value,key));
const sameTarget = (a,b) => a.worker_id === b.worker_id &&
  a.repo === b.repo && a.pr_number === b.pr_number &&
  a.expected_head_sha === b.expected_head_sha;
const sameRecord = (a,b) => a.schema_version === b.schema_version &&
  a.status === b.status && sameTarget(a,b) &&
  a.retirement_id === b.retirement_id && a.epoch === b.epoch &&
  a.created_at_ms === b.created_at_ms;
const validEpoch = x => Number.isSafeInteger(x) && x >= 1;

function validateRequest(req) {
  if (!exact(req,REQUEST_KEYS) || !validateRetirementTarget(req.target) ||
      typeof req.retirement_id !== 'string' || !DECISION_ID.test(req.retirement_id) ||
      !Number.isSafeInteger(req.created_at_ms) || req.created_at_ms <= 0 ||
      !Array.isArray(req.expected_delivery_ids) ||
      req.expected_delivery_ids.length < 1 ||
      req.expected_delivery_ids.length > 2) return false;
  const sorted = [...req.expected_delivery_ids].sort();
  return req.expected_delivery_ids.every((id,i) =>
    typeof id === 'string' && isValidDeliveryId(id) &&
    sorted[i] === id && (i === 0 || sorted[i-1] !== id));
}
// Canonicalize and validate BEFORE the first await. The caller retains its
// original reference and may change nested target/array values while async
// DO transaction reads are suspended. Never pass those references onward.
const TARGET_KEYS = Object.freeze([
  'worker_id','repo','pr_number','expected_head_sha',
]);
function snapshotRequest(request) {
  try {
    if (!exact(request,REQUEST_KEYS)) return null;
    const inputTarget=request.target;
    const inputIds=request.expected_delivery_ids;
    if (!exact(inputTarget,TARGET_KEYS) ||
        !Array.isArray(inputIds) ||
        inputIds.length < 1 || inputIds.length > 2) return null;
    const target=Object.freeze({
      worker_id:inputTarget.worker_id, repo:inputTarget.repo,
      pr_number:inputTarget.pr_number,
      expected_head_sha:inputTarget.expected_head_sha,
    });
    const expected_delivery_ids=Object.freeze([...inputIds]);
    const canonical=Object.freeze({
      target,
      retirement_id:request.retirement_id,
      created_at_ms:request.created_at_ms,
      expected_delivery_ids,
    });
    return validateRequest(canonical) ? canonical : null;
  } catch {
    return null; // throwing getter/proxy must not enter the transaction
  }
}
function makeFence(req) {
  return Object.freeze({
    schema_version:1, status:'retired', ...req.target,
    retirement_id:req.retirement_id, epoch:1,
    created_at_ms:req.created_at_ms,
  });
}
async function inTransaction(tx,req) {
  if (!tx || typeof tx.get !== 'function' || typeof tx.put !== 'function') {
    return blocked('TRANSACTION_HANDLE_INVALID');
  }
  // The monotonic high-water mark and immutable fence are inspected together.
  // Any missing half, mismatch, attempted downgrade, or stale deletion blocks.
  const storedFence = await tx.get(RETIREMENT_FENCE_KEY);
  const highWater = await tx.get(RETIREMENT_EPOCH_KEY);
  const existing = storedFence !== undefined || highWater !== undefined;
  if (existing) {
    if (!validateRetiredFenceRecord(storedFence) ||
        !validEpoch(highWater) || storedFence.epoch !== highWater) {
      return blocked('FENCE_EPOCH_INCONSISTENT');
    }
    if (!sameTarget(storedFence,req.target)) {
      return blocked('EXISTING_FENCE_TARGET_CONFLICT');
    }
    if (storedFence.retirement_id !== req.retirement_id ||
        storedFence.created_at_ms !== req.created_at_ms) {
      return blocked('EXISTING_FENCE_DECISION_CONFLICT');
    }
  }

  // G0-01 witness and exact delivery-set matching apply to BOTH first-write
  // and existing-fence observations. A matching retirement ID alone is not
  // a successful delivery-set CAS after the persisted wake changes.
  // All checks happen inside the same injected transaction callback.
  const witness = await readRelayRetirementWitness(tx,req.target);
  if (witness.state !== 'OBSERVED_ONLY')
    return blocked('PERSISTED_WAKE_OR_IDENTITY_UNTRUSTED');
  if (!witness.active && !witness.queued)
    return blocked('NO_PERSISTED_WAKE_TO_RECONCILE');
  if (witness.active_connection_id_present)
    return blocked('CONNECTION_ID_PRESENT_SOCKET_UNVERIFIED');

  const actual = [witness.active?.delivery_id,witness.queued?.delivery_id]
    .filter(x => x !== undefined);
  const distinct = [...new Set(actual)].sort();
  if (distinct.length !== req.expected_delivery_ids.length ||
      distinct.some((id,i)=>id !== req.expected_delivery_ids[i]))
    return blocked('DELIVERY_SET_MISMATCH');
  if (existing) return {state:'EXISTING',record:storedFence};

  const record=makeFence(req);
  if (!validateRetiredFenceRecord(record))
    return blocked('CANDIDATE_RECORD_INVALID');
  // Both keys MUST commit inside one serialized DO storage.transaction.
  // A test double's transaction() is never evidence of a real Cloudflare DO.
  await tx.put(RETIREMENT_FENCE_KEY,record);
  await tx.put(RETIREMENT_EPOCH_KEY,record.epoch);
  return {state:'STAGED',record};
}

/**
 * PRE-AUTHORIZATION KERNEL ONLY. Never use with caller-controlled requests.
 * storage.transaction is required and no nontransactional write fallback exists.
 * A transaction error may occur AFTER commit; return UNCERTAIN, never safe.
 *
 * Even matching readback is ONLY shape observation. Without owner auth,
 * serialized routing checks across every relay path, and live DO provenance,
 * this function CANNOT prove durable retirement or allow assignment release.
 */
export async function stageRetirementFenceCandidate(storage,request) {
  // Snapshot all caller-owned fields synchronously, including nested objects
  // and arrays, before crossing any async/transaction boundary.
  const canonical=snapshotRequest(request);
  if (!canonical) return blocked('REQUEST_INVALID');
  if (!storage || typeof storage.transaction !== 'function' ||
      typeof storage.get !== 'function')
    return blocked('TRANSACTION_UNAVAILABLE');
  let outcome;
  try {
    outcome=await storage.transaction(tx=>inTransaction(tx,canonical));
  } catch {
    return blocked('TRANSACTION_OUTCOME_UNCERTAIN');
  }
  if (!outcome || outcome.state === 'BLOCKED') {
    return outcome?.state === 'BLOCKED' ? outcome : blocked('TRANSACTION_RESULT_INVALID');
  }
  if ((outcome.state !== 'STAGED' && outcome.state !== 'EXISTING') ||
      !validateRetiredFenceRecord(outcome.record))
    return blocked('TRANSACTION_RESULT_INVALID');

  let persisted,epoch;
  try {
    persisted=await storage.get(RETIREMENT_FENCE_KEY);
    epoch=await storage.get(RETIREMENT_EPOCH_KEY);
  } catch {
    return blocked('POST_TRANSACTION_READBACK_UNCERTAIN');
  }
  if (!validateRetiredFenceRecord(persisted) ||
      !validEpoch(epoch) || epoch !== persisted.epoch ||
      !sameRecord(persisted,outcome.record))
    return blocked('POST_TRANSACTION_READBACK_MISMATCH');

  return Object.freeze({
    state:outcome.state === 'STAGED' ?
      'STAGED_SHAPE_READBACK_ONLY' : 'EXISTING_SHAPE_READBACK_ONLY',
    code:'OWNER_DO_PROVENANCE_AND_ALL_PATH_FENCE_REQUIRED',
    observed_epoch:epoch,
    ...NEGATIVE,
  });
}
