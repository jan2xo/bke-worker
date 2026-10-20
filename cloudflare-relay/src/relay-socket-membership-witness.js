// G0-02 SOURCE-ONLY / DORMANT: compare persisted connection metadata with a
// sampled DO WebSocket collection. No Admin authentication, route, fencing,
// cancellation, lease revocation, ACK, or worker/PR authority is granted.
// Do NOT import into a public relay, browser or device execution path.
import {readRelayRetirementWitness} from './relay-retirement-witness.js';

const MAX_SOCKETS = 128;
const blocked = code => Object.freeze({
  state: 'BLOCKED', code, authority: 'NONE', can_retire: false,
  delivery_fenced: false, delivery_ack_proven: false,
});
const record = v => v !== null && typeof v === 'object' && !Array.isArray(v);
const exact = (v, keys) => record(v) && Object.keys(v).length === keys.length &&
  keys.every(k => Object.prototype.hasOwnProperty.call(v, k));

/**
 * Sample registered socket attachments using the exact WorkerSession schema.
 *
 * Both dependencies MUST be supplied only by one privileged WorkerSession DO:
 * the actual this.ctx.storage and this.ctx.getWebSockets.bind(this.ctx).
 * They are not authentication, and arbitrary callbacks cannot prove provenance.
 * Snapshot and socket observation are NOT atomic: a match can go stale.
 */
export async function readRelaySocketMembershipWitness(deps, expected) {
  if (!exact(deps, ['storage', 'getWebSockets']) ||
      !deps.storage || typeof deps.storage.get !== 'function' ||
      typeof deps.getWebSockets !== 'function') return blocked('DO_CONTEXT_REQUIRED');

  const baseline = await readRelayRetirementWitness(deps.storage, expected);
  if (baseline.state !== 'OBSERVED_ONLY') return baseline;

  let storedBefore, storedAfter, sockets;
  try {
    storedBefore = await deps.storage.get('active_connection_id');
    sockets = deps.getWebSockets();
    storedAfter = await deps.storage.get('active_connection_id');
  } catch {
    return blocked('SOCKET_OBSERVATION_FAILED');
  }
  if ((storedBefore !== undefined) !== baseline.active_connection_id_present ||
      storedBefore !== storedAfter) return blocked('CONNECTION_STATE_CHANGED');
  if (storedBefore !== undefined &&
      (typeof storedBefore !== 'string' || storedBefore.length < 1 ||
       storedBefore.length > 128)) return blocked('CONNECTION_METADATA_MALFORMED');
  if (!Array.isArray(sockets) || sockets.length > MAX_SOCKETS) {
    return blocked('SOCKET_COLLECTION_INVALID');
  }

  let matched = 0;
  for (const socket of sockets) {
    if (!socket || typeof socket.deserializeAttachment !== 'function') {
      return blocked('SOCKET_ATTACHMENT_UNREADABLE');
    }
    let attachment;
    try {
      attachment = socket.deserializeAttachment();
    } catch {
      return blocked('SOCKET_ATTACHMENT_UNREADABLE');
    }
    if (!exact(attachment, ['workerId', 'connectionId', 'registered', 'sessionId']) ||
        attachment.workerId !== expected.worker_id ||
        typeof attachment.connectionId !== 'string' ||
        attachment.connectionId.length < 1 || attachment.connectionId.length > 128 ||
        typeof attachment.registered !== 'boolean' ||
        (attachment.registered &&
          (typeof attachment.sessionId !== 'string' || !attachment.sessionId ||
           attachment.sessionId.length > 128)) ||
        (!attachment.registered && attachment.sessionId !== null)) {
      return blocked('SOCKET_ATTACHMENT_CONFLICT');
    }
    if (attachment.registered) {
      // Any registered socket other than the persisted authoritative ID
      // makes the snapshot ambiguous, even if it is about to be closed.
      if (storedBefore === undefined ||
          attachment.connectionId !== storedBefore) {
        return blocked('REGISTERED_SOCKET_CONFLICT');
      }
      matched += 1;
      if (matched > 1) return blocked('DUPLICATE_REGISTERED_SOCKET');
    }
  }

  return Object.freeze({
    ...baseline,
    // Only confirms sampled attachment equality. NOT open/now/live authority.
    registered_socket_id_match_observed: matched === 1,
    socket_collection_sample_size: sockets.length,
    socket_liveness_proven: false,
    socket_sample_atomic: false,
    can_retire: false,
    authority: 'NONE',
    delivery_ack_proven: false,
    delivery_fenced: false,
  });
}
