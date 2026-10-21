// G0-05 DORMANT SOURCE-ONLY cryptographic command-shape guard.
// NEVER import into public relay/HTTP/WSS or invoke on a live Durable Object.
// HMAC proves possession of a distinct future server key; it CANNOT prove a
// human's Access login/consent, GitHub assignment, replay lock or DO identity.
// No signer, route, storage write, or owner authorization is provided.
import {validateRetirementTarget} from './relay-retirement-fence-policy.js';

const PURPOSE = 'read_retirement_witness_v1';
const DOMAIN = 'bke-worker/owner-inspection-command/v1';
const VERSION = 1;
const MAX_AGE_MS = 30_000;
const KEY = /^[A-Za-z0-9_-]{43}$/u;
const NONCE = /^[a-f0-9]{64}$/u;
const ENVELOPE_KEYS = Object.freeze([
  'version', 'purpose', 'worker_id', 'repo', 'pr_number', 'expected_head_sha',
  'nonce', 'issued_at_ms', 'expires_at_ms', 'signature',
]);
const NEGATIVE = Object.freeze({
  authority: 'NONE',
  human_owner_authenticated: false,
  human_consent_verified: false,
  current_github_assignment_verified: false,
  same_do_verified: false,
  nonce_consumed: false,
  replay_protection_proven: false,
  read_permitted: false,
  can_retire: false,
  can_release_assignment: false,
  can_reuse_worker_id: false,
  delivery_fenced: false,
  delivery_ack_proven: false,
  credential_revocation_proven: false,
});
const block = code => Object.freeze({state: 'BLOCKED', code, ...NEGATIVE});
const obj = x => x !== null && typeof x === 'object' && !Array.isArray(x);
const exact = (x, keys) => obj(x) &&
  Object.keys(x).length === keys.length &&
  keys.every(key => Object.prototype.hasOwnProperty.call(x, key));

/** Reject noncanonical base64url, aliases and whitespace; accept exactly 32 bytes. */
function decode32(raw) {
  if (typeof raw !== 'string' || !KEY.test(raw)) return null;
  try {
    const binary = atob(raw.replaceAll('-', '+').replaceAll('_', '/') + '=');
    if (binary.length !== 32) return null;
    const canonical = btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/u, '');
    if (canonical !== raw) return null;
    return Uint8Array.from(binary, char => char.charCodeAt(0));
  } catch {
    return null;
  }
}

export const OWNER_INSPECTION_COMMAND_PURPOSE = PURPOSE;

/**
 * Validate a command's cryptographic format only. 'expected' must eventually
 * be obtained by a trusted internal server from current GitHub PR ownership,
 * NOT copied from caller-controlled JSON. Even an exact positive signature
 * creates NO permission to inspect/retire, no nonce consumption, and no owner
 * identity proof. Dependency injection of crypto/clock is for tests ONLY.
 */
export async function verifyOwnerInspectionCommand({
  env, command, expected, cryptoImpl = crypto, clock = () => Date.now(),
} = {}) {
  if (env?.BKE_PREPRODUCTION !== 'true' ||
      env?.BKE_G0_OWNER_INSPECTION_ENABLED !== 'true') {
    return block('OWNER_INSPECTION_LOCKED');
  }
  if (!validateRetirementTarget(expected) ||
      !exact(command, ENVELOPE_KEYS) ||
      command.version !== VERSION ||
      command.purpose !== PURPOSE ||
      !validateRetirementTarget({
        worker_id: command.worker_id,
        repo: command.repo,
        pr_number: command.pr_number,
        expected_head_sha: command.expected_head_sha,
      }) ||
      typeof command.nonce !== 'string' || !NONCE.test(command.nonce) ||
      typeof command.signature !== 'string' ||
      !KEY.test(command.signature)) {
    return block('OWNER_INSPECTION_COMMAND_INVALID');
  }
  if (command.worker_id !== expected.worker_id ||
      command.repo !== expected.repo ||
      command.pr_number !== expected.pr_number ||
      command.expected_head_sha !== expected.expected_head_sha) {
    return block('OWNER_INSPECTION_TARGET_MISMATCH');
  }

  if (!Number.isSafeInteger(command.issued_at_ms) ||
      !Number.isSafeInteger(command.expires_at_ms) ||
      command.issued_at_ms <= 0 ||
      command.expires_at_ms <= command.issued_at_ms ||
      command.expires_at_ms - command.issued_at_ms > MAX_AGE_MS) {
    return block('OWNER_INSPECTION_WINDOW_INVALID');
  }
  let now;
  try { now = clock(); } catch { return block('OWNER_INSPECTION_CLOCK_UNAVAILABLE'); }
  if (!Number.isSafeInteger(now) || now < command.issued_at_ms ||
      now >= command.expires_at_ms) {
    return block('OWNER_INSPECTION_EXPIRED_OR_FUTURE');
  }

  const secret = decode32(env?.BKE_G0_OWNER_INSPECTION_KEY_B64);
  const signature = decode32(command.signature);
  if (!secret || !signature) return block('OWNER_INSPECTION_CRYPTO_UNCONFIGURED');
  if (typeof cryptoImpl?.subtle?.importKey !== 'function' ||
      typeof cryptoImpl?.subtle?.verify !== 'function') {
    secret.fill(0);
    return block('OWNER_INSPECTION_CRYPTO_UNAVAILABLE');
  }
  // Fixed ordering, audience separation, and exact UTF-8 bytes.
  // A future trusted CC signer must sign precisely this same tuple, only AFTER
  // platform Admin auth + per-action intent + GitHub provenance checks.
  const message = JSON.stringify([
    DOMAIN, VERSION, PURPOSE, command.worker_id, command.repo,
    command.pr_number, command.expected_head_sha, command.nonce,
    command.issued_at_ms, command.expires_at_ms,
  ]);
  let verified = false;
  try {
    const imported = await cryptoImpl.subtle.importKey(
      'raw', secret, {name: 'HMAC', hash: 'SHA-256'}, false, ['verify']);
    verified = await cryptoImpl.subtle.verify(
      'HMAC', imported, signature, new TextEncoder().encode(message));
  } catch {
    return block('OWNER_INSPECTION_CRYPTO_UNAVAILABLE');
  } finally {
    secret.fill(0);
  }
  if (!verified) return block('OWNER_INSPECTION_SIGNATURE_INVALID');

  // A verifier that can be called twice is NOT a replay-protected credential.
  return Object.freeze({
    state: 'COMMAND_SIGNATURE_VERIFIED_ONLY',
    code: 'OWNER_AUTH_GITHUB_AND_DO_PROVENANCE_REQUIRED',
    worker_id: expected.worker_id,
    repo: expected.repo,
    pr_number: expected.pr_number,
    expected_head_sha: expected.expected_head_sha,
    ...NEGATIVE,
  });
}
