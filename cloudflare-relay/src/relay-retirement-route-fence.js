// G0-08: DORMANT, READ-ONLY retirement route-fence observation.
// DO NOT import into WorkerSession or any public route. This function does
// not authenticate an owner, create a fence or authorize normal operations.
// In particular, an ABSENT fence is never evidence that work may proceed.
import {
  FENCED_OPERATIONS, RETIREMENT_FENCE_KEY, validateRetirementTarget,
  validateRetiredFenceRecord,
} from './relay-retirement-fence-policy.js';
import {RETIREMENT_EPOCH_KEY} from './relay-retirement-transaction-kernel.js';

// Auditable source seam inventory, not a runtime patch or an allowlist.
// Real enforcement must also gate ensureIdentity() before its first write.
export const RETIREMENT_ROUTE_SEAMS = Object.freeze({
  connect: 'async connect(request, workerId)',
  register: 'if (!attachment.registered)',
  dispatch: 'async dispatch(request, workerId)',
  recover: 'async recover(request, workerId)',
  send: 'async sendActiveIfSafe()',
  ack: 'async handleAck(ack, socket)',
  promote: 'async promoteQueuedWake()',
  'socket-close': 'async webSocketClose(socket)',
  'socket-error': 'async webSocketError(socket)',
});

const REQUEST_KEYS = Object.freeze(['target','operation']);
const TARGET_KEYS = Object.freeze([
  'worker_id','repo','pr_number','expected_head_sha',
]);
const NEGATIVE = Object.freeze({
  authority:'NONE',
  human_owner_authenticated:false,
  human_consent_verified:false,
  current_github_assignment_verified:false,
  same_do_provenance_verified:false,
  nonce_consumed:false,
  replay_protection_proven:false,
  dispatch_permitted:false,
  connect_permitted:false,
  read_permitted:false,
  can_retire:false,
  can_release_assignment:false,
  can_reuse_worker_id:false,
  delivery_fenced:false,
  all_paths_fenced:false,
  atomic_commit_proven:false,
  credential_revocation_proven:false,
});
const blocked = code => Object.freeze({state:'BLOCKED',code,...NEGATIVE});
const isObject = x => x !== null && typeof x === 'object' && !Array.isArray(x);
const exact = (x,keys) => isObject(x) &&
  Object.keys(x).length === keys.length &&
  keys.every(key=>Object.prototype.hasOwnProperty.call(x,key));
const match = (f,t) => f.worker_id===t.worker_id &&
  f.repo===t.repo && f.pr_number===t.pr_number &&
  f.expected_head_sha===t.expected_head_sha;

// Snapshot the whole input synchronously, including its nested target.
// Do not hold caller-owned objects across asynchronous storage reads.
function capture(input) {
  try {
    if (!exact(input,REQUEST_KEYS) || !exact(input.target,TARGET_KEYS))
      return null;
    const target=Object.freeze({
      worker_id:input.target.worker_id,
      repo:input.target.repo,
      pr_number:input.target.pr_number,
      expected_head_sha:input.target.expected_head_sha,
    });
    const operation=input.operation;
    if (!validateRetirementTarget(target) ||
        typeof operation !== 'string' ||
        !FENCED_OPERATIONS.includes(operation))
      return null;
    return Object.freeze({target,operation});
  } catch {
    return null;
  }
}

async function inspectInsideTransaction(tx,expected) {
  if (!tx || typeof tx.get !== 'function')
    return blocked('TRANSACTION_HANDLE_INVALID');

  const identity=await tx.get('worker_id');
  const fence=await tx.get(RETIREMENT_FENCE_KEY);
  const epoch=await tx.get(RETIREMENT_EPOCH_KEY);

  if (identity!==expected.target.worker_id)
    return blocked('PERSISTED_WORKER_ID_MISMATCH');
  if (fence===undefined && epoch===undefined)
    return blocked('FENCE_ABSENT_UNVERIFIED');
  if (!validateRetiredFenceRecord(fence) ||
      !Number.isSafeInteger(epoch) || epoch < 1 ||
      fence.epoch !== epoch)
    return blocked('FENCE_EPOCH_INCONSISTENT');
  if (!match(fence,expected.target))
    return blocked('FENCE_TARGET_MISMATCH');

  // This only observes a tombstone; it never means every live path actually
  // obeys it. No normal routing operation is ever allowed by this function.
  return Object.freeze({
    state:'RETIRED_BLOCKED',
    code:'WORKER_RETIRED',
    operation:expected.operation,
    ...NEGATIVE,
  });
}

/**
 * Source-only diagnostic of a negative fence decision.
 * A transaction-shaped test double proves neither Cloudflare serialization
 * nor same-DO provenance. NEVER treat any result as positive route authority.
 * No storage.put/delete, sockets, HTTP, GitHub labels or credentials.
 */
export async function inspectDormantRetirementRouteFence(storage,input) {
  const expected=capture(input);
  if (!expected) return blocked('REQUEST_INVALID');
  if (!storage || typeof storage.transaction !== 'function')
    return blocked('TRANSACTION_UNAVAILABLE');
  try {
    const result=await storage.transaction(tx=>
      inspectInsideTransaction(tx,expected));
    if (!result || (result.state!=='BLOCKED' &&
                      result.state!=='RETIRED_BLOCKED'))
      return blocked('TRANSACTION_RESULT_INVALID');
    if (result.state==='RETIRED_BLOCKED' &&
        result.operation!==expected.operation)
      return blocked('TRANSACTION_RESULT_INVALID');
    // Rebuild the public result instead of returning any injected tx object.
    return result.state==='RETIRED_BLOCKED'
      ? Object.freeze({
        state:'RETIRED_BLOCKED',
        code:'WORKER_RETIRED',
        operation:expected.operation,
        ...NEGATIVE,
      })
      : blocked(typeof result.code==='string' &&
                /^[A-Z_]{1,64}$/u.test(result.code)
        ? result.code : 'TRANSACTION_RESULT_INVALID');
  } catch {
    return blocked('TRANSACTION_READ_UNCERTAIN');
  }
}
