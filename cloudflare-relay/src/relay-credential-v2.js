// SOURCE-ONLY cryptographic evidence for future GeckoView relay credential v2.
// Never import from relay HTTP/WebSocket runtime until admission/nonce-CAS is certified.
// A valid signature does NOT grant WSS, PR, pairing, enrollment or renewal authority.
const AUD = 'bke-worker/relay/geckoview-device/v2';
const PROOF_AUD = 'bke-worker/relay/geckoview-wss-proof/v1';
const WORKER = /^[a-z0-9][a-z0-9-]{0,62}$/u;
const INSTALL = /^[1-9][0-9]{0,19}$/u;
const HEX = /^[a-f0-9]{64}$/u;
const ID = /^[A-Za-z0-9_-]{22}$/u;
const B64_32 = /^[A-Za-z0-9_-]{43}$/u;
const B64_64 = /^[A-Za-z0-9_-]{86}$/u;
const MAX_TTL = 300_000;
const text = new TextEncoder();
const block = code => Object.freeze({state:'BLOCKED', code, authority:'NONE'});
const exact = (v, keys) => v !== null && typeof v === 'object' && !Array.isArray(v) &&
  Object.keys(v).sort().join(',') === keys.split(',').sort().join(',');
const boundedTime = v => Number.isSafeInteger(v) && v > 0 && v < 253402300799999;
const validHash = v => typeof v === 'string' && HEX.test(v);
const validEpoch = v => Number.isSafeInteger(v) && v >= 1 && v <= 1_000_000;

function decodeBase64Url(value, pattern, byteCount) {
  if (typeof value !== 'string' || !pattern.test(value)) return null;
  try {
    const raw = atob(value.replaceAll('-', '+').replaceAll('_', '/') + '='.repeat((4-value.length%4)%4));
    const bytes = Uint8Array.from(raw, x => x.charCodeAt(0));
    if (bytes.length !== byteCount || encodeBase64Url(bytes) !== value) return null;
    return bytes;
  } catch { return null; }
}
function encodeBase64Url(bytes) {
  let raw = '';
  for (const byte of bytes) raw += String.fromCharCode(byte);
  return btoa(raw).replaceAll('+','-').replaceAll('/','_').replace(/=+$/u,'');
}

export function relayLeaseV2Message(lease) {
  return JSON.stringify([AUD, lease.v, lease.installation_id, lease.worker_id,
    lease.device_key_sha256, lease.session_binding_sha256, lease.epoch,
    lease.token_id, lease.issued_at_ms, lease.expires_at_ms]);
}
export function relayWssProofV2Message(proof, lease, tag) {
  return JSON.stringify([PROOF_AUD, proof.v, lease.installation_id,
    lease.worker_id, lease.token_id, tag, proof.nonce, proof.method, proof.path]);
}

function validPublicKey(jwk) {
  return exact(jwk,'crv,kty,x,y') && jwk.kty === 'EC' && jwk.crv === 'P-256' &&
    decodeBase64Url(jwk.x, B64_32, 32) !== null &&
    decodeBase64Url(jwk.y, B64_32, 32) !== null;
}
function validLease(lease) {
  return exact(lease,'device_key_sha256,epoch,expires_at_ms,installation_id,issued_at_ms,session_binding_sha256,token_id,v,worker_id') &&
    lease.v === 2 && typeof lease.worker_id === 'string' && WORKER.test(lease.worker_id) &&
    typeof lease.installation_id === 'string' && INSTALL.test(lease.installation_id) &&
    validHash(lease.device_key_sha256) && validHash(lease.session_binding_sha256) &&
    validEpoch(lease.epoch) && decodeBase64Url(lease.token_id, ID, 16) !== null &&
    boundedTime(lease.issued_at_ms) && boundedTime(lease.expires_at_ms) &&
    lease.expires_at_ms > lease.issued_at_ms &&
    lease.expires_at_ms - lease.issued_at_ms <= MAX_TTL;
}
function validProof(proof, worker) {
  return exact(proof,'method,nonce,path,signature,v') && proof.v === 1 &&
    proof.method === 'GET' && proof.path === '/relay/' + worker &&
    decodeBase64Url(proof.nonce, B64_32, 32) !== null &&
    decodeBase64Url(proof.signature, B64_64, 64) !== null;
}
function validExpected(expected) {
  return exact(expected,'epoch,installation_id,session_binding_sha256,worker_id') &&
    validEpoch(expected.epoch) && typeof expected.installation_id === 'string' &&
    INSTALL.test(expected.installation_id) &&
    validHash(expected.session_binding_sha256) && WORKER.test(expected.worker_id);
}

