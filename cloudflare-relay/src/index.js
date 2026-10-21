import { DurableObject, WorkerEntrypoint } from "cloudflare:workers";
import { inspectSameDurableObjectCandidate } from "./relay-owner-same-do-inspection.js";
import { mustStopWorkerRoute, QUARANTINE_DENIAL_CODE } from "./relay-runtime-quarantine-interlock.js";
import { fulfillCommandCenterAdminRead, fulfillCommandCenterAdminCatalog, fulfillCommandCenterAdminAssignments } from "./admin-broker.js";
import {
  mintInstallationToken,
  verifyActionsOidcToken,
} from "./github-app.js";
import {
  CONTROL_REPOSITORY,
  normalizeRecoveryAssignments,
  retainDisplacedWakes,
  inspectSupersessionEvidence,
  classifyUnmatchedRelayAck,
  MAX_WEBHOOK_BYTES,
  relayBearerMatches,
  isValidWorkerId,
  routeGitHubPullRequest,
  relayCheckpointIssuePath,
  nextRelayObservation,
  validateAck,
  validateRegister,
  validateRecoveryRequest,
  validateWake,
  verifyGitHubSignature,
} from "./protocol.js";

const RECENT_DELIVERY_LIMIT = 64;
const ACTIVE_WAKE_KEY = "active_wake";
const QUEUED_WAKE_KEY = "queued_wake";
const RECENT_DELIVERIES_KEY = "recent_deliveries";
const SUPERSESSION_EVIDENCE_KEY = "supersession_evidence_v1";
const RELAY_OBSERVATION_KEY = "relay_observation_v1";
const WORKER_ID_KEY = "worker_id";
const ACTIVE_CONNECTION_KEY = "active_connection_id";
const RETIREMENT_FENCE_KEY = "retirement_fence_v1";
const RETIREMENT_EPOCH_KEY = "retirement_epoch_v1";
const SESSION_OBJECT_GENERATION = "v2";

function workerSessionObjectId(env, workerId) {
  return env.WORKER_SESSIONS.idFromName(`${SESSION_OBJECT_GENERATION}:${workerId}`);
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
    },
  });
}

async function preserveDisplacedWakes(tx, workerId, entries) {
  if (entries.length === 0) return true;
  const prior = await tx.get(SUPERSESSION_EVIDENCE_KEY);
  const next = retainDisplacedWakes(prior, entries, workerId);
  if (!next) return false;
  await tx.put(SUPERSESSION_EVIDENCE_KEY, next);
  return true;
}

function parseJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

async function postRelayCheckpoint(env, wake, relayState) {
  // GitHub assignment and checkpoint identity are repository-qualified.
  // A demo PR number must never write into a same-number control PR.
  const path = relayCheckpointIssuePath(wake);
  if (!path) return;
  try {
    const minted = await mintInstallationToken(env);
    const body = [
      "BKE RELAY — " + relayState,
      "worker=" + wake.worker_id,
      "delivery=" + wake.delivery_id,
      "head=" + wake.expected_head_sha,
    ].join(" • ");

    await fetch(
      `https://api.github.com${path}`,
      {
        method: "POST",
        headers: {
          "accept": "application/vnd.github+json",
          "authorization": `Bearer ${minted.token}`,
          "content-type": "application/json",
          "user-agent": "bke-worker-relay",
          "x-github-api-version": "2022-11-28",
        },
        body: JSON.stringify({ body }),
      },
    );
  } catch {
    // Transport must not fail because observability is temporarily unavailable.
  }
}

function relayPathWorkerId(pathname) {
  const prefix = "/relay/";
  if (!pathname.startsWith(prefix)) return null;
  const remainder = pathname.slice(prefix.length);
  if (!remainder || remainder.includes("/")) return null;
  try {
    return decodeURIComponent(remainder);
  } catch {
    return null;
  }
}

async function handleGitHubWebhook(request, env) {
  const secret = env.BKE_WORKER_GITHUB_WEBHOOK_SECRET;
  if (!secret) return json({ error: "WEBHOOK_SECRET_UNCONFIGURED" }, 503);

  const deliveryId = request.headers.get("X-GitHub-Delivery") || "";
  const signature = request.headers.get("X-Hub-Signature-256") || "";
  const eventName = request.headers.get("X-GitHub-Event") || "";
  const contentLength = Number(request.headers.get("Content-Length") || "0");
  if (Number.isFinite(contentLength) && contentLength > MAX_WEBHOOK_BYTES) {
    return json({ error: "GITHUB_PAYLOAD_TOO_LARGE" }, 413);
  }

  const buffer = new Uint8Array(await request.arrayBuffer());
  if (buffer.byteLength > MAX_WEBHOOK_BYTES) {
    return json({ error: "GITHUB_PAYLOAD_TOO_LARGE" }, 413);
  }

  if (!(await verifyGitHubSignature(buffer, signature, secret))) {
    return json({ error: "GITHUB_SIGNATURE_INVALID" }, 401);
  }

  if (eventName === "ping") {
    return json({ accepted: true, reason: "PING", repo: CONTROL_REPOSITORY }, 200);
  }

  if (eventName !== "pull_request") {
    return json({ accepted: false, reason: "IGNORED_EVENT" }, 202);
  }

  const payload = parseJson(new TextDecoder().decode(buffer));
  if (payload === null) {
    return json({ error: "GITHUB_PAYLOAD_INVALID" }, 400);
  }

  const routing = routeGitHubPullRequest(payload, deliveryId);
  if (routing.kind === "error") {
    return json(
      {
        error: routing.error,
        pull_request: routing.pullRequest,
        labels: routing.labels,
      },
      routing.status,
    );
  }
  if (routing.kind === "ignore") {
    return json(
      {
        accepted: false,
        delivery: deliveryId,
        reason: routing.reason,
        pull_request: routing.pullRequest,
      },
      202,
    );
  }

  const objectId = workerSessionObjectId(env, routing.workerId);
  const stub = env.WORKER_SESSIONS.get(objectId);
  const response = await stub.fetch("https://worker-session.internal/dispatch", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-bke-worker-id": routing.workerId,
    },
    body: JSON.stringify(routing.wake),
  });

  const durableResult = await response.json();
  await postRelayCheckpoint(
    env,
    routing.wake,
    String(durableResult?.state || durableResult?.error || "unknown"),
  );
  return json(
    {
      accepted: response.ok,
      delivery: deliveryId,
      worker_id: routing.workerId,
      pull_request: routing.wake.pr_number,
      relay: durableResult,
    },
    response.status,
  );
}

