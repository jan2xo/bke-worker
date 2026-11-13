import test from "node:test";
import assert from "node:assert/strict";
import { PassThrough } from "node:stream";
import { spawn } from "node:child_process";
import { connect as connectNet } from "node:net";
import { generateKeyPairSync, createHash, sign } from "node:crypto";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { encodeFrame, nativeFrameReader } from "../framing.mjs";
import { nativeProofMessage } from "../host.mjs";
import { runNativeControllerBridge } from "../controller-host.mjs";
import {
  CONTROLLER_BRIDGE_MODE,
  CommandReplayGuard,
  validateControllerCommand,
} from "../controller-protocol.mjs";

const ORIGIN = "chrome-extension://" + "a".repeat(32) + "/";
const H = (c) => c.repeat(64);
const SHA40 = "a".repeat(40);
const RESOURCES = {
  chatgpt_target_sha256: H("1"),
  browser_profile_sha256: H("2"),
  bridge_identity_sha256: H("3"),
};

function makeIdentity() {
  const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  const jwk = publicKey.export({ format: "jwk" });
  const pubJwk = { crv: "P-256", kty: "EC", x: jwk.x, y: jwk.y };
  const keyHash = createHash("sha256").update(JSON.stringify(pubJwk)).digest("hex");
  return { privateKey, public_key: pubJwk, keyHash };
}

function makeFixture(nowMs = Date.now()) {
  const key = makeIdentity();
  const policy = {
    version: 1,
    allowed_origin: ORIGIN,
    worker_id: "worker-f1",
    public_key_sha256: key.keyHash,
    profile_binding_sha256: H("4"),
    resources: RESOURCES,
    expires_at_ms: nowMs + 120_000,
  };
  const hello = {
    type: "HELLO",
    version: 1,
    session_mode: CONTROLLER_BRIDGE_MODE,
    worker_id: "worker-f1",
    public_key: key.public_key,
    resources: RESOURCES,
    client_nonce: H("5"),
  };
  return { key, policy, hello };
}

function signChallenge(f, challenge) {
  const payload = nativeProofMessage({
    origin: ORIGIN,
    worker_id: f.hello.worker_id,
    public_key_sha256: f.policy.public_key_sha256,
    profile_binding_sha256: f.policy.profile_binding_sha256,
    resources: f.policy.resources,
    client_nonce: f.hello.client_nonce,
    server_nonce: challenge.server_nonce,
    expires_at_ms: challenge.expires_at_ms,
  });
  return {
    type: "PROOF",
    version: 1,
    client_nonce: f.hello.client_nonce,
    server_nonce: challenge.server_nonce,
    device_signature: sign("sha256", Buffer.from(payload), {
      key: f.key.privateKey,
      dsaEncoding: "ieee-p1363",
    }).toString("base64url"),
  };
}

test("CommandReplayGuard enforces allowlist, TTL bounds, monotonic seq, and command_id dedupe", () => {
  const now = 1_790_000_000_000;
  const guard = new CommandReplayGuard();
  const basePing = {
    type: "COMMAND",
    version: 1,
    command_id: "cmd-ping-0001",
    seq: 1,
    issued_at_ms: now,
    ttl_ms: 5_000,
    action: "PING",
  };
  assert.equal(guard.admit(basePing, now + 100).ok, true);
  // Same command_id or same seq fails
  assert.equal(guard.admit({ ...basePing, command_id: "cmd-ping-0002" }, now + 150).code, "COMMAND_SEQ_REPLAY");
  assert.equal(guard.admit({ ...basePing, seq: 2 }, now + 150).code, "COMMAND_ID_REPLAY");
  // Expired TTL fails
  assert.equal(validateControllerCommand(basePing, now + 5_000).code, "COMMAND_EXPIRED");
  // Forbidden action fails
  assert.equal(
    validateControllerCommand({ ...basePing, seq: 3, command_id: "cmd-bad-0003", action: "SCRAPE_REPLY" }, now).code,
    "COMMAND_ACTION_FORBIDDEN",
  );
});

