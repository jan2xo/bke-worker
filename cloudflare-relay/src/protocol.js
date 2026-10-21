export const PROTOCOL = 1;
export const CONTROL_REPOSITORY = "jan2xo/bke-worker";
export const CONTROL_REPOSITORIES = new Set([
  CONTROL_REPOSITORY,
  "jan2xo/bke-demo-app",
]);
export const ASSIGNMENT_LABEL_PREFIX = "bke-worker:";
export const CROSS_PR_RECOVERY_MARKER = "BKE-RECOVER-CROSS-PR-WAKE";
export const CONTINUATION_MARKER = "BKE-CONTINUATION-RESUME";
export const MAX_WEBHOOK_BYTES = 1024 * 1024;

const WORKER_ID = /^[a-z0-9][a-z0-9-]{0,62}$/;
const SHA = /^[0-9a-f]{40}$/;
const DELIVERY = /^[A-Za-z0-9._:-]{1,128}$/;
const ACK_STATES = new Set(["accepted", "deferred", "rejected", "completed"]);
const ROUTING_ACTIONS = new Set(["opened", "reopened", "labeled", "synchronize", "edited"]);

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function exactKeys(value, expected) {
  if (!isObject(value)) return false;
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  return actual.length === wanted.length &&
    actual.every((key, index) => key === wanted[index]);
}

function jsonResult(kind, extra = {}) {
  return { kind, ...extra };
}

export function isValidWorkerId(value) {
  return typeof value === "string" && WORKER_ID.test(value);
}

export function isValidDeliveryId(value) {
  return typeof value === "string" && DELIVERY.test(value);
}

const RELAY_TOKEN_CONTEXT = "bke-worker-relay-v1:";

function bytesToBase64Url(bytes) {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary)
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/u, "");
}

function base64UrlToBytes(value) {
  if (typeof value !== "string" || !/^[A-Za-z0-9_-]{43}$/.test(value)) {
    return null;
  }
  const padded = value.replaceAll("-", "+").replaceAll("_", "/") + "=";
  try {
    const binary = atob(padded);
    return Uint8Array.from(binary, (character) => character.charCodeAt(0));
  } catch {
    return null;
  }
}

async function relayHmacKey(secretKey, usages) {
  if (typeof secretKey !== "string" || secretKey.length < 32) return null;
  return crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secretKey),
    { name: "HMAC", hash: "SHA-256" },
    false,
    usages,
  );
}

export async function deriveRelayToken(secretKey, workerId) {
  if (!isValidWorkerId(workerId)) throw new Error("WORKER_ID_INVALID");
  const key = await relayHmacKey(secretKey, ["sign"]);
  if (!key) throw new Error("RELAY_TOKEN_KEY_INVALID");
  const signature = new Uint8Array(
    await crypto.subtle.sign(
      "HMAC",
      key,
      new TextEncoder().encode(RELAY_TOKEN_CONTEXT + workerId),
    ),
  );
  return bytesToBase64Url(signature);
}

export async function relayBearerMatches(headerValue, secretKey, workerId) {
  if (!isValidWorkerId(workerId)) return false;
  const match = /^Bearer ([A-Za-z0-9_-]{43})$/.exec(
    typeof headerValue === "string" ? headerValue : "",
  );
  if (!match) return false;

  const supplied = base64UrlToBytes(match[1]);
  const key = await relayHmacKey(secretKey, ["verify"]);
  if (!supplied || !key) return false;

  return crypto.subtle.verify(
    "HMAC",
    key,
    supplied,
    new TextEncoder().encode(RELAY_TOKEN_CONTEXT + workerId),
  );
}

function hexToBytes(hex) {
  if (!/^[0-9a-f]{64}$/i.test(hex)) return null;
  const bytes = new Uint8Array(hex.length / 2);
  for (let index = 0; index < bytes.length; index += 1) {
    bytes[index] = Number.parseInt(hex.slice(index * 2, index * 2 + 2), 16);
  }
  return bytes;
}