async function handleGitHubAppInstallToken(request, env) {
  const authorization = request.headers.get("Authorization") || "";
  const match = /^Bearer\s+(.+)$/iu.exec(authorization);
  if (!match) return json({ error: "ACTIONS_OIDC_REQUIRED" }, 401);

  try {
    await verifyActionsOidcToken(match[1]);
    const minted = await mintInstallationToken(env);
    return json(minted, 200);
  } catch (error) {
    const code = error instanceof Error ? error.message : "GITHUB_APP_BROKER_FAILED";
    const status = code.startsWith("OIDC_") ? 401 :
      code.endsWith("_UNCONFIGURED") ? 503 :
      502;
    return json({ error: code }, status);
  }
}

async function recoverAssignedPullRequests(env, workerId) {
  const minted = await mintInstallationToken(env);
  const label = encodeURIComponent(`bke-worker:${workerId}`);
  const response = await fetch(
    `https://api.github.com/repos/${CONTROL_REPOSITORY}/issues?state=open&labels=${label}&per_page=100`,
    {
      headers: {
        accept: "application/vnd.github+json",
        authorization: `Bearer ${minted.token}`,
        "user-agent": "bke-worker-relay",
        "x-github-api-version": "2026-03-10",
      },
    },
  );
  const issuePayload = await response.json().catch(() => null);
  if (!response.ok || !Array.isArray(issuePayload)) {
    throw new Error(`GITHUB_ASSIGNMENT_RECOVERY_FAILED:${response.status}`);
  }
  // An exactly full first page might omit further assigned PRs. Never
  // classify a truncated view as FREE or as a unique assignment.
  if (issuePayload.length >= 100) {
    throw new Error("GITHUB_ASSIGNMENT_RECOVERY_PAGE_AMBIGUOUS");
  }

  const candidateNumbers = issuePayload
    .filter((item) => item?.pull_request && item.state === "open")
    .map((item) => Number(item.number))
    .filter((number) => Number.isInteger(number) && number > 0);

  const pullRequests = [];
  for (const number of candidateNumbers) {
    const pullResponse = await fetch(
      `https://api.github.com/repos/${CONTROL_REPOSITORY}/pulls/${number}`,
      {
        headers: {
          accept: "application/vnd.github+json",
          authorization: `Bearer ${minted.token}`,
          "user-agent": "bke-worker-relay",
          "x-github-api-version": "2026-03-10",
        },
      },
    );
    const pullPayload = await pullResponse.json().catch(() => null);
    if (!pullResponse.ok || !pullPayload || typeof pullPayload !== "object" || Array.isArray(pullPayload)) {
      // Missing details are not evidence that a GitHub-assigned PR vanished.
      // Abort reconstruction rather than silently reducing 1+ owners to zero.
      throw new Error(`GITHUB_ASSIGNMENT_DETAIL_FAILED:${number}:${pullResponse.status}`);
    }
    pullRequests.push(pullPayload);
  }

  return normalizeRecoveryAssignments(issuePayload, pullRequests, workerId);
}

async function handleRelayRecovery(request, env, workerId) {
  if (!isValidWorkerId(workerId)) {
    return json({ error: "WORKER_ID_INVALID" }, 400);
  }
  const relayToken = env.BKE_WORKER_RELAY_TOKEN_KEY;
  if (!relayToken) return json({ error: "RELAY_TOKEN_UNCONFIGURED" }, 503);
  if (!(await relayBearerMatches(request.headers.get("Authorization") || "", relayToken, workerId))) {
    return json({ error: "RELAY_UNAUTHORIZED" }, 401);
  }
  const objectId = workerSessionObjectId(env, workerId);
  const stub = env.WORKER_SESSIONS.get(objectId);
  const response = await stub.fetch("https://worker-session.internal/recover", {
    method: "POST",
    headers: { "content-type": "application/json", "x-bke-worker-id": workerId },
    body: JSON.stringify({ worker_id: workerId }),
  });
  return new Response(await response.text(), {
    status: response.status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
  });
}

async function handleRelayUpgrade(request, env, workerId) {
  if (!isValidWorkerId(workerId)) {
    return json({ error: "WORKER_ID_INVALID" }, 400);
  }
  const relayToken = env.BKE_WORKER_RELAY_TOKEN_KEY;
  if (!relayToken) return json({ error: "RELAY_TOKEN_UNCONFIGURED" }, 503);
  if (!(await relayBearerMatches(request.headers.get("Authorization") || "", relayToken, workerId))) {
    return json({ error: "RELAY_UNAUTHORIZED" }, 401);
  }
  if ((request.headers.get("Upgrade") || "").toLowerCase() !== "websocket") {
    return json({ error: "WEBSOCKET_UPGRADE_REQUIRED" }, 426);
  }

  const objectId = workerSessionObjectId(env, workerId);
  const stub = env.WORKER_SESSIONS.get(objectId);
  const headers = new Headers(request.headers);
  headers.set("x-bke-worker-id", workerId);

  return stub.fetch(new Request("https://worker-session.internal/connect", {
    method: "GET",
    headers,
  }));
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname === "/webhooks/github") {
      if (request.method !== "POST") {
        return json({ error: "METHOD_NOT_ALLOWED" }, 405);
      }
      return handleGitHubWebhook(request, env);
    }

    if (url.pathname === "/github/app/install-token") {
      if (request.method !== "POST") {
        return json({ error: "METHOD_NOT_ALLOWED" }, 405);
      }
      return handleGitHubAppInstallToken(request, env);
    }

    const workerId = relayPathWorkerId(url.pathname);
    if (workerId !== null) {
      if (url.pathname.endsWith("/recover")) {
        return json({ error: "RECOVERY_PATH_INVALID" }, 400);
      }
      if (request.method !== "GET") {
        return json({ error: "METHOD_NOT_ALLOWED" }, 405);
      }
      return handleRelayUpgrade(request, env, workerId);
    }

    const recoveryMatch = /^\/relay\/([^/]+)\/recover$/u.exec(url.pathname);
    if (recoveryMatch) {
      const workerIdForRecovery = decodeURIComponent(recoveryMatch[1]);
      if (request.method !== "POST") {
        return json({ error: "METHOD_NOT_ALLOWED" }, 405);
      }
      return handleRelayRecovery(request, env, workerIdForRecovery);
    }

    return json({ error: "NOT_FOUND" }, 404);
  },
};

