import { DurableObject } from "cloudflare:workers";
import {
  mintInstallationToken,
  verifyActionsOidcToken,
} from "./github-app.js";
import {
  CONTROL_REPOSITORY,
  MAX_WEBHOOK_BYTES,
  relayBearerMatches,
  isValidWorkerId,
  routeGitHubPullRequest,
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
const WORKER_ID_KEY = "worker_id";
const ACTIVE_CONNECTION_KEY = "active_connection_id";
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

function parseJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

async function postRelayCheckpoint(env, wake, relayState) {
  try {
    const minted = await mintInstallationToken(env);
    const body = [
      "BKE RELAY — " + relayState,
      "worker=" + wake.worker_id,
      "delivery=" + wake.delivery_id,
      "head=" + wake.expected_head_sha,
    ].join(" • ");

    await fetch(
      `https://api.github.com/repos/${CONTROL_REPOSITORY}/issues/${wake.pr_number}/comments`,
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
  const payload = await response.json().catch(() => null);
  if (!response.ok || !Array.isArray(payload)) {
    throw new Error(`GITHUB_ASSIGNMENT_RECOVERY_FAILED:${response.status}`);
  }

  const assignments = payload
    .filter((item) => item && item.pull_request && item.state === "open")
    .map((item) => ({
      number: Number(item.number),
      headRef: typeof item.pull_request?.head?.ref === "string"
        ? item.pull_request.head.ref
        : "",
      headSha: typeof item.pull_request?.head?.sha === "string"
        ? item.pull_request.head.sha
        : "",
      labels: Array.isArray(item.labels)
        ? item.labels.map((labelItem) => String(labelItem?.name || ""))
        : [],
    }))
    .filter((item) =>
      item.number > 0 &&
      item.headRef &&
      /^[0-9a-f]{40}$/.test(item.headSha) &&
      item.labels.some((name) => name.toLowerCase() === `bke-worker:${workerId}`.toLowerCase())
    );

  return assignments;
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

export class WorkerSession extends DurableObject {
  async fetch(request) {
    const workerId = request.headers.get("x-bke-worker-id") || "";
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
    const existing = await this.ctx.storage.get(WORKER_ID_KEY);
    if (existing === undefined) {
      await this.ctx.storage.put(WORKER_ID_KEY, workerId);
      return true;
    }
    return existing === workerId;
  }

  async connect(request, workerId) {
    const token = this.env.BKE_WORKER_RELAY_TOKEN_KEY;
    if (!token || !(await relayBearerMatches(request.headers.get("Authorization") || "", token, workerId))) {
      return json({ error: "RELAY_UNAUTHORIZED" }, 401);
    }
    if ((request.headers.get("Upgrade") || "").toLowerCase() !== "websocket") {
      return json({ error: "WEBSOCKET_UPGRADE_REQUIRED" }, 426);
    }

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
    const wake = parseJson(await request.text());
    if (!validateWake(wake, workerId)) {
      return json({ error: "WAKE_INVALID" }, 400);
    }

    const recent = await this.recentDeliveries();
    if (recent.includes(wake.delivery_id)) {
      return json({ state: "duplicate", delivery_id: wake.delivery_id }, 200);
    }

    const active = await this.ctx.storage.get(ACTIVE_WAKE_KEY);
    const crossPrRecovery = active &&
      active.wake.pr_number !== wake.pr_number &&
      wake.reason === "github_pull_request_cross_pr_recovery";
    if (active && active.wake.pr_number !== wake.pr_number && !crossPrRecovery) {
      return json(
        {
          error: "WORKER_WAKE_IN_FLIGHT",
          active_pr: active.wake.pr_number,
          incoming_pr: wake.pr_number,
        },
        409,
      );
    }
    if (!active && wake.reason === "github_pull_request_cross_pr_recovery") {
      return json({ error: "CROSS_PR_RECOVERY_NOT_REQUIRED" }, 409);
    }

    const samePrActive = active &&
      active.wake.pr_number === wake.pr_number;
    const selfSynchronizeSuppression = samePrActive &&
      active.phase !== "queued" &&
      active.wake.expected_head_sha !== wake.expected_head_sha &&
      wake.reason === "github_pull_request_self_synchronize";

    await this.rememberDelivery(recent, wake.delivery_id);

    if (selfSynchronizeSuppression) {
      return json({
        state: "self_synchronize_suppressed",
        delivery_id: wake.delivery_id,
        active_delivery_id: active.wake.delivery_id,
      }, 202);
    }

    const supersedesStaleHead = samePrActive &&
      active.wake.expected_head_sha !== wake.expected_head_sha &&
      wake.reason === "github_pull_request_synchronize";
    const explicitReassignmentRecovery = samePrActive &&
      wake.reason === "github_pull_request_labeled";
    const supersedesAmbiguousWake =
      supersedesStaleHead || explicitReassignmentRecovery;

    if (crossPrRecovery) {
      await this.ctx.storage.delete(QUEUED_WAKE_KEY);
      await this.ctx.storage.put(ACTIVE_WAKE_KEY, {
        wake,
        phase: "queued",
      });
      const sent = await this.sendActiveIfSafe();
      return json({
        state: sent ? "cross_pr_recovered_sent" : "cross_pr_recovered_queued",
        delivery_id: wake.delivery_id,
        superseded_pr: active.wake.pr_number,
        superseded_delivery_id: active.wake.delivery_id,
      }, 202);
    }

    if (supersedesAmbiguousWake) {
      await this.ctx.storage.delete(QUEUED_WAKE_KEY);
      await this.ctx.storage.put(ACTIVE_WAKE_KEY, {
        wake,
        phase: "queued",
      });
      const sent = await this.sendActiveIfSafe();
      const statePrefix = explicitReassignmentRecovery ? "recovered" : "superseded";
      return json({
        state: sent ? `${statePrefix}_sent` : `${statePrefix}_queued`,
        delivery_id: wake.delivery_id,
        superseded_delivery_id: active.wake.delivery_id,
      }, 202);
    }

    if (active?.phase === "queued") {
      await this.ctx.storage.put(ACTIVE_WAKE_KEY, {
        wake,
        phase: "queued",
      });
      return json({
        state: "coalesced_queued",
        delivery_id: wake.delivery_id,
      }, 202);
    }

    if (!active) {
      await this.ctx.storage.put(ACTIVE_WAKE_KEY, {
        wake,
        phase: "queued",
      });
      const sent = await this.sendActiveIfSafe();
      return json({
        state: sent ? "sent" : "queued",
        delivery_id: wake.delivery_id,
      }, 202);
    }

    await this.ctx.storage.put(QUEUED_WAKE_KEY, wake);
    return json({
      state: "queued_behind_active",
      delivery_id: wake.delivery_id,
      active_delivery_id: active.wake.delivery_id,
    }, 202);
  }

  async recover(request, workerId) {
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

    if (assignments.length > 1) {
      const active = await this.ctx.storage.get(ACTIVE_WAKE_KEY);
      if (active?.wake?.pr_number) {
        try {
          const minted = await mintInstallationToken(this.env);
          await fetch(
            `https://api.github.com/repos/${CONTROL_REPOSITORY}/issues/${active.wake.pr_number}/comments`,
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

    const active = await this.ctx.storage.get(ACTIVE_WAKE_KEY);
    const queued = await this.ctx.storage.get(QUEUED_WAKE_KEY);

    if (assignments.length === 0) {
      await this.ctx.storage.delete(ACTIVE_WAKE_KEY);
      await this.ctx.storage.delete(QUEUED_WAKE_KEY);
      return json({
        state: "waiting_for_assignment",
        worker_id: workerId,
      }, 200);
    }

    const assignment = assignments[0];
    const sameActivePr = active?.wake?.pr_number === assignment.number;
    const sameActiveHead = sameActivePr &&
      active.wake.expected_head_sha === assignment.headSha;

    if (sameActiveHead) {
      return json({
        state: "preserved_active_assignment",
        worker_id: workerId,
        assignment,
        active_phase: active.phase,
        delivery_id: active.wake.delivery_id,
      }, 200);
    }

    const wake = {
      protocol: 1,
      type: "wake",
      worker_id: workerId,
      repo: CONTROL_REPOSITORY,
      pr_number: assignment.number,
      expected_head_sha: assignment.headSha,
      reason: "github_pull_request_reconnect_recovery",
      delivery_id: `recovery-${workerId}-${assignment.number}-${assignment.headSha}`,
    };

    if (active && sameActivePr && active.phase !== "queued") {
      await this.ctx.storage.put(ACTIVE_WAKE_KEY, {
        wake,
        phase: "recovery_required",
      });
      await this.ctx.storage.delete(QUEUED_WAKE_KEY);
      return json({
        state: "head_converged_without_redelivery",
        worker_id: workerId,
        assignment,
        delivery_id: wake.delivery_id,
      }, 200);
    }

    await this.ctx.storage.delete(QUEUED_WAKE_KEY);
    await this.ctx.storage.put(ACTIVE_WAKE_KEY, {
      wake,
      phase: "queued",
    });
    const sent = await this.sendActiveIfSafe();
    return json({
      state: sent ? "recovered_sent" : "recovered_queued",
      worker_id: workerId,
      assignment,
      delivery_id: wake.delivery_id,
    }, 200);
  }

  async recentDeliveries() {
    return (await this.ctx.storage.get(RECENT_DELIVERIES_KEY)) || [];
  }

  async rememberDelivery(recent, deliveryId) {
    const next = recent
      .filter((item) => item !== deliveryId)
      .concat(deliveryId)
      .slice(-RECENT_DELIVERY_LIMIT);
    await this.ctx.storage.put(RECENT_DELIVERIES_KEY, next);
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
    const active = await this.ctx.storage.get(ACTIVE_WAKE_KEY);
    if (!active || active.phase !== "queued") return false;

    const socket = await this.authoritativeSocket();
    if (!socket) return false;

    socket.send(JSON.stringify(active.wake));
    await this.ctx.storage.put(ACTIVE_WAKE_KEY, {
      wake: active.wake,
      phase: "sent",
    });
    return true;
  }

  async webSocketMessage(socket, message) {
    if (typeof message !== "string") {
      socket.close(1003, "text frames required");
      return;
    }

    const attachment = socket.deserializeAttachment() || {};
    const workerId = attachment.workerId || "";
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

      await this.ctx.storage.put(ACTIVE_CONNECTION_KEY, connectionId);

      for (const other of this.ctx.getWebSockets()) {
        if (other === socket) continue;
        const otherAttachment = other.deserializeAttachment();
        if (otherAttachment?.registered === true) {
          other.close(4001, "replaced by newer session");
        }
      }

      socket.serializeAttachment({
        workerId,
        connectionId,
        registered: true,
        sessionId: parsed.session_id,
      });
      await this.sendActiveIfSafe();
      return;
    }

    if (!validateAck(parsed, workerId)) {
      socket.close(1008, "invalid ack");
      return;
    }

    const activeConnectionId = await this.ctx.storage.get(ACTIVE_CONNECTION_KEY);
    if (!activeConnectionId || attachment.connectionId !== activeConnectionId) {
      socket.close(1008, "stale session");
      return;
    }

    await this.handleAck(parsed, socket);
  }

  async handleAck(ack, socket) {
    const active = await this.ctx.storage.get(ACTIVE_WAKE_KEY);
    if (!active || active.wake.delivery_id !== ack.delivery_id) {
      const recent = await this.recentDeliveries();
      if (recent.includes(ack.delivery_id)) {
        return;
      }
      socket.close(1008, "ack delivery mismatch");
      return;
    }

    if (ack.state === "deferred" || ack.state === "accepted") {
      await this.ctx.storage.put(ACTIVE_WAKE_KEY, {
        wake: active.wake,
        phase: ack.state,
      });
      return;
    }

    if (ack.state === "rejected" || ack.state === "completed") {
      await this.ctx.storage.delete(ACTIVE_WAKE_KEY);
      await this.promoteQueuedWake();
    }
  }

  async promoteQueuedWake() {
    const queued = await this.ctx.storage.get(QUEUED_WAKE_KEY);
    if (!queued) return;

    await this.ctx.storage.delete(QUEUED_WAKE_KEY);
    await this.ctx.storage.put(ACTIVE_WAKE_KEY, {
      wake: queued,
      phase: "queued",
    });
    await this.sendActiveIfSafe();
  }

  async webSocketClose(socket) {
    await this.clearConnectionIfAuthoritative(socket);
    // Deliberately retain durable wake state. A wake in sent/deferred/accepted
    // state is never automatically redelivered after a disconnect because
    // ChatGPT dispatch outcome may be ambiguous.
  }

  async webSocketError(socket) {
    await this.clearConnectionIfAuthoritative(socket);
  }

  async clearConnectionIfAuthoritative(socket) {
    const attachment = socket.deserializeAttachment() || {};
    const activeConnectionId = await this.ctx.storage.get(ACTIVE_CONNECTION_KEY);
    if (attachment.connectionId === activeConnectionId) {
      await this.ctx.storage.delete(ACTIVE_CONNECTION_KEY);
    }
  }
}