export async function verifyGitHubSignature(bodyBytes, signatureHeader, secret) {
  if (!(bodyBytes instanceof Uint8Array) || !secret || !signatureHeader) return false;
  const match = /^sha256=([0-9a-f]{64})$/i.exec(signatureHeader);
  if (!match) return false;
  const supplied = hexToBytes(match[1]);
  if (!supplied) return false;

  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["verify"],
  );
  return crypto.subtle.verify("HMAC", key, supplied, bodyBytes);
}

function readWorkerLabels(pullRequest) {
  if (!Array.isArray(pullRequest?.labels)) return [];
  const labels = [];
  for (const item of pullRequest.labels) {
    const name = typeof item?.name === "string" ? item.name : "";
    if (name.toLowerCase().startsWith(ASSIGNMENT_LABEL_PREFIX)) {
      labels.push(name);
    }
  }
  return [...new Map(labels.map((label) => [label.toLowerCase(), label])).values()];
}

function workerIdFromLabel(label) {
  const prefixLength = ASSIGNMENT_LABEL_PREFIX.length;
  if (typeof label !== "string" ||
      !label.toLowerCase().startsWith(ASSIGNMENT_LABEL_PREFIX)) {
    return null;
  }
  const workerId = label.slice(prefixLength);
  return isValidWorkerId(workerId) ? workerId : null;
}