// This is NOT an HTTP route. Only an account-authorized named Cloudflare
// Service binding can invoke this narrow capability. Public fetch remains
// unchanged and has no endpoint that returns a GitHub Admin read token.
export class CommandCenterReadBroker extends WorkerEntrypoint {
  async mintReadOnlyGitHubToken(request) {
    return fulfillCommandCenterAdminRead(this.env, request);
  }
  async listApprovedGitHubRepositories(request) {
    return fulfillCommandCenterAdminCatalog(this.env, request);
  }
  async listVerifiedWorkerAssignments(request) {
    return fulfillCommandCenterAdminAssignments(this.env, request);
  }
}

export class WorkerSession extends DurableObject {
  // G0-06: PRIVATE WorkerSession RPC candidate, not an HTTP/WSS route.
  // No Wrangler G0 inspection flag/key is provisioned. Remains fail-closed
  // until the human-verified CC issuer and scoped private binding are audited.
  // Method never grants retirement, cancellation, label or read authority.
  async inspectRetirementCandidate(command) {
    return inspectSameDurableObjectCandidate({
      env: this.env,
      command,
      storage: this.ctx.storage,
      getWebSockets: () => this.ctx.getWebSockets(),
    });
  }

  // A deployment-owner-controlled, default-OFF stop for old worker identity.
  quarantined(workerId) {
    return mustStopWorkerRoute(this.env, workerId);
  }

  // A durable marker cannot become a route ALLOW after an env toggle.
  // Every deployed version that may coexist with a retirement transaction
  // must read the same two keys; a malformed/partial marker or storage outage
  // means STOP. This is negative enforcement, NEVER owner authorization.
  async persistentlyRetired() {
    try {
      const fence = await this.ctx.storage.get(RETIREMENT_FENCE_KEY);
      const epoch = await this.ctx.storage.get(RETIREMENT_EPOCH_KEY);
      return fence !== undefined || epoch !== undefined;
    } catch {
      return true;
    }
  }

  // An on-switch check against only a wake payload or socket attachment is
  // insufficient: the actual DO might persist a DIFFERENT worker identity.
  // Preserve all existing default-OFF v1 behavior and IO. With quarantine
  // explicitly enabled, fail closed when the stored identity cannot be read,
  // when it is ambiguous, or when it disagrees with the candidate identity.
  async quarantinedBoundWorker(workerId) {
    if (this.quarantined(workerId)) return true;
    let enabled;
    try {
      enabled = this.env?.BKE_G0_RUNTIME_QUARANTINE_ENABLED;
    } catch {
      return true;
    }
    if (enabled !== "true") return false;
    try {
      const persisted = await this.ctx.storage.get(WORKER_ID_KEY);
      if (persisted !== workerId || this.quarantined(persisted)) return true;
      // Persisted retirement is stronger than a deployment-only env flag.
      // Even one half of a fence/epoch pair means an uncertain quarantine:
      // never infer permission from a malformed or partially written fence.
      const fence = await this.ctx.storage.get("retirement_fence_v1");
      const epoch = await this.ctx.storage.get("retirement_epoch_v1");
      return fence !== undefined || epoch !== undefined;
    } catch {
      return true;
    }
  }

  async fetch(request) {
    const workerId = request.headers.get("x-bke-worker-id") || "";
    if (this.quarantined(workerId) || await this.persistentlyRetired())
      return json({ error: QUARANTINE_DENIAL_CODE }, 423);
    if (!isValidWorkerId(workerId)) {
      return json({ error: "WORKER_ID_INVALID" }, 400);
    }
    if (!(await this.ensureIdentity(workerId))) {
      return json({ error: "WORKER_ID_CONFLICT" }, 409);
    }

    const url = new URL(request.url);
    if (url.pathname === "/connect") {
      return this.connect(request, workerId);
    }
    if (url.pathname === "/dispatch") {
      return this.dispatch(request, workerId);
    }
    if (url.pathname === "/recover") {
      return this.recover(request, workerId);
    }
    return json({ error: "NOT_FOUND" }, 404);
  }

  async ensureIdentity(workerId) {
    // First-write identity admission must share the SAME transactional
    // snapshot as a future durable retirement fence. A separate read of
    // fence/epoch followed by put(worker_id) could resurrect a worker
    // after the retirement transaction committed in between.
    if (!isValidWorkerId(workerId) || this.quarantined(workerId)) return false;
    try {
      return await this.ctx.storage.transaction(async tx => {
        const fence = await tx.get(RETIREMENT_FENCE_KEY);
        const epoch = await tx.get(RETIREMENT_EPOCH_KEY);
        if (fence !== undefined || epoch !== undefined ||
            this.quarantined(workerId)) return false;
        const existing = await tx.get(WORKER_ID_KEY);
        if (existing !== undefined) return existing === workerId;
        await tx.put(WORKER_ID_KEY, workerId);
        return true;
      });
    } catch {
      // Transaction may have committed before an exception: never infer
      // permission to proceed or automatically retry identity creation.
      return false;
    }
  }

  async connect(request, workerId) {
    if (this.quarantined(workerId) || await this.persistentlyRetired())
      return json({ error: QUARANTINE_DENIAL_CODE }, 423);
    const token = this.env.BKE_WORKER_RELAY_TOKEN_KEY;
    if (!token || !(await relayBearerMatches(request.headers.get("Authorization") || "", token, workerId))) {
      return json({ error: "RELAY_UNAUTHORIZED" }, 401);
    }
    if ((request.headers.get("Upgrade") || "").toLowerCase() !== "websocket") {
      return json({ error: "WEBSOCKET_UPGRADE_REQUIRED" }, 426);
    }
    // Bearer verification is asynchronous; recheck identity from THIS DO.
    if (this.quarantined(workerId) || await this.persistentlyRetired() ||
        (this.env?.BKE_G0_RUNTIME_QUARANTINE_ENABLED === "true" &&
         await this.quarantinedBoundWorker(workerId)))
      return json({ error: QUARANTINE_DENIAL_CODE }, 423);

    const pair = new WebSocketPair();
    const client = pair[0];
    const server = pair[1];

    const connectionId = crypto.randomUUID();
    this.ctx.acceptWebSocket(server);
    server.serializeAttachment({
      workerId,
      connectionId,
      registered: false,
      sessionId: null,
    });

    return new Response(null, {
      status: 101,
      webSocket: client,
    });
  }