test("runNativeControllerBridge establishes session, dispatches commands, and quarantines mid-flight disconnect", async () => {
  const now = 1_790_000_000_000;
  const f = makeFixture(now);
  const input = new PassThrough();
  const output = new PassThrough();
  const reader = nativeFrameReader(output);

  let sessionRef;
  const bridgePromise = runNativeControllerBridge({
    input,
    output,
    policy: f.policy,
    claimedOrigin: ORIGIN,
    now: () => now,
    onEstablished(s) {
      sessionRef = s;
    },
  });

  input.write(encodeFrame(f.hello));
  const challenge = await reader.next();
  assert.equal(challenge.type, "CHALLENGE");
  input.write(encodeFrame(signChallenge(f, challenge)));
  const established = await reader.next();
  assert.equal(established.type, "SESSION_ESTABLISHED");
  assert.equal(established.session_mode, CONTROLLER_BRIDGE_MODE);

  const session = await bridgePromise;
  assert.equal(session, sessionRef);

  // Dispatch PING and reply as extension
  const cmd = {
    type: "COMMAND",
    version: 1,
    command_id: "cmd-status-0001",
    seq: 1,
    issued_at_ms: now,
    ttl_ms: 5_000,
    action: "GET_TARGET_STATUS",
  };
  const pendingRes = session.dispatchCommand(cmd);
  const forwarded = await reader.next();
  assert.equal(forwarded.command_id, "cmd-status-0001");
  input.write(
    encodeFrame({
      type: "COMMAND_RESULT",
      version: 1,
      command_id: "cmd-status-0001",
      seq: 1,
      ok: true,
      code: "TARGET_READY",
      payload: { uiState: "NEW_CHAT_LANDING" },
    }),
  );
  const res = await pendingRes;
  assert.equal(res.ok, true);
  assert.equal(res.code, "TARGET_READY");

  // Replay same seq refused locally without sending frame
  const replayRes = await session.dispatchCommand({ ...cmd, command_id: "cmd-status-0002", seq: 1 });
  assert.equal(replayRes.ok, false);
  assert.equal(replayRes.code, "COMMAND_SEQ_REPLAY");

  // Mid-flight disconnect during DISPATCH fails closed with uncertain=true
  const dispatchCmd = {
    type: "COMMAND",
    version: 1,
    command_id: "cmd-dispatch-0002",
    seq: 2,
    issued_at_ms: now,
    ttl_ms: 5_000,
    action: "DISPATCH_FIRST_MESSAGE",
    pr_number: 125,
    head_sha: SHA40,
    attempt_id: "attempt-1",
    fence_id: "fence-attempt-1",
    claim_id: "claim-attempt-1",
    target_id: "target-01",
    profile_id: "profile-01",
    target_tab_id: 7,
    prompt: "Execute turn 1",
  };
  const midFlightPromise = session.dispatchCommand(dispatchCmd);
  await reader.next();
  input.end(); // simulate Chrome extension disconnect mid-dispatch
  const midFlightOutcome = await midFlightPromise;
  assert.equal(midFlightOutcome.ok, false);
  assert.equal(midFlightOutcome.uncertain, true);
  assert.equal(session.isQuarantined(), true);
});

test("real entry.mjs child process runs controller-bridge mode over Unix IPC socket", async () => {
  const now = Date.now();
  const f = makeFixture(now);
  const dir = await mkdtemp(join(tmpdir(), "bke-controller-bridge-ipc-"));
  const policyPath = join(dir, "policy.json");
  const sockPath = join(dir, "bridge.sock");
  const entryPath = fileURLToPath(new URL("../entry.mjs", import.meta.url));

  let child;
  let clientSock;
  try {
    await writeFile(policyPath, JSON.stringify(f.policy), { mode: 0o600 });
    child = spawn(process.execPath, [entryPath, "--controller-bridge", policyPath, ORIGIN, sockPath], {
      stdio: ["pipe", "pipe", "pipe"],
      env: { PATH: process.env.PATH ?? "" },
    });
    const outReader = nativeFrameReader(child.stdout);
    child.stdin.write(encodeFrame(f.hello));
    const challenge = await outReader.next();
    child.stdin.write(encodeFrame(signChallenge(f, challenge)));
    const established = await outReader.next();
    assert.equal(established.type, "SESSION_ESTABLISHED");

    // Connect local controller via IPC Unix socket
    clientSock = await new Promise((resolve, reject) => {
      const s = connectNet(sockPath, () => resolve(s));
      s.once("error", reject);
    });

    const sendIpc = (cmd) =>
      new Promise((resolve) => {
        let buf = "";
        const onData = (chunk) => {
          buf += chunk.toString("utf8");
          const idx = buf.indexOf("\n");
          if (idx >= 0) {
            clientSock.off("data", onData);
            resolve(JSON.parse(buf.slice(0, idx)));
          }
        };
        clientSock.on("data", onData);
        clientSock.write(JSON.stringify(cmd) + "\n");
      });

    // Bridge extension side responds to PING
    const pingPromise = sendIpc({
      type: "COMMAND",
      version: 1,
      command_id: "cmd-ipc-ping-01",
      seq: 1,
      issued_at_ms: Date.now(),
      ttl_ms: 5_000,
      action: "PING",
    });
    const extReceived = await outReader.next();
    assert.equal(extReceived.action, "PING");
    child.stdin.write(
      encodeFrame({
        type: "COMMAND_RESULT",
        version: 1,
        command_id: "cmd-ipc-ping-01",
        seq: 1,
        ok: true,
        code: "PONG",
      }),
    );
    const ipcRes = await pingPromise;
    assert.equal(ipcRes.ok, true);
    assert.equal(ipcRes.code, "PONG");

    // Send HALT to gracefully terminate
    const haltRes = await sendIpc({
      type: "COMMAND",
      version: 1,
      command_id: "cmd-ipc-halt-02",
      seq: 2,
      issued_at_ms: Date.now(),
      ttl_ms: 5_000,
      action: "HALT",
      reason: "test complete",
    });
    assert.equal(haltRes.ok, true);
    assert.equal(haltRes.code, "HALT_ISSUED");

    child.stdin.end();
    await new Promise((resolve) => child.once("exit", resolve));
  } finally {
    clientSock?.destroy();
    if (child && child.exitCode === null) child.kill("SIGTERM");
    await rm(dir, { recursive: true, force: true });
  }
});
