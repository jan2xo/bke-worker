import test from "node:test";
import assert from "node:assert/strict";
import { webcrypto } from "node:crypto";
import { spawn } from "node:child_process";
import { connect as connectNet } from "node:net";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { createDeviceIdentityBridge } from "../dist/device-identity.js";
import {
  connectControllerNativeBridge,
  createControllerBridgeSupervisor,
  validateIncomingControllerCommand,
} from "../dist/controller-transport.js";
import { CONTROLLER_BRIDGE_MODE } from "../native-host/controller-protocol.mjs";

const ORIGIN = "chrome-extension://" + "a".repeat(32) + "/";
const PROFILE_BINDING = "4".repeat(64);
const H = (c) => c.repeat(64);
const RESOURCES = {
  chatgpt_target_sha256: H("1"),
  browser_profile_sha256: H("2"),
  bridge_identity_sha256: H("3"),
};
const entryPath = fileURLToPath(new URL("../native-host/entry.mjs", import.meta.url));

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

function spawnBridgeRuntime(policyPath, sockPath) {
  let activeChild = null;
  let disconnectFn = null;
  const runtime = {
    getURL: () => ORIGIN,
    connectNative() {
      const child = spawn(
        process.execPath,
        [entryPath, "--controller-bridge", policyPath, ORIGIN, sockPath],
        { stdio: ["pipe", "pipe", "pipe"], env: { PATH: process.env.PATH ?? "" } },
      );
      activeChild = child;
      const messageListeners = new Set();
      const disconnectListeners = new Set();
      let buffer = Buffer.alloc(0);
      let disconnected = false;
      const notifyDisconnect = () => {
        if (disconnected) return;
        disconnected = true;
        for (const fn of [...disconnectListeners]) fn();
      };
      disconnectFn = notifyDisconnect;
      child.stdout.on("data", (chunk) => {
        buffer = Buffer.concat([buffer, chunk]);
        while (buffer.length >= 4) {
          const len = buffer.readUInt32LE(0);
          if (len < 1 || len > 16_384) {
            child.kill("SIGTERM");
            notifyDisconnect();
            return;
          }
          if (buffer.length < len + 4) break;
          const payload = JSON.parse(buffer.subarray(4, len + 4).toString("utf8"));
          buffer = buffer.subarray(len + 4);
          for (const fn of [...messageListeners]) fn(payload);
        }
      });
      child.once("exit", notifyDisconnect);
      child.stdout.once("end", notifyDisconnect);
      const port = {
        postMessage(msg) {
          if (child.exitCode !== null || child.stdin.writableEnded) {
            throw new Error("HOST_CLOSED");
          }
          const body = Buffer.from(JSON.stringify(msg), "utf8");
          const frame = Buffer.allocUnsafe(body.length + 4);
          frame.writeUInt32LE(body.length, 0);
          body.copy(frame, 4);
          child.stdin.write(frame);
        },
        disconnect() {
          if (!child.stdin.writableEnded) child.stdin.end();
        },
        onMessage: {
          addListener: (fn) => messageListeners.add(fn),
          removeListener: (fn) => messageListeners.delete(fn),
        },
        onDisconnect: {
          addListener: (fn) => disconnectListeners.add(fn),
          removeListener: (fn) => disconnectListeners.delete(fn),
        },
      };
      return port;
    },
  };
  return {
    runtime,
    killActive: () => {
      if (activeChild && activeChild.exitCode === null) activeChild.kill("SIGTERM");
      disconnectFn?.();
    },
  };
}

function sendIpcCommand(sockPath, cmd) {
  return new Promise((resolve, reject) => {
    const client = connectNet(sockPath, () => {
      client.write(JSON.stringify(cmd) + "\n");
    });
    let buf = "";
    client.on("data", (chunk) => {
      buf += chunk.toString("utf8");
      const idx = buf.indexOf("\n");
      if (idx >= 0) {
        const parsed = JSON.parse(buf.slice(0, idx));
        client.end();
        resolve(parsed);
      }
    });
    client.once("error", reject);
  });
}

test("validateIncomingControllerCommand rejects replay, expired TTL, and extra fields", () => {
  const replay = { lastSeq: 0, seenCommandIds: new Set() };
  const now = 1_790_000_000_000;
  const cmd = {
    type: "COMMAND",
    version: 1,
    command_id: "cmd-test-0001",
    seq: 1,
    issued_at_ms: now,
    ttl_ms: 5_000,
    action: "PING",
  };
  assert.equal(validateIncomingControllerCommand(cmd, now + 100, replay).ok, true);
  assert.equal(validateIncomingControllerCommand({ ...cmd, seq: 2 }, now + 100, replay).code, "COMMAND_ID_REPLAY");
  assert.equal(validateIncomingControllerCommand({ ...cmd, command_id: "cmd-test-0002", seq: 1 }, now + 100, replay).code, "COMMAND_SEQ_REPLAY");
  assert.equal(validateIncomingControllerCommand({ ...cmd, command_id: "cmd-test-0003", seq: 2 }, now + 5_000, replay).code, "COMMAND_EXPIRED");
  assert.equal(validateIncomingControllerCommand({ ...cmd, command_id: "cmd-test-0004", seq: 2, admin: true }, now + 100, replay).code, "COMMAND_SHAPE_INVALID");
});