export function routeGitHubPullRequest(payload, deliveryId) {
  if (!isValidDeliveryId(deliveryId)) {
    return jsonResult("error", { status: 400, error: "GITHUB_DELIVERY_INVALID" });
  }
  if (!isObject(payload)) {
    return jsonResult("error", { status: 400, error: "GITHUB_PAYLOAD_INVALID" });
  }
  const repository = typeof payload?.repository?.full_name === "string"
    ? payload.repository.full_name
    : "";
  if (!CONTROL_REPOSITORIES.has(repository)) {
    return jsonResult("ignore", { reason: "NON_CONTROL_REPOSITORY" });
  }

  const pullRequest = payload.pull_request;
  if (!isObject(pullRequest)) {
    return jsonResult("error", { status: 400, error: "GITHUB_PULL_REQUEST_REQUIRED" });
  }

  // Both fields describe the SAME GitHub PR. Never let a signed
  // envelope PR number route the labels/head from another embedded PR.
  // Preserve the existing v1 single-number fallback for partial events.
  if (Number.isInteger(payload.number) &&
      Number.isInteger(pullRequest.number) &&
      payload.number !== pullRequest.number) {
    return jsonResult("error", {
      status: 409,
      error: "GITHUB_PULL_REQUEST_IDENTITY_MISMATCH",
    });
  }
  const prNumber = Number.isInteger(payload.number)
    ? payload.number
    : Number.isInteger(pullRequest.number)
      ? pullRequest.number
      : -1;
  if (prNumber <= 0) {
    return jsonResult("error", {
      status: 400,
      error: "GITHUB_PULL_REQUEST_NUMBER_REQUIRED",
    });
  }

  const workerLabels = readWorkerLabels(pullRequest);
  if (workerLabels.length > 1) {
    return jsonResult("error", {
      status: 409,
      error: "AMBIGUOUS_PR_ASSIGNMENT",
      pullRequest: prNumber,
      labels: workerLabels,
    });
  }
  if (workerLabels.length === 0) {
    return jsonResult("ignore", {
      reason: "UNASSIGNED_PULL_REQUEST",
      pullRequest: prNumber,
    });
  }

  const workerId = workerIdFromLabel(workerLabels[0]);
  if (!workerId) {
    return jsonResult("error", {
      status: 409,
      error: "WORKER_ID_INVALID",
      pullRequest: prNumber,
    });
  }

  if (pullRequest.state !== "open") {
    return jsonResult("ignore", {
      reason: "PULL_REQUEST_NOT_OPEN",
      pullRequest: prNumber,
    });
  }

  const action = typeof payload.action === "string" ? payload.action : "";
  if (!ROUTING_ACTIONS.has(action)) {
    return jsonResult("ignore", {
      reason: "PULL_REQUEST_EVENT_NOT_ROUTING_TRIGGER",
      pullRequest: prNumber,
    });
  }

  const headSha = typeof pullRequest?.head?.sha === "string"
    ? pullRequest.head.sha
    : "";
  if (!SHA.test(headSha)) {
    return jsonResult("error", {
      status: 400,
      error: "GITHUB_PULL_REQUEST_HEAD_INVALID",
    });
  }

  let reason = `github_pull_request_${action}`;
  if (action === "synchronize") {
    const senderLogin =
      typeof payload?.sender?.login === "string"
        ? payload.sender.login
        : "";
    const headRepoFullName =
      typeof pullRequest?.head?.repo?.full_name === "string"
        ? pullRequest.head.repo.full_name
        : "";
    const headRepoOwnerLogin =
      typeof pullRequest?.head?.repo?.owner?.login === "string"
        ? pullRequest.head.repo.owner.login
        : "";
    if (
      senderLogin &&
      headRepoFullName === repository &&
      headRepoOwnerLogin &&
      senderLogin.toLowerCase() === headRepoOwnerLogin.toLowerCase()
    ) {
      reason = "github_pull_request_self_synchronize";
    }
  } else if (action === "labeled") {
    const added = typeof payload?.label?.name === "string" ? payload.label.name : "";
    if (added.toLowerCase() !== workerLabels[0].toLowerCase()) {
      return jsonResult("ignore", {
        reason: "NON_ASSIGNMENT_LABEL_EVENT",
        pullRequest: prNumber,
      });
    }
  } else if (action === "edited") {
    if (repository !== CONTROL_REPOSITORY) {
      return jsonResult("ignore", {
        reason: "RECOVERY_MARKER_CONTROL_REPOSITORY_ONLY",
        pullRequest: prNumber,
      });
    }
    const body = typeof pullRequest.body === "string" ? pullRequest.body : "";
    const priorBody = typeof payload?.changes?.body?.from === "string"
      ? payload.changes.body.from
      : null;
    const recoveryMarker = `<!-- ${CROSS_PR_RECOVERY_MARKER} worker=${workerId} pr=${prNumber} head=${headSha} -->`;
    const continuationPattern = new RegExp(
      `<!-- ${CONTINUATION_MARKER} worker=${workerId} pr=${prNumber} head=${headSha} generation=[a-f0-9]{24} -->`,
    );
    // Ordinary PR body edits are not wake signals. Only explicitly marker-bearing
    // edits enter the strict recovery/continuation validation path.
    if (!body.includes(CONTINUATION_MARKER) && !body.includes(CROSS_PR_RECOVERY_MARKER)) {
      return jsonResult("ignore", {
        reason: "NON_RECOVERY_EDIT_EVENT",
        pullRequest: prNumber,
      });
    }
    if (body.includes(CONTINUATION_MARKER)) {
      if (!continuationPattern.test(body)) {
        return jsonResult("error", {
          status: 409,
          error: "CONTINUATION_MARKER_INVALID",
          pullRequest: prNumber,
        });
      }
      if (priorBody === null || priorBody.includes(CONTINUATION_MARKER)) {
        return jsonResult("ignore", {
          reason: "CONTINUATION_MARKER_NOT_NEW",
          pullRequest: prNumber,
        });
      }
      reason = "github_pull_request_continuation";
    } else {
      if (!body.includes(recoveryMarker)) {
        return jsonResult("error", {
          status: 409,
          error: "CROSS_PR_RECOVERY_MARKER_INVALID",
          pullRequest: prNumber,
        });
      }
      if (priorBody === null || priorBody.includes(CROSS_PR_RECOVERY_MARKER)) {
        return jsonResult("ignore", {
          reason: "CROSS_PR_RECOVERY_MARKER_NOT_NEW",
          pullRequest: prNumber,
        });
      }
      reason = "github_pull_request_cross_pr_recovery";
    }
  }

  const wake = {
    protocol: PROTOCOL,
    type: "wake",
    worker_id: workerId,
    repo: repository,
    pr_number: prNumber,
    expected_head_sha: headSha,
    reason,
    delivery_id: deliveryId,
  };

  return jsonResult("route", { workerId, wake });
}