/**
 * A verifier, not an issuer or renewal endpoint. Inputs expected, serverKey,
 * and pinnedDeviceJwk MUST be obtained from separately certified SERVER-OWNED
 * current paired-device/installation/session records; passing caller claims is
 * not authentication. The live relay does not import this function.
 * The caller must atomically consume a server-issued nonce in its Durable
 * Object and reread current authorization BEFORE granting transport access.
 */
export async function verifyGeckoRelayPresentationV2({
  credential, proof, expected, serverKey, pinnedDeviceJwk,
  now = () => Date.now(), cryptoImpl = crypto,
} = {}) {
  if (!validExpected(expected) || !(serverKey instanceof Uint8Array) ||
      serverKey.length < 32 || !validPublicKey(pinnedDeviceJwk) ||
      typeof cryptoImpl?.subtle?.verify !== 'function' ||
      typeof cryptoImpl?.subtle?.digest !== 'function') return block('V2_TRUSTED_CONFIGURATION_REQUIRED');
  if (!exact(credential,'lease,tag') || !validLease(credential.lease) ||
      decodeBase64Url(credential.tag, B64_32, 32) === null) return block('V2_CREDENTIAL_MALFORMED');
  const lease = credential.lease;
  if (lease.worker_id !== expected.worker_id ||
      lease.installation_id !== expected.installation_id ||
      lease.session_binding_sha256 !== expected.session_binding_sha256 ||
      lease.epoch !== expected.epoch) return block('V2_CREDENTIAL_SCOPE_MISMATCH');
  let instant;
  try { instant = now(); } catch { return block('V2_CLOCK_UNAVAILABLE'); }
  if (!boundedTime(instant) || instant < lease.issued_at_ms ||
      instant >= lease.expires_at_ms) return block('V2_CREDENTIAL_EXPIRED_OR_FUTURE');
  if (!validProof(proof, expected.worker_id)) return block('V2_PROOF_MALFORMED');
  try {
    const thumbprint = await cryptoImpl.subtle.digest('SHA-256',
      text.encode(JSON.stringify(['EC','P-256', pinnedDeviceJwk.x,pinnedDeviceJwk.y])));
    const hash = Array.from(new Uint8Array(thumbprint), b => b.toString(16).padStart(2,'0')).join('');
    if (lease.device_key_sha256 !== hash) return block('V2_DEVICE_KEY_MISMATCH');
    const hmac = await cryptoImpl.subtle.importKey('raw',serverKey,
      {name:'HMAC',hash:'SHA-256'},false,['verify']);
    if (!await cryptoImpl.subtle.verify('HMAC',hmac,
      decodeBase64Url(credential.tag,B64_32,32),text.encode(relayLeaseV2Message(lease))))
      return block('V2_LEASE_MAC_DENIED');
    const device = await cryptoImpl.subtle.importKey('jwk',pinnedDeviceJwk,
      {name:'ECDSA',namedCurve:'P-256'},false,['verify']);
    if (!await cryptoImpl.subtle.verify({name:'ECDSA',hash:'SHA-256'},device,
      decodeBase64Url(proof.signature,B64_64,64),
      text.encode(relayWssProofV2Message(proof,lease,credential.tag))))
      return block('V2_DEVICE_PROOF_DENIED');
  } catch { return block('V2_CRYPTO_DENIED'); }
  // A signed nonce is replayable until an independent atomic nonce CAS.
  // Crypto validation never grants connection, pairing, renewal or PR authority.
  return Object.freeze({state:'CRYPTO_VERIFIED_ONLY',authority:'NONE',
    nonce_authority:'NOT_CHECKED',paired_device_authority:'NOT_CHECKED',
    relay_connection_authority:'NONE',renewal_authority:'NONE'});
}