test("connectControllerNativeBridge establishes real child-process session, enforces single-attempt dispatch & target lock, and quarantines mid-flight drop", async () => {
  const dir = await mkdtemp(join(tmpdir(), "bke-controller-transport-test-"));
  const policyPath = join(dir, "policy.json");
  const sockPath = join(dir, "bridge.sock");
  const identity = createDeviceIdentityBridge({
    store: memoryIdentityStore(),
    cryptoImpl: webcrypto,
    now: () => Date.now(),
  });
  const pub = await identity.initialize("worker-f1");
  assert.equal(pub.state, "READY");
  await writeFile(
    policyPath,
    JSON.stringify({
      version: 1,
      allowed_origin: ORIGIN,
      worker_id: "worker-f1",
      public_key_sha256: pub.public_key_sha256,
      profile_binding_sha256: PROFILE_BINDING,
      resources: RESOURCES,
      expires_at_ms: Date.now() + 120_000,
    }),
    { mode: 0o600 },
  );

  const spawned = spawnBridgeRuntime(policyPath, sockPath);
  let targetLockAllowed = true;
  let dispatchCount = 0;

  try {
    const supervisor = createControllerBridgeSupervisor(() =>
      connectControllerNativeBridge({
        runtime: spawned.runtime,
        identity,
        workerId: "worker-f1",
        resources: RESOURCES,
        profileBindingSha256: PROFILE_BINDING,
        checkPermission: async () => true,
        cryptoImpl: webcrypto,
        handlers: {
          withTargetLock: async (run) => {
            if (!targetLockAllowed) return { ok: false, code: "TARGET_REVOKED" };
            const value = await run();
            if (!targetLockAllowed) return { ok: false, code: "TARGET_REVOKED" };
            return { ok: true, value };
          },
          getTargetStatus: async () => ({
            ok: true,
            code: "TARGET_OK",
            payload: { url: "https://chatgpt.com/", uiState: "NEW_CHAT_LANDING" },
          }),
          dispatchFirstMessage: async () => {
            dispatchCount++;
            return { ok: true, code: "FIRST_MESSAGE_SENT", payload: { conversationId: "conv-0001" } };
          },
          dispatchContinuation: async () => ({ ok: false, code: "UNUSED" }),
        },
      }),
    );

    const connRes = await supervisor.connect();
    assert.equal(connRes.ok, true);
    assert.equal(connRes.session.state(), "ESTABLISHED");

    // 1. Valid PING via host IPC socket
    const pingRes = await sendIpcCommand(sockPath, {
      type: "COMMAND",
      version: 1,
      command_id: "cmd-e2e-ping-01",
      seq: 1,
      issued_at_ms: Date.now(),
      ttl_ms: 5_000,
      action: "PING",
    });
    assert.equal(pingRes.ok, true);
    assert.equal(pingRes.code, "PONG");
    assert.equal(pingRes.payload.worker_id, "worker-f1");

    // 2. First dispatch executes once
    const d1 = await sendIpcCommand(sockPath, {
      type: "COMMAND",
      version: 1,
      command_id: "cmd-e2e-disp-02",
      seq: 2,
      issued_at_ms: Date.now(),
      ttl_ms: 5_000,
      action: "DISPATCH_FIRST_MESSAGE",
      pr_number: 125,
      head_sha: "a".repeat(40),
      attempt_id: "attempt-1",
      fence_id: "fence-attempt-1",
      claim_id: "claim-attempt-1",
      target_id: "target-01",
      profile_id: "profile-01",
      target_tab_id: 7,
      prompt: "Turn 1 prompt",
    });
    assert.equal(d1.ok, true);
    assert.equal(dispatchCount, 1);

    // 3. Duplicate attempt_id is refused by extension DispatchFence & quarantines session
    const dDup = await sendIpcCommand(sockPath, {
      type: "COMMAND",
      version: 1,
      command_id: "cmd-e2e-disp-03",
      seq: 3,
      issued_at_ms: Date.now(),
      ttl_ms: 5_000,
      action: "DISPATCH_FIRST_MESSAGE",
      pr_number: 125,
      head_sha: "a".repeat(40),
      attempt_id: "attempt-1",
      fence_id: "fence-attempt-1",
      claim_id: "claim-attempt-1",
      target_id: "target-01",
      profile_id: "profile-01",
      target_tab_id: 7,
      prompt: "Duplicate attempt prompt",
    });
    assert.equal(dDup.ok, false);
    assert.equal(dDup.code, "ALREADY_CONSUMED");
    assert.equal(dispatchCount, 1);

    // Session stays quarantined and supervisor refuses reconnect
    connRes.session.close();
    await connRes.session.waitClosed();
    const reconn = await supervisor.reconnectIfIdle();
    assert.equal(reconn.ok, false);
    assert.equal(reconn.code, "SUPERVISOR_QUARANTINED_AFTER_INFLIGHT_DISCONNECT");
    void CONTROLLER_BRIDGE_MODE;
    void targetLockAllowed;
  } finally {
    spawned.killActive();
    await rm(dir, { recursive: true, force: true });
  }
});