export function validateWake(value, expectedWorkerId = null) {
  const keys = [
    "protocol",
    "type",
    "worker_id",
    "repo",
    "pr_number",
    "expected_head_sha",
    "reason",
    "delivery_id",
  ];
  if (!exactKeys(value, keys)) return false;
  if (value.protocol !== PROTOCOL || value.type !== "wake") return false;
  if (!isValidWorkerId(value.worker_id)) return false;
  if (expectedWorkerId !== null && value.worker_id !== expectedWorkerId) return false;
  if (!CONTROL_REPOSITORIES.has(value.repo)) return false;
  if (!Number.isInteger(value.pr_number) || value.pr_number <= 0) return false;
  if (typeof value.expected_head_sha !== "string" || !SHA.test(value.expected_head_sha)) {
    return false;
  }
  if (typeof value.reason !== "string" ||
      !/^[a-z0-9._:-]{1,64}$/.test(value.reason)) {
    return false;
  }
  return isValidDeliveryId(value.delivery_id);
}

export function validateRegister(value, expectedWorkerId) {
  if (!exactKeys(value, ["protocol", "type", "worker_id", "session_id"])) return false;
  return value.protocol === PROTOCOL &&
    value.type === "register" &&
    value.worker_id === expectedWorkerId &&
    isValidWorkerId(value.worker_id) &&
    typeof value.session_id === "string" &&
    value.session_id.length >= 1 &&
    value.session_id.length <= 128;
}

export function validateRecoveryRequest(value, expectedWorkerId) {
  if (!exactKeys(value, ["protocol", "type", "worker_id"])) return false;
  return value.protocol === PROTOCOL &&
    value.type === "recover" &&
    value.worker_id === expectedWorkerId &&
    isValidWorkerId(value.worker_id);
}

export function normalizeRecoveryAssignments(issueItems, pullRequests, workerId) {
  if (!Array.isArray(issueItems) || !Array.isArray(pullRequests) || !isValidWorkerId(workerId)) {
    throw new Error("RECOVERY_ASSIGNMENT_PAYLOAD_INVALID");
  }

  const assignedLabel = `${ASSIGNMENT_LABEL_PREFIX}${workerId}`.toLowerCase();
  const issueCandidates = issueItems
    .filter((item) =>
      item &&
      item.pull_request &&
      item.state === "open" &&
      Number.isInteger(Number(item.number)) &&
      Number(item.number) > 0 &&
      Array.isArray(item.labels) &&
      item.labels.some((label) =>
        String(label?.name || "").toLowerCase() === assignedLabel
      )
    )
    .map((item) => Number(item.number));

  const pullByNumber = new Map(
    pullRequests
      .filter((item) => item && Number.isInteger(Number(item.number)))
      .map((item) => [Number(item.number), item])
  );

  return issueCandidates
    .map((number) => {
      const pull = pullByNumber.get(number);
      if (!pull) {
        throw new Error(`RECOVERY_ASSIGNMENT_DETAIL_MISSING:${number}`);
      }
      // A terminal PR is not resurrected, but an unreadable/open assigned PR
      // must not be silently discarded and misclassified as FREE.
      if (pull.state === "closed") return null;
      if (pull.state !== "open") {
        throw new Error(`RECOVERY_ASSIGNMENT_STATE_INVALID:${number}`);
      }
      // GitHub's issue list and per-PR details are separate snapshots.
      // A removed/reassigned worker label must not revive stale ownership.
      const currentWorkerLabels = readWorkerLabels(pull);
      if (currentWorkerLabels.length !== 1 ||
          currentWorkerLabels[0].toLowerCase() !== assignedLabel) {
        throw new Error(`RECOVERY_ASSIGNMENT_LABEL_CHANGED:${number}`);
      }
      const headRef = typeof pull.head?.ref === "string" ? pull.head.ref : "";
      const headSha = typeof pull.head?.sha === "string" ? pull.head.sha : "";
      if (!headRef || !SHA.test(headSha)) {
        throw new Error(`RECOVERY_ASSIGNMENT_HEAD_INVALID:${number}`);
      }
      return { workerId, number, headRef, headSha };
    })
    .filter(Boolean);
}