  async dispatch(request, workerId) {
    if (this.quarantined(workerId) || await this.persistentlyRetired())
      return json({ error: QUARANTINE_DENIAL_CODE }, 423);
    const wake = parseJson(await request.text());
    if (!validateWake(wake, workerId)) {
      return json({ error: "WAKE_INVALID" }, 400);
    }

    // A dispatch must not record a new delivery ID and then mutate wake
    // state from independent stale reads. This *short*, local DO transaction
    // shares the marker keys with the future authenticated retirement CAS.
    // No socket sends or external GitHub/network I/O happen in the tx.
    let decision;
    try {
      decision = await this.ctx.storage.transaction(async tx => {
        const fence = await tx.get(RETIREMENT_FENCE_KEY);
        const epoch = await tx.get(RETIREMENT_EPOCH_KEY);
        const persistedWorker = await tx.get(WORKER_ID_KEY);
        if (fence !== undefined || epoch !== undefined ||
            persistedWorker !== workerId || this.quarantined(workerId)) {
          return { status: 423, body: {error: QUARANTINE_DENIAL_CODE} };
        }

        const recent = (await tx.get(RECENT_DELIVERIES_KEY)) || [];
        const active = await tx.get(ACTIVE_WAKE_KEY);
        const queued = await tx.get(QUEUED_WAKE_KEY);
        const evidence = inspectSupersessionEvidence(
          await tx.get(SUPERSESSION_EVIDENCE_KEY), workerId, wake.delivery_id,
        );
        if (evidence.state === "invalid" ||
            (queued !== undefined && !validateWake(queued, workerId)) ||
            !Array.isArray(recent) ||
            recent.length > RECENT_DELIVERY_LIMIT ||
            recent.some(id => typeof id !== "string") ||
            (active !== undefined && (!active || !active.wake ||
              !validateWake(active.wake, workerId) ||
              !["queued","sent","accepted","deferred","recovery_required"]
                .includes(active.phase)))) {
          return { status: 423, body: {error: QUARANTINE_DENIAL_CODE} };
        }
        // GitHub PR numbers are repository-local identities. An in-flight
        // control-repo PR #13 is NOT demo-repo PR #13. In particular,
        // "synchronize", "labeled", and same-number queued coalescing
        // must not silently cross repos in this shared WorkerSession DO.
        // Reject without modifying recent-delivery IDs, archive or slots.
        // An explicit future cross-repository handoff needs verified owner
        // authority, never just a signed per-repo webhook.
        if ((active && active.wake.repo !== wake.repo) ||
            (queued && queued.repo !== wake.repo)) {
          return {status: 409, body: {
            error: "WORKER_REPOSITORY_ASSIGNMENT_CONFLICT",
            active_repo: active?.wake?.repo ?? null,
            queued_repo: queued?.repo ?? null,
            incoming_repo: wake.repo,
          }};
        }

        // The 64-item recent-delivery cache is NOT a permanent replay
        // barrier. Previously superseded delivery IDs must never become
        // eligible again when that cache rolls over.
        // A still-recent duplicate is already idempotent and must retain
        // the original v1 200 acknowledgment. No socket send occurs here.
        // Only when recent rolls over does archived evidence become the
        // durable replay-denial boundary.
        if (recent.includes(wake.delivery_id)) {
          return {status: 200, body: {
            state: "duplicate", delivery_id: wake.delivery_id,
          }};
        }
        if (evidence.state === "archived_replay")
          return {status: 409, body: {
            error: "ARCHIVED_DELIVERY_REPLAY_REQUIRES_OWNER",
          }};
        if (active?.wake?.delivery_id === wake.delivery_id ||
            queued?.delivery_id === wake.delivery_id)
          return {status: 409, body: {
            error: "PERSISTED_DELIVERY_REPLAY_REQUIRES_OWNER",
          }};

        const crossPrRecovery = active &&
          active.wake.pr_number !== wake.pr_number &&
          wake.reason === "github_pull_request_cross_pr_recovery";
        const continuationWake = wake.reason === "github_pull_request_continuation";
        if (active && active.wake.pr_number !== wake.pr_number && !crossPrRecovery) {
          return {status: 409, body: {
            error: "WORKER_WAKE_IN_FLIGHT",
            active_pr: active.wake.pr_number,
            incoming_pr: wake.pr_number,
          }};
        }
        if (!active && wake.reason === "github_pull_request_cross_pr_recovery") {
          return {status: 409, body: {error: "CROSS_PR_RECOVERY_NOT_REQUIRED"}};
        }

        const samePrActive = active && active.wake.pr_number === wake.pr_number;
        const selfSynchronizeSuppression = samePrActive && active.phase !== "queued" &&
          active.wake.expected_head_sha !== wake.expected_head_sha &&
          wake.reason === "github_pull_request_self_synchronize";
        const recentNext = recent.filter(id => id !== wake.delivery_id)
          .concat(wake.delivery_id).slice(-RECENT_DELIVERY_LIMIT);
        if (selfSynchronizeSuppression) {
          await tx.put(RECENT_DELIVERIES_KEY, recentNext);
          return {status: 202, body: {
            state: "self_synchronize_suppressed",
            delivery_id: wake.delivery_id,
            active_delivery_id: active.wake.delivery_id,
          }};
        }

        if (continuationWake && active && active.phase !== "queued") {
          await tx.put(RECENT_DELIVERIES_KEY, recentNext);
          return {status: 202, body: {
            state: "continuation_blocked_uncertain",
            delivery_id: wake.delivery_id,
            active_delivery_id: active.wake.delivery_id,
          }};
        }

        const supersedesStaleHead = samePrActive &&
          active.wake.expected_head_sha !== wake.expected_head_sha &&
          wake.reason === "github_pull_request_synchronize";
        const explicitReassignmentRecovery = samePrActive &&
          wake.reason === "github_pull_request_labeled";

        const supersedesAmbiguousWake =
          supersedesStaleHead || explicitReassignmentRecovery;
        if (crossPrRecovery || supersedesAmbiguousWake) {
          const oldQueued = await tx.get(QUEUED_WAKE_KEY);
          if (!(await preserveDisplacedWakes(tx, workerId, [
            {wake: active.wake, phase: active.phase},
            ...(oldQueued === undefined ? [] : [{wake: oldQueued, phase: "queued"}]),
          ]))) return {status: 409, body: {error: "SUPERSESSION_EVIDENCE_CONFLICT"}};
          await tx.put(RECENT_DELIVERIES_KEY, recentNext);
          await tx.delete(QUEUED_WAKE_KEY);
          await tx.put(ACTIVE_WAKE_KEY, {wake, phase: "queued"});
          const statePrefix = explicitReassignmentRecovery ? "recovered" : "superseded";
          return {status: 202, sendDeliveryId: wake.delivery_id,
            sentState: crossPrRecovery ? "cross_pr_recovered_sent" : statePrefix + "_sent",
            queuedState: crossPrRecovery ? "cross_pr_recovered_queued" : statePrefix + "_queued",
            body: {delivery_id: wake.delivery_id,
              ...(crossPrRecovery ? {superseded_pr: active.wake.pr_number} : {}),
              superseded_delivery_id: active.wake.delivery_id,
            }};
        }
        if (active?.phase === "queued") {
          if (!(await preserveDisplacedWakes(tx, workerId, [
            {wake: active.wake, phase: "queued"},
          ]))) return {status: 409, body: {error: "SUPERSESSION_EVIDENCE_CONFLICT"}};
          await tx.put(RECENT_DELIVERIES_KEY, recentNext);
          await tx.put(ACTIVE_WAKE_KEY, {wake, phase: "queued"});
          return {status: 202, body: {
            state: "coalesced_queued", delivery_id: wake.delivery_id,
          }};
        }
        // A completed ACK clears active before promoteQueuedWake() runs.
        // Do not overtake the older queued delivery in this window.
        if (!active && queued) {
          return {status: 409, body: {
            error: "QUEUED_DELIVERY_PENDING_PROMOTION",
            queued_delivery_id: queued.delivery_id,
            queued_pr: queued.pr_number,
            incoming_pr: wake.pr_number,
          }};
        }
        if (!active) {
          await tx.put(RECENT_DELIVERIES_KEY, recentNext);
          await tx.put(ACTIVE_WAKE_KEY, {wake, phase: "queued"});
          return {status: 202, sendDeliveryId: wake.delivery_id,
            sentState: "sent", queuedState: "queued",
            body: {delivery_id: wake.delivery_id}};
        }

        const oldQueued = await tx.get(QUEUED_WAKE_KEY);
        if (oldQueued !== undefined &&
            !(await preserveDisplacedWakes(tx, workerId, [
              {wake: oldQueued, phase: "queued"},
            ]))) return {status: 409, body: {error: "SUPERSESSION_EVIDENCE_CONFLICT"}};
        await tx.put(RECENT_DELIVERIES_KEY, recentNext);
        await tx.put(QUEUED_WAKE_KEY, wake);
        return {status: 202, body: {
          state: "queued_behind_active", delivery_id: wake.delivery_id,
          active_delivery_id: active.wake.delivery_id,
        }};
      });
    } catch {
      // A commit can happen before the adapter reports failure.
      // Never auto-retry a dispatch after uncertain transaction outcome.
      return json({error: "DISPATCH_OUTCOME_UNCERTAIN"}, 503);
    }
    if (!decision || !Number.isInteger(decision.status) ||
        !decision.body || typeof decision.body !== "object") {
      return json({error: "DISPATCH_OUTCOME_UNCERTAIN"}, 503);
    }
    if (decision.sendDeliveryId) {
      const outcome = await this.sendActiveIfSafeOutcome(decision.sendDeliveryId);
      return json({
        state: outcome === "uncertain" ? "delivery_outcome_uncertain" :
          outcome === "sent" ? decision.sentState : decision.queuedState,
        ...decision.body,
      }, decision.status);
    }
    return json(decision.body, decision.status);
  }

