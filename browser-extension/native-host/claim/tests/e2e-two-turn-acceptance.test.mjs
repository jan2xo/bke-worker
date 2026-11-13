/**
 * F1-06 Synthetic End-to-End Acceptance Suite (1 worker, 1 isolated PR,
 * 1 authenticated session, 2 genuine turns, 0 duplicate sends + fail-closed adversarial matrix).
 *
 * Exercises the FULL desktop stack end-to-end using local test doubles for GitHub REST and Chrome DOM:
 * - GitHubF1Ledger (F1-02) against stateful local GitHub REST double
 * - FileExecutionJournal & DesktopController (F1-03) with HMAC-SHA256 webhook + crash recovery
 * - Real Node `entry.mjs --controller-bridge` subprocess stdio/IPC bridge (F1-03)
 * - connectControllerNativeBridge + ExtensionBrowserAdapter (F1-03 / F1-04 / F1-05)
 * - Simulated single-tab ChatGPT DOM enforcing landing -> /c/<id> -> same /c/<id>
 */
import test from "node:test";
import assert from "node:assert/strict";
import { createHmac, webcrypto } from "node:crypto";
import { spawn } from "node:child_process";
import { connect as connectNet } from "node:net";
import { mkdtemp, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { createDeviceIdentityBridge } from "../../../dist/device-identity.js";
import { connectControllerNativeBridge } from "../../../dist/controller-transport.js";
import { ExtensionBrowserAdapter } from "../../../dist/extension-browser-adapter.js";
import { GitHubF1Ledger } from "../dist/native-host/claim/github-f1-ledger.js";
import {
  DesktopController,
  FileExecutionJournal,
} from "../dist/native-host/claim/desktop-controller.js";

const ORIGIN = "chrome-extension://" + "a".repeat(32) + "/";
const PROFILE_BINDING = "4".repeat(64);
const H = (c) => c.repeat(64);
const RESOURCES = {
  chatgpt_target_sha256: H("1"),
  browser_profile_sha256: H("2"),
  bridge_identity_sha256: H("3"),
};
const HEAD = "a".repeat(40);
const TREE = "e".repeat(40);
const REPO = "jan2xo/bke-worker";
const WORKER = "worker-f1";
const PR_NUMBER = 127;
const PINNED_APP = { id: 9001, slug: "bke-dispatcher-app" };
const WEBHOOK_SECRET = "synthetic-local-webhook-secret";
const entryPath = fileURLToPath(new URL("../../entry.mjs", import.meta.url));

function memoryIdentityStore() {
  let current;
  let tail = Promise.resolve();
  return {
    async atomic(action) {
      let release;
      const next = new Promise((resolve) => { release = resolve; });
      const prev = tail;
      tail = next;
      await prev;
      let draft = current === undefined ? undefined : structuredClone(current);
      try {
        const res = await action({
          get: async () => (draft === undefined ? undefined : structuredClone(draft)),
          put: async (v) => { draft = structuredClone(v); },
        });
        current = draft;
        return res;
      } finally {
        release();
      }
    },
  };
}

function createSyntheticGitHub(initialAttempt = "attempt-turn-1") {
  const refs = new Map();
  const commits = new Map([[HEAD, { sha: HEAD, tree: { sha: TREE }, parents: [], message: "head" }]]);
  let openPrs = [
    { number: PR_NUMBER, state: "open", head: { sha: HEAD }, labels: [{ name: `bke-worker:${WORKER}` }] },
  ];
  let checkRuns = [
    {
      id: 701,
      name: "bke-ticket",
      app: PINNED_APP,
      head_sha: HEAD,
      status: "completed",
      conclusion: "success",
      external_id: `bke-ticket:v1:${WORKER}:${initialAttempt}:${Math.floor(Date.parse("2026-10-20T12:00:00.000Z") / 1000)}`,
    },
  ];
  let seq = 1;
  const requests = [];
  const res = (status, body) => ({ status, headers: { get: () => null }, json: async () => body });

  const fetch = async (url, init) => {
    const parsed = new URL(url);
    const p = parsed.pathname;
    const body = init.body ? JSON.parse(init.body) : null;
    requests.push({ method: init.method, path: p, body });

    if (init.method === "GET" && p === "/installation/repositories") {
      return res(200, { repositories: [{ full_name: REPO, permissions: { push: true } }] });
    }
    if (init.method === "GET" && p === `/repos/${REPO}/pulls`) {
      return res(200, openPrs);
    }
    if (init.method === "GET" && p.startsWith(`/repos/${REPO}/pulls/`)) {
      const n = Number(p.split("/").pop());
      const pr = openPrs.find((x) => x.number === n);
      return pr ? res(200, pr) : res(404, { message: "Not Found" });
    }
    if (init.method === "GET" && p === `/repos/${REPO}/git/matching-refs/bke/`) {
      return res(
        200,
        [...refs.entries()].filter(([k]) => k.startsWith("refs/bke/")).map(([ref, sha]) => ({ ref, object: { sha } })),
      );
    }
    if (init.method === "GET" && p.endsWith("/check-runs")) {
      return res(200, { total_count: checkRuns.length, check_runs: checkRuns });
    }
    if (init.method === "GET" && p.startsWith(`/repos/${REPO}/git/commits/`)) {
      const sha = p.split("/").pop();
      return commits.has(sha) ? res(200, commits.get(sha)) : res(404, { message: "Not Found" });
    }
    if (init.method === "POST" && p === `/repos/${REPO}/git/commits`) {
      const sha = String(seq++).padStart(40, "0").slice(-40);
      const created = { sha, tree: { sha: body.tree }, parents: body.parents, message: body.message };
      commits.set(sha, created);
      return res(201, created);
    }
    if (init.method === "GET" && p.startsWith(`/repos/${REPO}/git/ref/`)) {
      const ref = "refs/" + p.slice(`/repos/${REPO}/git/ref/`.length);
      return refs.has(ref) ? res(200, { ref, object: { sha: refs.get(ref) } }) : res(404, { message: "Not Found" });
    }
    if (init.method === "POST" && p === `/repos/${REPO}/git/refs`) {
      if (refs.has(body.ref)) return res(422, { message: "Reference already exists" });
      refs.set(body.ref, body.sha);
      return res(201, { ref: body.ref, object: { sha: body.sha } });
    }
    if (init.method === "PATCH" && p.startsWith(`/repos/${REPO}/git/refs/`)) {
      const ref = "refs/" + p.slice(`/repos/${REPO}/git/refs/`.length);
      if (!refs.has(ref)) return res(422, { message: "Reference does not exist" });
      refs.set(ref, body.sha);
      return res(200, { ref, object: { sha: body.sha } });
    }
    return res(404, { message: "Unhandled" });
  };

  return {
    fetch,
    refs,
    requests,
    setOpenPrs(next) { openPrs = next; },
    setTicket(attemptId, overrides = {}) {
      checkRuns = [
        {
          id: 702,
          name: "bke-ticket",
          app: PINNED_APP,
          head_sha: HEAD,
          status: "completed",
          conclusion: "success",
          external_id: `bke-ticket:v1:${WORKER}:${attemptId}:${Math.floor(Date.parse("2026-10-20T12:00:00.000Z") / 1000)}`,
          ...overrides,
        },
      ];
    },
  };
}

function sendIpc(sockPath, cmd) {
  return new Promise((resolve, reject) => {
    const client = connectNet(sockPath, () => client.write(JSON.stringify(cmd) + "\n"));
    let buf = "";
    client.on("data", (chunk) => {
      buf += chunk.toString("utf8");
      const idx = buf.indexOf("\n");
      if (idx >= 0) {
        const res = JSON.parse(buf.slice(0, idx));
        client.end();
        resolve(res);
      }
    });
    client.once("error", reject);
  });
}

async function createE2eHarness(dir, gh, options = {}) {
  const policyPath = join(dir, "policy.json");
  const sockPath = join(dir, "bridge.sock");
  const journalPath = join(dir, "journal.json");

  const identity = createDeviceIdentityBridge({ store: memoryIdentityStore(), cryptoImpl: webcrypto, now: () => Date.now() });
  const pub = await identity.initialize(WORKER);
  await writeFile(
    policyPath,
    JSON.stringify({
      version: 1,
      allowed_origin: ORIGIN,
      worker_id: WORKER,
      public_key_sha256: pub.public_key_sha256,
      profile_binding_sha256: PROFILE_BINDING,
      resources: RESOURCES,
      expires_at_ms: Date.now() + 120_000,
    }),
    { mode: 0o600 },
  );

  // Simulated browser page state
  const browserState = {
    url: "https://chatgpt.com/",
    uiState: "NEW_CHAT_LANDING",
    tabId: 17,
    targetId: "target-e2e-01",
    profileId: "profile-e2e-01",
    submissions: [],
    throwOnSubmit: options.throwOnSubmit ?? false,
  };

  let child = null;
  const runtime = {
    getURL: () => ORIGIN,
    connectNative() {
      child = spawn(process.execPath, [entryPath, "--controller-bridge", policyPath, ORIGIN, sockPath], {
        stdio: ["pipe", "pipe", "pipe"],
        env: { PATH: process.env.PATH ?? "" },
      });
      const msgListeners = new Set();
      const discListeners = new Set();
      let buffer = Buffer.alloc(0);
      const notifyDisconnect = () => { for (const fn of [...discListeners]) fn(); };
      child.stdout.on("data", (chunk) => {
        buffer = Buffer.concat([buffer, chunk]);
        while (buffer.length >= 4) {
          const len = buffer.readUInt32LE(0);
          if (len < 1 || len > 16_384) { child.kill("SIGTERM"); notifyDisconnect(); return; }
          if (buffer.length < len + 4) break;
          const msg = JSON.parse(buffer.subarray(4, len + 4).toString("utf8"));
          buffer = buffer.subarray(len + 4);
          for (const fn of [...msgListeners]) fn(msg);
        }
      });
      child.once("exit", notifyDisconnect);
      return {
        postMessage(msg) {
          const body = Buffer.from(JSON.stringify(msg), "utf8");
          const frame = Buffer.allocUnsafe(body.length + 4);
          frame.writeUInt32LE(body.length, 0);
          body.copy(frame, 4);
          child.stdin.write(frame);
        },
        disconnect() { if (!child.stdin.writableEnded) child.stdin.end(); },
        onMessage: { addListener: (fn) => msgListeners.add(fn), removeListener: (fn) => msgListeners.delete(fn) },
        onDisconnect: { addListener: (fn) => discListeners.add(fn), removeListener: (fn) => discListeners.delete(fn) },
      };
    },
  };

  let clockCounter = Date.parse("2026-10-20T09:00:00.000Z");
  const nextIso = () => {
    clockCounter += 500;
    return new Date(clockCounter).toISOString();
  };

  const bridgeConn = await connectControllerNativeBridge({
    runtime,
    identity,
    workerId: WORKER,
    resources: RESOURCES,
    profileBindingSha256: PROFILE_BINDING,
    checkPermission: async () => true,
    cryptoImpl: webcrypto,
    handlers: {
      withTargetLock: async (run) => ({ ok: true, value: await run() }),
      getTargetStatus: async () => ({
        ok: true,
        code: "TARGET_OK",
        payload: {
          observedAt: nextIso(),
          url: browserState.url,
          visible: true,
          composerAvailable: true,
          turnBusy: false,
          uiState: browserState.uiState,
          tabId: browserState.tabId,
          targetId: browserState.targetId,
          profileId: browserState.profileId,
          matchingWritableTargetCount: 1,
          sharedWritableProfile: false,
        },
      }),
      dispatchFirstMessage: async (cmd) => {
        if (browserState.throwOnSubmit) throw new Error("DOM_SUBMIT_UNCERTAIN");
        const beforeUrl = browserState.url;
        const convId = "conv-e2e-0001";
        const afterUrl = `https://chatgpt.com/c/${convId}`;
        browserState.submissions.push({ turn: 1, attemptId: cmd.attempt_id, beforeUrl, afterUrl, prompt: cmd.prompt });
        browserState.url = afterUrl;
        browserState.uiState = "THREAD";
        return {
          ok: true,
          code: "FIRST_MESSAGE_SENT",
          payload: {
            beforeUrl,
            afterUrl,
            conversationId: convId,
            sendStartedAt: nextIso(),
            confirmedAt: nextIso(),
          },
        };
      },
      dispatchContinuation: async (cmd) => {
        if (browserState.throwOnSubmit) throw new Error("DOM_SUBMIT_UNCERTAIN");
        const beforeUrl = browserState.url;
        const afterUrl = `https://chatgpt.com/c/${cmd.expected_conversation_id}`;
        browserState.submissions.push({ turn: cmd.expected_turn_number, attemptId: cmd.attempt_id, beforeUrl, afterUrl, prompt: cmd.prompt });
        return {
          ok: true,
          code: "CONTINUATION_SENT",
          payload: {
            beforeUrl,
            afterUrl,
            conversationId: cmd.expected_conversation_id,
            sendStartedAt: nextIso(),
            confirmedAt: nextIso(),
          },
        };
      },
    },
  });
  assert.equal(bridgeConn.ok, true);

  let bridgeSeq = 0;
  const nextSeq = () => ++bridgeSeq;

  const journal = new FileExecutionJournal(journalPath, { repository: REPO, prNumber: PR_NUMBER, workerId: WORKER }, nextIso);
  const controller = new DesktopController({
    journal,
    webhookSecret: WEBHOOK_SECRET,
    nowIso: nextIso,
    liveProofs: {
      githubCasOwnerCertified: true,
      nativePairingOwnerCertified: true,
      realBrowserOwnerAccepted: true,
    },
    createLedger: (headSha) =>
      new GitHubF1Ledger(
        {
          repository: REPO,
          prNumber: PR_NUMBER,
          headSha,
          workerId: WORKER,
          authenticatedWorkerId: WORKER,
          pinnedApp: PINNED_APP,
          executionId: "exec-e2e-01",
          targetId: browserState.targetId,
          profileId: browserState.profileId,
          targetTabId: browserState.tabId,
          nowIso: nextIso,
        },
        gh.fetch,
        async () => "synthetic-github-token",
      ),
    createBrowserPorts: (headSha) => {
      const adapter = new ExtensionBrowserAdapter(
        {
          repository: REPO,
          prNumber: PR_NUMBER,
          headSha,
          workerId: WORKER,
          targetId: browserState.targetId,
          profileId: browserState.profileId,
          targetTabId: browserState.tabId,
          nextSeq,
        },
        { sendCommand: (cmd) => sendIpc(sockPath, cmd) },
      );
      return {
        firstMessage: adapter.asFirstMessagePort(),
        continuation: adapter.asContinuationPort(),
      };
    },
  });
  await controller.initialize();

  const signBody = (bodyObj) => {
    const raw = JSON.stringify(bodyObj);
    const sig = "sha256=" + createHmac("sha256", WEBHOOK_SECRET).update(raw).digest("hex");
    return { raw, sig };
  };

  return {
    controller,
    journal,
    journalPath,
    browserState,
    signBody,
    close: () => {
      bridgeConn.session.close();
      if (child && child.exitCode === null) child.kill("SIGTERM");
    },
  };
}

test("F1-06 2-turn acceptance: 1 worker, 1 PR, 1 authenticated session, 2 genuine turns in same conversation, 0 duplicate sends", async () => {
  const dir = await mkdtemp(join(tmpdir(), "bke-e2e-two-turn-"));
  const gh = createSyntheticGitHub("attempt-turn-1");
  const harness = await createE2eHarness(dir, gh);

  try {
    // Gate check: default humanLiveSendAuthorized = false MUST refuse with 0 submissions
    const blockedGate = await harness.controller.processAuthorizedWake({
      headSha: HEAD,
      prNumber: PR_NUMBER,
      humanLiveSendAuthorized: false,
    });
    assert.equal(blockedGate.status, "BLOCKED");
    assert.equal(blockedGate.code, "LIVE_SEND_DISABLED");
    assert.equal(harness.browserState.submissions.length, 0);

    // Turn 1 authorized webhook wake
    const payload1 = harness.signBody({ action: "check_run", pr: PR_NUMBER, attempt: "attempt-turn-1" });
    const turn1 = await harness.controller.handleWebhookWake({
      signatureHeader: payload1.sig,
      deliveryId: "deliv-turn-1",
      rawBody: payload1.raw,
      headSha: HEAD,
      prNumber: PR_NUMBER,
      humanLiveSendAuthorized: true,
    });
    assert.equal(turn1.status, "CONFIRMED_TURN_1");
    assert.equal(turn1.turnNumber, 1);
    assert.equal(turn1.conversationId, "conv-e2e-0001");
    assert.equal(harness.browserState.submissions.length, 1);
    assert.equal(gh.refs.get(`refs/bke/claims/${PR_NUMBER}/attempt-turn-1`), HEAD);

    // Duplicate webhook delivery MUST be rejected with 0 duplicate submissions
    const dupWebhook = await harness.controller.handleWebhookWake({
      signatureHeader: payload1.sig,
      deliveryId: "deliv-turn-1",
      rawBody: payload1.raw,
      headSha: HEAD,
      prNumber: PR_NUMBER,
      humanLiveSendAuthorized: true,
    });
    assert.equal(dupWebhook.code, "WEBHOOK_DELIVERY_DUPLICATE");
    assert.equal(harness.browserState.submissions.length, 1);

    // Reused consumed attempt-turn-1 MUST be blocked even on new webhook delivery
    const replayAttemptPayload = harness.signBody({ action: "check_run", attempt: "attempt-turn-1" });
    const replayAttempt = await harness.controller.handleWebhookWake({
      signatureHeader: replayAttemptPayload.sig,
      deliveryId: "deliv-turn-1-replay",
      rawBody: replayAttemptPayload.raw,
      headSha: HEAD,
      prNumber: PR_NUMBER,
      humanLiveSendAuthorized: true,
    });
    assert.equal(replayAttempt.status, "BLOCKED");
    assert.equal(harness.browserState.submissions.length, 1);

    // Issue fresh ticket for Turn 2 & send continuation wake
    gh.setTicket("attempt-turn-2");
    const payload2 = harness.signBody({ action: "check_run", pr: PR_NUMBER, attempt: "attempt-turn-2" });
    const turn2 = await harness.controller.handleWebhookWake({
      signatureHeader: payload2.sig,
      deliveryId: "deliv-turn-2",
      rawBody: payload2.raw,
      headSha: HEAD,
      prNumber: PR_NUMBER,
      humanLiveSendAuthorized: true,
    });
    assert.equal(turn2.status, "CONFIRMED_CONTINUATION");
    assert.equal(turn2.turnNumber, 2);
    assert.equal(turn2.conversationId, "conv-e2e-0001");
    assert.equal(harness.browserState.submissions.length, 2);
    assert.equal(harness.browserState.submissions[0].turn, 1);
    assert.equal(harness.browserState.submissions[1].turn, 2);
    assert.equal(harness.browserState.submissions[1].beforeUrl, "https://chatgpt.com/c/conv-e2e-0001");
    assert.equal(harness.browserState.submissions[1].afterUrl, "https://chatgpt.com/c/conv-e2e-0001");
    assert.ok(gh.refs.has(`refs/bke/turns/${PR_NUMBER}/attempt-turn-1`));
    assert.ok(gh.refs.has(`refs/bke/turns/${PR_NUMBER}/attempt-turn-2`));
  } finally {
    harness.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("F1-06 adversarial fail-closed matrix: bad HMAC, accidental landing on turn 2, crash mid-send, uncertain submit quarantine", async () => {
  // 1. Bad HMAC & accidental landing on Turn 2
  const dir1 = await mkdtemp(join(tmpdir(), "bke-e2e-adv1-"));
  const gh1 = createSyntheticGitHub("attempt-1");
  const h1 = await createE2eHarness(dir1, gh1);
  try {
    const badSig = await h1.controller.handleWebhookWake({
      signatureHeader: "sha256=" + "0".repeat(64),
      deliveryId: "deliv-bad-sig",
      rawBody: "{}",
      headSha: HEAD,
      prNumber: PR_NUMBER,
      humanLiveSendAuthorized: true,
    });
    assert.equal(badSig.code, "WEBHOOK_SIGNATURE_INVALID");

    // Complete turn 1
    const r1 = await h1.controller.processAuthorizedWake({ headSha: HEAD, prNumber: PR_NUMBER, humanLiveSendAuthorized: true });
    assert.equal(r1.status, "CONFIRMED_TURN_1");

    // Simulate accidental navigation back to https://chatgpt.com/ before Turn 2 -> MUST block & 0 extra sends!
    h1.browserState.url = "https://chatgpt.com/";
    h1.browserState.uiState = "NEW_CHAT_LANDING";
    gh1.setTicket("attempt-2");
    const r2 = await h1.controller.processAuthorizedWake({ headSha: HEAD, prNumber: PR_NUMBER, humanLiveSendAuthorized: true });
    assert.equal(r2.status, "BLOCKED");
    assert.equal(r2.code, "WRONG_CONVERSATION_OR_NEW_CHAT");
    assert.equal(h1.browserState.submissions.length, 1);

    // Multi-PR conflict check
    gh1.setOpenPrs([
      { number: PR_NUMBER, state: "open", head: { sha: HEAD }, labels: [{ name: `bke-worker:${WORKER}` }] },
      { number: PR_NUMBER + 1, state: "open", head: { sha: HEAD }, labels: [{ name: `bke-worker:${WORKER}` }] },
    ]);
    h1.browserState.url = "https://chatgpt.com/c/conv-e2e-0001";
    h1.browserState.uiState = "THREAD";
    const multiPr = await h1.controller.processAuthorizedWake({ headSha: HEAD, prNumber: PR_NUMBER, humanLiveSendAuthorized: true });
    assert.equal(multiPr.code, "GITHUB_WORKER_MULTI_PR_CONFLICT");
    assert.equal(h1.browserState.submissions.length, 1);
  } finally {
    h1.close();
    await rm(dir1, { recursive: true, force: true });
  }

  // 2. Crash recovery while DISPATCHING -> quarantine & refuse retry
  const dir2 = await mkdtemp(join(tmpdir(), "bke-e2e-adv2-"));
  const gh2 = createSyntheticGitHub("attempt-crash");
  const h2 = await createE2eHarness(dir2, gh2);
  try {
    const raw = JSON.parse(await readFile(h2.journalPath, "utf8"));
    raw.phase = "DISPATCHING";
    raw.activeAttemptId = "attempt-crash";
    await writeFile(h2.journalPath, JSON.stringify(raw), { mode: 0o600 });

    const recovered = await h2.controller.initialize();
    assert.equal(recovered.phase, "DELIVERY_UNCERTAIN");
    assert.equal(recovered.uncertainReason, "CRASH_DURING_DISPATCHING");

    const retry = await h2.controller.processAuthorizedWake({ headSha: HEAD, prNumber: PR_NUMBER, humanLiveSendAuthorized: true });
    assert.equal(retry.status, "BLOCKED");
    assert.equal(retry.journalPhase, "DELIVERY_UNCERTAIN");
    assert.equal(h2.browserState.submissions.length, 0);
  } finally {
    h2.close();
    await rm(dir2, { recursive: true, force: true });
  }

  // 3. Submit throw/uncertainty writes GitHub uncertain ref and latches quarantine
  const dir3 = await mkdtemp(join(tmpdir(), "bke-e2e-adv3-"));
  const gh3 = createSyntheticGitHub("attempt-uncertain");
  const h3 = await createE2eHarness(dir3, gh3, { throwOnSubmit: true });
  try {
    const uRes = await h3.controller.processAuthorizedWake({ headSha: HEAD, prNumber: PR_NUMBER, humanLiveSendAuthorized: true });
    assert.equal(uRes.status, "BLOCKED");
    assert.equal(uRes.code, "DELIVERY_UNCERTAIN");
    assert.equal(uRes.journalPhase, "DELIVERY_UNCERTAIN");
    assert.ok(gh3.refs.has(`refs/bke/uncertain/${PR_NUMBER}/attempt-uncertain`));
  } finally {
    h3.close();
    await rm(dir3, { recursive: true, force: true });
  }
});