export function planRecovery(assignments, active, queued = null, archivedCount = 0) {
  if (!Array.isArray(assignments)) throw new Error("RECOVERY_ASSIGNMENTS_INVALID");
  if (!Number.isSafeInteger(archivedCount) || archivedCount < 0 || archivedCount > 64)
    throw new Error("RECOVERY_ARCHIVE_COUNT_INVALID");

  if (assignments.length > 1) {
    return { state: "conflict" };
  }
  if (assignments.length === 0) {
    // A missing GitHub assignment cannot prove a persisted delivery or
    // previously issued ChatGPT prompt was cancelled. Preserve evidence.
    if (active || queued || archivedCount > 0) {
      return {
        state: "unassigned_delivery_preserved",
        activePhase: active?.phase ?? null,
        deliveryId: active?.wake?.delivery_id ?? null,
        queuedDeliveryId: queued?.delivery_id ?? null,
        archivedCount,
      };
    }
    return { state: "waiting_for_assignment" };
  }

  const assignment = assignments[0];
  // PR numbers and even commit SHAs are not globally unique task identities.
  // Recovery reads assignments from the BKE control repo, but the same relay
  // also accepts demo-repo wakes. A foreign active OR queued delivery must
  // not be certified as an assignment to the control repository.
  const otherIdentity = [active?.wake, queued].some(wake =>
    wake && (wake.repo !== CONTROL_REPOSITORY ||
      wake.worker_id !== assignment.workerId));
  // A queued wake from another PR in the SAME repository is also a
  // different task. One worker cannot treat PR #80 as its clean GitHub
  // assignment while silently holding a queued PR #79 for later delivery.
  // Do not mutate either slot or reconstruct work until the owner resolves
  // the second task's assignment and already-issued delivery uncertainty.
  const queuedOtherPr = queued && queued.pr_number !== assignment.number;
  if (otherIdentity || queuedOtherPr) {
    return {
      state: "assignment_identity_requires_owner",
      assignment,
      activePhase: active?.phase ?? null,
      deliveryId: active?.wake?.delivery_id ?? null,
      queuedDeliveryId: queued?.delivery_id ?? null,
      archivedCount,
    };
  }

  const sameActivePr = active?.wake?.repo === CONTROL_REPOSITORY &&
    active?.wake?.worker_id === assignment.workerId &&
    active?.wake?.pr_number === assignment.number;
  const sameActiveHead = sameActivePr &&
    active.wake.expected_head_sha === assignment.headSha;

  // Queued means no delivery was accepted: a reconnect may safely recover
  // the same PR/head. Sent, accepted, and deferred remain in-flight and must
  // never be replayed solely because a reconnect occurred.
  if (sameActiveHead && active.phase !== "queued") {
    return {
      state: "preserved_active_assignment",
      assignment,
      activePhase: active.phase,
      deliveryId: active.wake.delivery_id,
    };
  }

  if (archivedCount > 0 && (!active || active.phase === "queued")) {
    // A queued or empty current slot is not a clean slate after earlier
    // supersession. Recovery must not synthesize a second wake while its
    // prior (possibly sent) historical delivery remains unadjudicated.
    return {
      state: "historical_delivery_requires_owner",
      assignment,
      activePhase: active?.phase ?? null,
      deliveryId: active?.wake?.delivery_id ?? null,
      queuedDeliveryId: queued?.delivery_id ?? null,
      archivedCount,
    };
  }

  if (active && active.phase !== "queued") {
    // Changing the assigned PR or SHA cannot cancel an earlier sent wake.
    // Do not lose its original delivery ID or synthesize another prompt.
    return {
      state: "assignment_drift_requires_owner",
      assignment,
      activePhase: active.phase,
      deliveryId: active.wake.delivery_id,
    };
  }

  const wake = {
    protocol: PROTOCOL,
    type: "wake",
    worker_id: assignment.workerId,
    repo: CONTROL_REPOSITORY,
    pr_number: assignment.number,
    expected_head_sha: assignment.headSha,
    reason: "github_pull_request_reconnect_recovery",
    delivery_id: `recovery-${assignment.workerId}-${assignment.number}-${assignment.headSha}`,
  };

  // A fresh GitHub assignment listing alone is not evidence that an old
  // ChatGPT prompt was never issued. With no persisted wake to resume,
  // recover must never synthesize task authority. The caller may inspect
  // the durable target send fence to report the stronger prior-send reason,
  // but both marked and missing evidence remain negative decisions.
  if (!active && !queued) return {
    state: "recovery_evidence_missing_requires_owner", assignment, wake,
  };
  return {state:"recovered",assignment,wake};
}