  async recover(request, workerId) {
    if (this.quarantined(workerId) || await this.persistentlyRetired())
      return json({ error: QUARANTINE_DENIAL_CODE }, 423);
    const value = parseJson(await request.text());
    if (!validateRecoveryRequest(value, workerId)) {
      return json({ error: "RECOVERY_REQUEST_INVALID" }, 400);
    }

    let assignments;
    try {
      assignments = await recoverAssignedPullRequests(this.env, workerId);
    } catch (error) {
      return json({
        error: error instanceof Error ? error.message : "GITHUB_ASSIGNMENT_RECOVERY_FAILED",
      }, 502);
    }
    // GitHub preflight may be slow; never resume after a durable retirement.
    if (this.quarantined(workerId) || await this.persistentlyRetired() ||
        (this.env?.BKE_G0_RUNTIME_QUARANTINE_ENABLED === "true" &&
         await this.quarantinedBoundWorker(workerId)))
      return json({ error: QUARANTINE_DENIAL_CODE }, 423);

    if (assignments.length > 1) {
      const checkpointPr = assignments[0]?.number;
      if (checkpointPr) {
        try {
          const minted = await mintInstallationToken(this.env);
          await fetch(
            `https://api.github.com/repos/${CONTROL_REPOSITORY}/issues/${checkpointPr}/comments`,
            {
              method: "POST",
              headers: {
                accept: "application/vnd.github+json",
                authorization: `Bearer ${minted.token}`,
                "content-type": "application/json",
                "user-agent": "bke-worker-relay",
                "x-github-api-version": "2026-03-10",
              },
              body: JSON.stringify({
                body: `BKE RECOVERY CONFLICT — worker=${workerId}; open assigned PRs=${assignments.map((item) => "#" + item.number).join(", ")}. Worker remains fail-closed; no PR selected heuristically.`,
              }),
            },
          );
        } catch {
          // Conflict remains fail-closed even if the durable checkpoint cannot be written.
        }
      }
      return json({
        state: "conflict",
        worker_id: workerId,
        assignments: assignments.map(({ number, headRef, headSha }) => ({ number, headRef, headSha })),
      }, 409);
    }

    // GitHub recovery preflight is intentionally OUTSIDE the storage tx.
    // Re-read the same DO state and both retirement markers inside the tx
    // before any cleanup/reconstruction write. This prevents a retirement
    // CAS from racing separate delete/put steps in the recovery plan.
    let decision;
    try {
      decision = await this.ctx.storage.transaction(async tx => {
        const fence = await tx.get(RETIREMENT_FENCE_KEY);
        const epoch = await tx.get(RETIREMENT_EPOCH_KEY);
        const persistedWorker = await tx.get(WORKER_ID_KEY);
        const active = await tx.get(ACTIVE_WAKE_KEY);
        const queued = await tx.get(QUEUED_WAKE_KEY);
        const evidence = inspectSupersessionEvidence(
          await tx.get(SUPERSESSION_EVIDENCE_KEY), workerId,
        );
        if (fence !== undefined || epoch !== undefined ||
            evidence.state === "invalid" ||
            persistedWorker !== workerId || this.quarantined(workerId) ||
            (active !== undefined && (!active || !active.wake ||
              !validateWake(active.wake, workerId))) ||
            (queued !== undefined && !validateWake(queued, workerId))) {
          return {status: 423, body: {error: QUARANTINE_DENIAL_CODE}};
        }

        const plan = planRecovery(
          assignments.map(assignment => ({...assignment, workerId})),
          active,
          queued,
          evidence.count,
        );
        if (plan.state === "waiting_for_assignment") {
          return {status: 200, body: {
            state: "waiting_for_assignment", worker_id: workerId,
          }};
        }
        if (plan.state === "unassigned_delivery_preserved" ||
            plan.state === "assignment_drift_requires_owner" ||
            plan.state === "assignment_identity_requires_owner" ||
            plan.state === "historical_delivery_requires_owner") {
          // Preserve both durable wake slots and require human reconciliation.
          return {status: 409, body: {
            state: plan.state, worker_id: workerId,
            ...(plan.assignment ? {assignment: plan.assignment} : {}),
            active_phase: plan.activePhase,
            active_delivery_id: plan.deliveryId,
            archived_delivery_count: evidence.count,
            ...(plan.queuedDeliveryId ?
              {queued_delivery_id: plan.queuedDeliveryId} : {}),
          }};
        }

        const assignment = plan.assignment;
        if (plan.state === "preserved_active_assignment") {
          return {status: 200, body: {
            state: plan.state, worker_id: workerId, assignment,
            active_phase: plan.activePhase, delivery_id: plan.deliveryId,
          }};
        }

        const wake = plan.wake;
        if (!validateWake(wake, workerId)) {
          return {status: 423, body: {error: QUARANTINE_DENIAL_CODE}};
        }
        if (!(await preserveDisplacedWakes(tx, workerId, [
          ...(active === undefined ? [] : [{wake: active.wake, phase: active.phase}]),
          ...(queued === undefined ? [] : [{wake: queued, phase: "queued"}]),
        ]))) return {status: 409, body: {error: "SUPERSESSION_EVIDENCE_CONFLICT"}};
        await tx.delete(QUEUED_WAKE_KEY);
        await tx.put(ACTIVE_WAKE_KEY, {wake, phase: "queued"});
        return {status: 200, sendDeliveryId: wake.delivery_id,
          body: {worker_id: workerId, assignment,
            delivery_id: wake.delivery_id}};
      });
    } catch {
      // A DO transaction can commit before reporting an error. No retry.
      return json({error: "RECOVERY_OUTCOME_UNCERTAIN"}, 503);
    }

    if (!decision || !Number.isInteger(decision.status) ||
        !decision.body || typeof decision.body !== "object") {
      return json({error: "RECOVERY_OUTCOME_UNCERTAIN"}, 503);
    }
    if (decision.sendDeliveryId) {
      const outcome = await this.sendActiveIfSafeOutcome(decision.sendDeliveryId);
      return json({
        state: outcome === "uncertain" ? "delivery_outcome_uncertain" :
          outcome === "sent" ? "recovered_sent" : "recovered_queued",
        ...decision.body,
      }, decision.status);
    }
    return json(decision.body, decision.status);
  }

