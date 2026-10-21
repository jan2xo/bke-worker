// G0 owner-gated deployment PREPARATION: a legacy-identity emergency-stop
// interlock for the ACTUAL WorkerSession entrypoints. This module is imported
// into source runtime but its operator-only env switch is NOT provisioned in
// Wrangler, and NO Cloudflare deployment/activation is authorized by this PR.
//
// CRITICAL: This is NOT a durable retirement tombstone, proof of DO state,
// cancellation of already delivered ChatGPT work, release authority, or a
// substitute for the independently authenticated G0 owner retirement gate.
// When enabled, its sole effect is to DENY matching identity operations.
// Misconfigured activation fails closed rather than returning an allow.
import {isValidWorkerId} from './protocol.js';

export const QUARANTINE_ENABLED_KEY='BKE_G0_RUNTIME_QUARANTINE_ENABLED';
export const QUARANTINE_WORKER_KEY='BKE_G0_RUNTIME_QUARANTINE_WORKER_ID';

/** Trusted env and WorkerSession-owned identity ONLY; never user payload fields. */
export function mustStopWorkerRoute(env,workerId) {
  let enabled,target;
  try {
    enabled=env?.[QUARANTINE_ENABLED_KEY];
    if (enabled===undefined || enabled==='false') return false;
    // The configuration is intentionally NOT declared in wrangler.toml;
    // an unexpected value must never silently downgrade an attempted fence.
    if (enabled!=='true') return true;
    target=env?.[QUARANTINE_WORKER_KEY];
  } catch {
    return true;
  }
  if (!isValidWorkerId(target) || !isValidWorkerId(workerId)) return true;
  return target===workerId;
}

export const QUARANTINE_DENIAL_CODE='RELAY_IDENTITY_QUARANTINED';