export function validateAck(value, expectedWorkerId) {
  if (!exactKeys(value, ["protocol", "type", "worker_id", "delivery_id", "state"])) {
    return false;
  }
  return value.protocol === PROTOCOL &&
    value.type === "ack" &&
    value.worker_id === expectedWorkerId &&
    isValidWorkerId(value.worker_id) &&
    isValidDeliveryId(value.delivery_id) &&
    ACK_STATES.has(value.state);
}

/**
 * Retain the exact wake and last known phase when a normal v1 route replaces
 * a persisted slot. No delivery is cancelled and no new dispatch authority
 * is created. Malformed, duplicate-conflicting or full ledgers fail closed.
 */
export function retainDisplacedWakes(existing, displaced, workerId) {
  const maxEntries = 64;
  const phases = new Set(["queued", "sent", "accepted", "deferred", "recovery_required"]);
  if (!isValidWorkerId(workerId) || !Array.isArray(displaced) ||
      (existing !== undefined && !Array.isArray(existing))) return null;
  const entries = existing === undefined ? [] : existing;
  if (entries.length > maxEntries) return null;
  const result = [];
  const byDeliveryId = new Map();
  // Existing evidence is immutable history, NOT an input that may be
  // silently normalized. Even identical duplicate stored records mean
  // its provenance is ambiguous and require owner reconciliation.
  for (const entry of entries) {
    if (!exactKeys(entry, ["wake", "phase"]) ||
        !phases.has(entry.phase) || !validateWake(entry.wake, workerId))
      return null;
    const id = entry.wake.delivery_id;
    if (byDeliveryId.has(id)) return null;
    const copy = {wake: {...entry.wake}, phase: entry.phase};
    byDeliveryId.set(id, copy);
    result.push(copy);
  }
  // A genuine repeated displacement request may be idempotent only when
  // it matches the single validated historical witness byte-for-byte.
  // This does NOT repair corrupted historical storage.
  for (const entry of displaced) {
    if (!exactKeys(entry, ["wake", "phase"]) ||
        !phases.has(entry.phase) || !validateWake(entry.wake, workerId))
      return null;
    const id = entry.wake.delivery_id;
    const earlier = byDeliveryId.get(id);
    if (earlier) {
      if (JSON.stringify(earlier) !== JSON.stringify(entry)) return null;
      continue;
    }
    if (result.length >= maxEntries) return null;
    const copy = {wake: {...entry.wake}, phase: entry.phase};
    byDeliveryId.set(id, copy);
    result.push(copy);
  }
  return result;
}

/**
 * A bounded, negative-only observation of archival delivery IDs.
 * Empty/malformed/duplicate-conflicting stored history is never treated as
 * proof of a clean recovery state. Does not authorize replay or retirement.
 */
export function inspectSupersessionEvidence(existing, workerId, deliveryId = null) {
  if (!isValidWorkerId(workerId) ||
      (deliveryId !== null && !isValidDeliveryId(deliveryId)))
    return {state: "invalid", count: 0};
  if (existing === undefined) return {state: "none", count: 0};
  if (!Array.isArray(existing)) return {state: "invalid", count: 0};
  const checked = retainDisplacedWakes(existing, [], workerId);
  if (!checked || checked.length !== existing.length)
    return {state: "invalid", count: 0};
  return {
    state: deliveryId !== null &&
      checked.some(item => item.wake.delivery_id === deliveryId) ?
      "archived_replay" : "observed",
    count: checked.length,
  };
}

