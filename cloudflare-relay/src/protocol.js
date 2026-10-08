export const PROTOCOL = 1;
export const CONTROL_REPOSITORY = "jan2xo/bke-worker";
export const CONTROL_REPOSITORIES = new Set([
  CONTROL_REPOSITORY,
  "jan2xo/bke-demo-app",
]);
export const ASSIGNMENT_LABEL_PREFIX = "bke-worker:";
export const CROSS_PR_RECOVERY_MARKER = "BKE-RECOVER-CROSS-PR-WAKE";
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
    const marker = `<!-- ${CROSS_PR_RECOVERY_MARKER} worker=${workerId} pr=${prNumber} head=${headSha} -->`;
    if (!body.includes(CROSS_PR_RECOVERY_MARKER)) {
      return jsonResult("ignore", {
        reason: "NON_RECOVERY_EDIT_EVENT",
        pullRequest: prNumber,
      });
    }
    if (!body.includes(marker)) {
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
      if (!pull || pull.state !== "open") return null;
      const headRef = typeof pull.head?.ref === "string" ? pull.head.ref : "";
      const headSha = typeof pull.head?.sha === "string" ? pull.head.sha : "";
      if (!headRef || !SHA.test(headSha)) return null;
      return { workerId, number, headRef, headSha };
    })
    .filter(Boolean);
}

export function planRecovery(assignments, active) {
  if (!Array.isArray(assignments)) throw new Error("RECOVERY_ASSIGNMENTS_INVALID");

  if (assignments.length > 1) {
    return { state: "conflict" };
  }
  if (assignments.length === 0) {
    return { state: "waiting_for_assignment" };
  }

  const assignment = assignments[0];
  const sameActivePr = active?.wake?.pr_number === assignment.number;
  const sameActiveHead = sameActivePr &&
    active.wake.expected_head_sha === assignment.headSha;

  if (sameActiveHead) {
    return {
      state: "preserved_active_assignment",
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

  if (active && sameActivePr && active.phase !== "queued") {
    return {
      state: "head_converged_without_redelivery",
      assignment,
      wake,
    };
  }

  return {
    state: "recovered",
    assignment,
    wake,
  };
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