  async recentDeliveries() {
    return (await this.ctx.storage.get(RECENT_DELIVERIES_KEY)) || [];
  }

  async rememberDelivery(recent, deliveryId, workerId) {
    if (this.quarantined(workerId) || await this.persistentlyRetired() ||
        (this.env?.BKE_G0_RUNTIME_QUARANTINE_ENABLED === "true" &&
         await this.quarantinedBoundWorker(workerId))) return false;
    const next = recent
      .filter((item) => item !== deliveryId)
      .concat(deliveryId)
      .slice(-RECENT_DELIVERY_LIMIT);
    await this.ctx.storage.put(RECENT_DELIVERIES_KEY, next);
    return !this.quarantined(workerId);
  }

  async authoritativeSocket() {
    const activeConnectionId = await this.ctx.storage.get(ACTIVE_CONNECTION_KEY);
    if (!activeConnectionId) return null;

    return this.ctx.getWebSockets().find((socket) => {
      const attachment = socket.deserializeAttachment();
      return attachment?.registered === true &&
        attachment?.connectionId === activeConnectionId;
    }) || null;
  }

  async sendActiveIfSafe() {
    // Preserve the canonical nine-seam WorkerSession interface.
    return this.sendActiveIfSafeDelivery(null);
  }

  async sendActiveIfSafeDelivery(expectedDeliveryId = null) {
    // Internal compatibility: callers expecting a boolean keep that contract.
    return (await this.sendActiveIfSafeOutcome(expectedDeliveryId)) === "sent";
  }