/** Keep GitHub checkpoints in the validated wake's source repository.
 * Never redirect a demo-repo event into a same-number control-repo PR.
 * The GitHub App installation token remains provider-permission scoped.
 */
export function relayCheckpointIssuePath(wake) {
  if (!validateWake(wake, wake?.worker_id)) return null;
  return `/repos/${wake.repo}/issues/${wake.pr_number}/comments`;
}


// Durable last-observation schema, strictly scoped to the relay's own
// registered-socket admission and ACK transaction. No consumer may interpret
// an ACK as ChatGPT work completion, remote cancellation or owner authority.
const RELAY_OBSERVATION_KEYS = ["schema_version","worker_id","last_registration","last_ack"];
const ACK_OBSERVATION_KEYS = [
  "observed_at_ms","delivery_id","state","repo","pr_number","expected_head_sha",
];
const validObservedTime = value => Number.isSafeInteger(value) && value > 0;
export function validateRelayObservation(record, workerId) {
  if (!isValidWorkerId(workerId) ||
      !exactKeys(record, RELAY_OBSERVATION_KEYS) ||
      record.schema_version !== 1 || record.worker_id !== workerId) return false;
  const registration = record.last_registration;
  if (registration !== null &&
      (!exactKeys(registration, ["observed_at_ms"]) ||
       !validObservedTime(registration.observed_at_ms))) return false;
  const ack = record.last_ack;
  if (ack !== null && (
      !exactKeys(ack, ACK_OBSERVATION_KEYS) ||
      !validObservedTime(ack.observed_at_ms) ||
      !isValidDeliveryId(ack.delivery_id) ||
      !ACK_STATES.has(ack.state) ||
      !CONTROL_REPOSITORIES.has(ack.repo) ||
      !Number.isSafeInteger(ack.pr_number) || ack.pr_number < 1 ||
      typeof ack.expected_head_sha !== "string" ||
      !SHA.test(ack.expected_head_sha))) return false;
  return true;
}

/**
 * Calculate one bounded observational update BEFORE making any storage
 * mutation. Timestamps reflect relay processing, not remote ChatGPT action.
 * The caller must write this record in the SAME DO transaction as admission
 * or the corresponding accepted ACK phase transition/clear.
 */
export function nextRelayObservation(existing, workerId, atMs, kind, ack = null, wake = null) {
  if (!isValidWorkerId(workerId) || !validObservedTime(atMs)) return null;
  const previous = existing === undefined ?
    {schema_version:1, worker_id:workerId, last_registration:null, last_ack:null} : existing;
  if (!validateRelayObservation(previous, workerId)) return null;
  if (kind === "registration") {
    if (ack !== null || wake !== null ||
        (previous.last_registration &&
         atMs < previous.last_registration.observed_at_ms)) return null;
    return {
      schema_version:1,worker_id:workerId,
      last_registration:{observed_at_ms:atMs},
      last_ack:previous.last_ack === null ? null : {...previous.last_ack},
    };
  }
  if (kind !== "ack" || !validateAck(ack,workerId) ||
      !validateWake(wake,workerId) || ack.delivery_id !== wake.delivery_id ||
      (previous.last_ack && atMs < previous.last_ack.observed_at_ms)) return null;
  return {
    schema_version:1,worker_id:workerId,
    last_registration:previous.last_registration === null ? null : {...previous.last_registration},
    last_ack:{
      observed_at_ms:atMs,delivery_id:ack.delivery_id,state:ack.state,
      repo:wake.repo,pr_number:wake.pr_number,
      expected_head_sha:wake.expected_head_sha,
    },
  };
}


/**
 * Classify an ACK that does NOT match the current active wake. A bounded
 * recent-ID cache is not sufficient: an already sent superseded wake can
 * ACK only after its ID was evicted from that cache.
 *
 * Pure, negative-only classification: never marks an ACK accepted,
 * completed, cancelled or authorized. Caller must check current socket
 * authority and retirement keys inside the SAME DO transaction first.
 */
