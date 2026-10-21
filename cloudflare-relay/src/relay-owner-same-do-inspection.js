// G0-06 source-only same-WorkerSession-DO inspection receiver.
// The only production caller must be WorkerSession.inspectRetirementCandidate,
// which supplies its own ctx.storage and ctx.getWebSockets. NEVER wire HTTP,
// WSS or public fetch to this contract. An HMAC is NOT human consent.
import {verifyOwnerInspectionCommand} from './relay-owner-inspection-command.js';
import {readRetirementInspectionConsistency} from './relay-retirement-inspection-consistency.js';
import {validateRetirementTarget} from './relay-retirement-fence-policy.js';

const FIELDS = ['worker_id', 'repo', 'pr_number', 'expected_head_sha'];
const NEGATIVE = Object.freeze({
  authority:'NONE', human_owner_authenticated:false, human_consent_verified:false,
  current_github_assignment_verified:false, same_do_verified:false,
  nonce_consumed:false, replay_protection_proven:false,
  read_permitted:false, can_retire:false, can_release_assignment:false,
  delivery_fenced:false, credential_revocation_proven:false,
  snapshot_atomic:false,
});
const block = code => Object.freeze({state:'BLOCKED', code, ...NEGATIVE});
const valid = x => x !== null && typeof x === 'object' && !Array.isArray(x);
function targetFromWake(wake, workerId) {
  if (!valid(wake)) return null;
  const result = {
    worker_id: workerId, repo: wake.repo, pr_number: wake.pr_number,
    expected_head_sha: wake.expected_head_sha,
  };
  return wake.worker_id === workerId && validateRetirementTarget(result) ? result : null;
}
const equal = (a,b) => FIELDS.every(k=>a[k]===b[k]);
async function readIdentity(storage) {
  const workerId = await storage.get('worker_id');
  const active = await storage.get('active_wake');
  const queued = await storage.get('queued_wake');
  if (typeof workerId !== 'string') return null;
  if (active === undefined && queued === undefined) return null;
  if (active !== undefined &&
      (!valid(active) || Object.keys(active).sort().join(',') !== 'phase,wake' ||
       typeof active.phase !== 'string')) return null;
  const options=[];
  if (active !== undefined) options.push(targetFromWake(active.wake,workerId));
  if (queued !== undefined) options.push(targetFromWake(queued,workerId));
  if (options.some(x=>!x) || options.some(x=>!equal(x, options[0]))) return null;
  // Bound preflight state and retain exact bytes for a post-inspection re-read.
  // Different wake phases/IDs with the same target are not the same session.
  let fingerprint;
  try {
    fingerprint = JSON.stringify([
      [workerId === undefined, workerId],
      [active === undefined, active],
      [queued === undefined, queued],
    ]);
  } catch { return null; }
  if (new TextEncoder().encode(fingerprint).byteLength > 65536) return null;
  return {expected:options[0], fingerprint};
}

/**
 * Source-only receiver. Even on synthetically enabled flags, a result is a
 * redacted candidate, never permission or certified trusted DO provenance.
 * This module cannot verify that an injected ctx belongs to Cloudflare.
 * That authority must come from the actual WorkerSession caller AND a
 * separately certified owner-authenticated, private service-binding issuer.
 */
export async function inspectSameDurableObjectCandidate({
  env, command, storage, getWebSockets, cryptoImpl=crypto, clock=()=>Date.now(),
}={}) {
  if (env?.BKE_PREPRODUCTION !== 'true' ||
      env?.BKE_G0_OWNER_INSPECTION_ENABLED !== 'true' ||
      env?.BKE_G0_SAME_DO_RECEIVER_ENABLED !== 'true')
    return block('SAME_DO_RECEIVER_LOCKED');
  if (!storage || typeof storage.get !== 'function' ||
      typeof getWebSockets !== 'function') return block('SAME_DO_CONTEXT_INVALID');
  // Authenticate the strictly validated signed *claim* BEFORE reading any
  // persisted DO state. This is only a MAC-validation input, NEVER a trusted
  // worker/PR assignment or permission to inspect; the actual target is
  // derived independently from storage immediately after MAC verification.
  let signedTarget, proof;
  try {
    signedTarget = {
      worker_id: command?.worker_id,
      repo: command?.repo,
      pr_number: command?.pr_number,
      expected_head_sha: command?.expected_head_sha,
    };
    if (!validateRetirementTarget(signedTarget))
      return block('SAME_DO_SIGNATURE_OR_SCOPE_DENIED');
    proof = await verifyOwnerInspectionCommand({
      env, command, expected:signedTarget, cryptoImpl, clock,
    });
  } catch { return block('SAME_DO_SIGNATURE_OR_SCOPE_DENIED'); }
  if (proof?.state !== 'COMMAND_SIGNATURE_VERIFIED_ONLY')
    return block('SAME_DO_SIGNATURE_OR_SCOPE_DENIED');

  // Only a cryptographically valid, short-lived, exact-purpose command can
  // enter this read path. Even then, HMAC is not human consent or a live
  // service principal. Compare against BOTH stored worker identity and wakes.
  let before;
  try { before = await readIdentity(storage); }
  catch { return block('SAME_DO_IDENTITY_READ_FAILED'); }
  if (!before) return block('SAME_DO_PERSISTED_TARGET_AMBIGUOUS');
  const expected = before.expected;
  if (!equal(signedTarget, expected))
    return block('SAME_DO_PERSISTED_TARGET_MISMATCH');
  let observed, after;
  try {
    observed = await readRetirementInspectionConsistency({
      storage, getWebSockets,
    },expected);
    after = await readIdentity(storage);
  } catch { return block('SAME_DO_INSPECTION_FAILED'); }
  if (!after || after.fingerprint !== before.fingerprint ||
      !equal(after.expected,expected))
    return block('SAME_DO_IDENTITY_CHANGED');
  if (observed?.state !== 'OBSERVED_ONLY')
    return block('SAME_DO_WITNESS_UNAVAILABLE');

  // Positive state is a candidate only. Never expose session IDs, bearer
  // credentials, raw socket attachments, nonce or the signed command.
  return Object.freeze({
    state:'INSPECTION_CANDIDATE_ONLY',
    worker_id:expected.worker_id, repo:expected.repo,
    pr_number:expected.pr_number, expected_head_sha:expected.expected_head_sha,
    active_wake_present:observed.active !== null,
    queued_wake_present:observed.queued !== null,
    registered_socket_id_match_observed:observed.registered_socket_id_match_observed,
    retired_record_schema_observed:observed.retired_record_schema_observed,
    ...NEGATIVE,
  });
}