  async sendActiveIfSafeOutcome(expectedDeliveryId = null) {
    // "not_sent" means no reservation was proven; "uncertain" means the
    // transaction or WebSocket send could already have had an effect.
    // Only report a confirmed socket.send() attempt as "sent".
    let reservationAttempted = false;
    // All wake sends, including default-OFF v1, require a durable reservation
    // BEFORE the irreversible WebSocket side effect. Keep the short local
    // storage transaction and socket.send inside the DO event-exclusion gate:
    // no external GitHub, browser, service binding or auth calls here.
    try {
      return await this.ctx.blockConcurrencyWhile(async () => {
        const socket = await this.authoritativeSocket();
        if (!socket) return "not_sent";
        const attachment = socket.deserializeAttachment();
        if (attachment?.registered !== true ||
            !isValidWorkerId(attachment?.workerId) ||
            typeof attachment.connectionId !== "string") return "not_sent";

        // The retirement writer must use the exact same marker keys and
        // a DO storage transaction, not a separate in-memory flag.
        reservationAttempted = true;
        const reserved = await this.ctx.storage.transaction(async tx => {
          const fence = await tx.get(RETIREMENT_FENCE_KEY);
          const epoch = await tx.get(RETIREMENT_EPOCH_KEY);
          if (fence !== undefined || epoch !== undefined) return null;
          const persistedWorker = await tx.get(WORKER_ID_KEY);
          const activeConnectionId = await tx.get(ACTIVE_CONNECTION_KEY);
          const active = await tx.get(ACTIVE_WAKE_KEY);
          if (persistedWorker !== attachment.workerId ||
              this.quarantined(persistedWorker) ||
              activeConnectionId !== attachment.connectionId ||
              !active || active.phase !== "queued" ||
              !validateWake(active.wake, persistedWorker) ||
              (expectedDeliveryId !== null &&
               active.wake.delivery_id !== expectedDeliveryId)) return null;

          // A crash, restart, lost socket or send failure after this commit
          // leaves a SENT/UNCERTAIN wake. No caller may retry it as queued.
          await tx.put(ACTIVE_WAKE_KEY, {
            wake: active.wake,
            phase: "sent",
          });
          return active.wake;
        });
        if (!reserved) return "not_sent";

        try {
          socket.send(JSON.stringify(reserved));
        } catch {
          // Reservation committed, send may have crossed the boundary.
          // Never report "queued" or retry an ambiguous ChatGPT prompt.
          return "uncertain";
        }
        return "sent";
      });
    } catch {
      // If the storage transaction threw, it may have committed first.
      // Conservative uncertainty blocks any automatic delivery retry.
      return reservationAttempted ? "uncertain" : "not_sent";
    }
  }

  async webSocketMessage(socket, message) {
    if (await this.persistentlyRetired()) {
      socket.close(1008, "worker retired");
      return;
    }
    if (typeof message !== "string") {
      socket.close(1003, "text frames required");
      return;
    }

    const attachment = socket.deserializeAttachment() || {};
    const workerId = attachment.workerId || "";
    if (this.quarantined(workerId) ||
        (this.env?.BKE_G0_RUNTIME_QUARANTINE_ENABLED === "true" &&
         await this.quarantinedBoundWorker(workerId))) {
      socket.close(1008, "worker quarantined");
      return;
    }
    const parsed = parseJson(message);

    if (!attachment.registered) {
      if (!validateRegister(parsed, workerId)) {
        socket.close(1008, "invalid register");
        return;
      }

      const connectionId = attachment.connectionId;
      if (typeof connectionId !== "string" || connectionId.length === 0) {
        socket.close(1008, "connection identity missing");
        return;
      }

      if (this.quarantined(workerId) ||
          (this.env?.BKE_G0_RUNTIME_QUARANTINE_ENABLED === "true" &&
           await this.quarantinedBoundWorker(workerId))) {
        socket.close(1008, "worker quarantined");
        return;
      }
      // The persisted connection-id CAS and its WebSocket side effects
      // MUST be one non-interleavable local admission. Otherwise register A
      // can commit, yield, register B can replace it, and A can close B.
      // This short gate holds NO GitHub/network/browser/auth I/O.
      let registration = "uncertain";
      try {
        registration = await this.ctx.blockConcurrencyWhile(async () => {
          try {
            const admitted = await this.ctx.storage.transaction(async tx => {
              const fence = await tx.get(RETIREMENT_FENCE_KEY);
              const epoch = await tx.get(RETIREMENT_EPOCH_KEY);
              const persistedWorker = await tx.get(WORKER_ID_KEY);
              if (fence !== undefined || epoch !== undefined ||
                  persistedWorker !== workerId || this.quarantined(workerId))
                return false;
              const observation = nextRelayObservation(
                await tx.get(RELAY_OBSERVATION_KEY), workerId, Date.now(),
                "registration",
              );
              if (!observation) return false;
              // The evidence records transaction admission, NOT that socket
              // attachment, remote prompt handling or ChatGPT login succeeded.
              await tx.put(RELAY_OBSERVATION_KEY, observation);
              await tx.put(ACTIVE_CONNECTION_KEY, connectionId);
              return true;
            });
            if (!admitted || this.quarantined(workerId) ||
                await this.persistentlyRetired()) return "denied";

            // Bind the new socket attachment while the DO cannot accept
            // a competing register/close event, then retire older sockets.
            // A failed close is harmless: stale sockets have no stored
            // authority, and their later cleanup compare-and-delete denies.
            socket.serializeAttachment({
              workerId,
              connectionId,
              registered: true,
              sessionId: parsed.session_id,
            });
            for (const other of this.ctx.getWebSockets()) {
              if (other === socket) continue;
              const otherAttachment = other.deserializeAttachment();
              if (otherAttachment?.registered === true &&
                  otherAttachment.connectionId !== connectionId) {
                try { other.close(4001, "replaced by newer session"); }
                catch { /* Stored connection authority still wins. */ }
              }
            }
            return "registered";
          } catch {
            // A storage transaction might have committed before throwing;
            // do not retry registration or claim the old socket is safe.
            return "uncertain";
          }
        });
      } catch {
        registration = "uncertain";
      }
      if (registration !== "registered") {
        try {
          socket.close(registration === "denied" ? 1008 : 1011,
            registration === "denied" ?
              "worker quarantined or retired" : "registration outcome uncertain");
        } catch { /* Failed closure does not confer connection authority. */ }
        return;
      }
      await this.sendActiveIfSafe();
      return;
    }

    if (!validateAck(parsed, workerId)) {
      socket.close(1008, "invalid ack");
      return;
    }

    const activeConnectionId = await this.ctx.storage.get(ACTIVE_CONNECTION_KEY);
    if (this.quarantined(workerId) || await this.persistentlyRetired() ||
        (this.env?.BKE_G0_RUNTIME_QUARANTINE_ENABLED === "true" &&
         await this.quarantinedBoundWorker(workerId))) {
      socket.close(1008, "worker quarantined");
      return;
    }
    if (!activeConnectionId || attachment.connectionId !== activeConnectionId) {
      socket.close(1008, "stale session");
      return;
    }

    await this.handleAck(parsed, socket);
  }