export function classifyUnmatchedRelayAck(recent, archive, workerId, deliveryId, receipt = undefined) {
  if (!isValidWorkerId(workerId) || !isValidDeliveryId(deliveryId) ||
      !Array.isArray(recent) || recent.length > 64 ||
      recent.some(id => !isValidDeliveryId(id)) ||
      ![undefined, true, "ack_observed_completed", "ack_observed_rejected"]
        .includes(receipt)) return "invalid";
  const prior = inspectSupersessionEvidence(archive, workerId, deliveryId);
  if (prior.state === "invalid") return "invalid";
  if (recent.includes(deliveryId)) return "stale_recent";
  if (prior.state === "archived_replay") {
    // A queued-only archive is not proof that a wake was ever sent.
    // Contradictory historical evidence cannot be silently reconciled.
    const entry = archive.find(item => item.wake.delivery_id === deliveryId);
    return entry.phase === "queued" ? "unknown" : "stale_archived";
  }
  // The boolean dispatch receipt may describe a suppressed or queued wake;
  // only a terminal ACK recorded under active same-DO socket authority is
  // sufficient to disregard a duplicate late terminal observation.
  if (receipt === "ack_observed_completed" || receipt === "ack_observed_rejected")
    return "stale_terminal";
  return "unknown";
}


/**
 * Durable, non-authoritative evidence that a PR/head wake was reserved for
 * WebSocket send at least once. Only automatic reconnect recovery consults
 * this; a new signed GitHub event still follows normal dispatch policy.
 * Keyed within one worker's own DO and fully scoped to PR + exact head.
 */
export function recoverySendFenceKey(wake) {
  if (!validateWake(wake, wake?.worker_id)) return null;
  return `recovery_target_sent_v1:${wake.worker_id}:${wake.repo}:${wake.pr_number}:${wake.expected_head_sha}`;
}


/**
 * These two helpers are the real WorkerSession send/recover transaction
 * seams. Callers must execute them inside the SAME DO storage transaction
 * that also changes active_wake; a returned marker never proves remote
 * ChatGPT receipt, completion, or cancellation.
 */
export async function persistRecoverySendAttempt(tx, wake) {
  const key = recoverySendFenceKey(wake);
  if (!key || !tx || typeof tx.put !== "function")
    throw new Error("RECOVERY_SEND_FENCE_INVALID");
  await tx.put(key, true);
}

export async function inspectRecoverySendAttempt(tx, wake, hasPersistedWake) {
  const key = recoverySendFenceKey(wake);
  if (!key || !tx || typeof tx.get !== "function" ||
      typeof hasPersistedWake !== "boolean")
    return "invalid";
  const value = await tx.get(key); // storage uncertainty MUST propagate
  if (value !== undefined) return "previously_sent";
  return hasPersistedWake ? "resume_persisted_wake" : "missing_evidence";
}


/**
 * Negative-only history scan for a worker with no currently assigned PR or
 * pending wake. No absence result grants retirement or credential release.
 * Read only a bounded single key under each transport-evidence prefix.
 */
export async function inspectUnassignedRelayHistory(tx) {
  if (!tx || typeof tx.get !== "function" || typeof tx.list !== "function")
    return "unknown";
  const recent = await tx.get("recent_deliveries");
  if (recent !== undefined) {
    if (!Array.isArray(recent) || recent.length > 64 ||
        recent.some(id => !isValidDeliveryId(id))) return "unknown";
    if (recent.length > 0) return "observed";
  }
  // This is intentionally conservative: a past socket or relay observation
  // is NOT proof of a ChatGPT turn, but is also not proof of cancellation.
  if (await tx.get("relay_observation_v1") !== undefined) return "observed";
  if (await tx.get("active_connection_id") !== undefined) return "observed";
  for (const prefix of ["recovery_target_sent_v1:", "durable_delivery_v1:"]) {
    const rows = await tx.list({prefix, limit:1});
    if (!(rows instanceof Map) || rows.size > 1 ||
        [...rows.keys()].some(k => typeof k !== "string" || !k.startsWith(prefix)))
      return "unknown";
    if (rows.size > 0) return "observed";
  }
  return "not_observed";
}