  async handleAck(ack, socket) {
    if (await this.persistentlyRetired()) {
      socket.close(1008, "worker retired");
      return;
    }
    const ackAttachment = socket.deserializeAttachment() || {};
    const ackWorkerId = ackAttachment.workerId;
    if (this.quarantined(ackWorkerId) ||
        (this.env?.BKE_G0_RUNTIME_QUARANTINE_ENABLED === "true" &&
         await this.quarantinedBoundWorker(ackWorkerId)) ||
        await this.persistentlyRetired()) {
      socket.close(1008, "worker quarantined");
      return;
    }

    // Classify matched ACK, recent stale ACK, archived stale ACK or unknown
    // under ONE local DO transaction. A read outside this transaction could
    // race supersession, ID-cache rollover, socket handoff or a retire CAS.
    let disposition;
    try {
      disposition = await this.ctx.storage.transaction(async tx => {
        const fence = await tx.get(RETIREMENT_FENCE_KEY);
        const epoch = await tx.get(RETIREMENT_EPOCH_KEY);
        if (fence !== undefined || epoch !== undefined) return "retired";
        const storedWorkerId = await tx.get(WORKER_ID_KEY);
        const registeredConnectionId = await tx.get(ACTIVE_CONNECTION_KEY);
        const current = await tx.get(ACTIVE_WAKE_KEY);
        if (!isValidWorkerId(ackWorkerId) ||
            storedWorkerId !== ackWorkerId ||
            !ackAttachment.registered || !registeredConnectionId ||
            ackAttachment.connectionId !== registeredConnectionId ||
            (current !== undefined &&
              (!current || !validateWake(current.wake, ackWorkerId) ||
               !["queued","sent","accepted","deferred","recovery_required"]
                 .includes(current.phase)))) return "conflict";

        if (!current || current.wake.delivery_id !== ack.delivery_id) {
          const recent = (await tx.get(RECENT_DELIVERIES_KEY)) ?? [];
          const archive = await tx.get(SUPERSESSION_EVIDENCE_KEY);
          const stale = classifyUnmatchedRelayAck(
            recent, archive, ackWorkerId, ack.delivery_id,
          );
          // The stored historical ID is only a *reason to ignore* an
          // out-of-date ACK. Never record it as another observed completed
          // ACK, change active_wake, promote or send a wake.
          // Preserve the canonical v1 literal dedupe seam for the relay
          // contract. Historical archive validation has already completed
          // above, so this is only an idempotent stale-ACK observation.
          if (stale === "stale_recent" && recent.includes(ack.delivery_id))
            return "ignored_stale";
          if (stale === "stale_archived") return "ignored_stale";
          return "conflict";
        }
        if (!["sent", "accepted", "deferred"].includes(current.phase))
          return "conflict";

        const observation = nextRelayObservation(
          await tx.get(RELAY_OBSERVATION_KEY), ackWorkerId, Date.now(),
          "ack", ack, current.wake,
        );
        if (!observation) return "conflict";
        await tx.put(RELAY_OBSERVATION_KEY, observation);
        if (ack.state === "deferred" || ack.state === "accepted") {
          await tx.put(ACTIVE_WAKE_KEY, {
            wake: current.wake,
            phase: ack.state,
          });
          return "recorded";
        }
        if (ack.state === "rejected" || ack.state === "completed") {
          await tx.delete(ACTIVE_WAKE_KEY);
          return "cleared";
        }
        return "unknown";
      });
    } catch {
      // A transaction can commit before reporting an exception. Do not retry.
      socket.close(1011, "ack outcome uncertain");
      return;
    }
    if (disposition === "ignored_stale" || disposition === "recorded") return;
    if (disposition === "retired" || disposition === "conflict" ||
        disposition === "unknown") {
      socket.close(1008, "ack retirement or identity conflict");
      return;
    }
    if (disposition === "cleared") await this.promoteQueuedWake();
  }

  async promoteQueuedWake() {
    // Promotion must not race the same-DO retirement transaction or replace
    // a newer active delivery. Do not rely on checks made before an await.
    let promotedDeliveryId = null;
    try {
      promotedDeliveryId = await this.ctx.storage.transaction(async tx => {
        const fence = await tx.get(RETIREMENT_FENCE_KEY);
        const epoch = await tx.get(RETIREMENT_EPOCH_KEY);
        if (fence !== undefined || epoch !== undefined) return false;
        const persistedWorker = await tx.get(WORKER_ID_KEY);
        if (!isValidWorkerId(persistedWorker) ||
            this.quarantined(persistedWorker)) return false;
        const active = await tx.get(ACTIVE_WAKE_KEY);
        const queued = await tx.get(QUEUED_WAKE_KEY);
        if (active !== undefined || !queued ||
            !validateWake(queued, persistedWorker)) return false;
        await tx.delete(QUEUED_WAKE_KEY);
        await tx.put(ACTIVE_WAKE_KEY, { wake: queued, phase: "queued" });
        return queued.delivery_id;
      });
    } catch {
      // Commit might have occurred before an error: do not redeliver.
      return;
    }
    if (promotedDeliveryId)
      await this.sendActiveIfSafeDelivery(promotedDeliveryId);
  }
  async webSocketClose(socket) {
    if (this.quarantined(socket.deserializeAttachment()?.workerId)) return;
    await this.clearConnectionIfAuthoritative(socket);
    // Deliberately retain durable wake state. A wake in sent/deferred/accepted
    // state is never automatically redelivered after a disconnect because
    // ChatGPT dispatch outcome may be ambiguous.
  }

  async webSocketError(socket) {
    if (this.quarantined(socket.deserializeAttachment()?.workerId)) return;
    await this.clearConnectionIfAuthoritative(socket);
  }

  async clearConnectionIfAuthoritative(socket) {
    // A disconnect may race a later socket registration. A pre-read followed
    // by an unguarded delete could erase the NEW connection's authority.
    // Compare-and-delete in the same transaction as retire/register/ACK.
    const attachment = socket.deserializeAttachment() || {};
    if (!attachment.registered ||
        typeof attachment.connectionId !== "string" ||
        !isValidWorkerId(attachment.workerId) ||
        this.quarantined(attachment.workerId)) return;
    try {
      await this.ctx.storage.transaction(async tx => {
        const fence = await tx.get(RETIREMENT_FENCE_KEY);
        const epoch = await tx.get(RETIREMENT_EPOCH_KEY);
        if (fence !== undefined || epoch !== undefined) return;
        const persistedWorkerId = await tx.get(WORKER_ID_KEY);
        const activeConnectionId = await tx.get(ACTIVE_CONNECTION_KEY);
        if (persistedWorkerId !== attachment.workerId ||
            activeConnectionId !== attachment.connectionId) return;
        await tx.delete(ACTIVE_CONNECTION_KEY);
      });
    } catch {
      // Outcome could be committed or uncertain. Never retry stale cleanup.
    }
  }
}
