import test from "node:test";
import assert from "node:assert/strict";
import { webcrypto } from "node:crypto";
import { spawn } from "node:child_process";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { readFileSync } from "node:fs";

import { createDeviceIdentityBridge } from "../dist/device-identity.js";
import { NATIVE_HOST_NAME, proveLocalNativeHost } from "../dist/native-proof-client.js";
import { encodeFrame } from "../native-host/framing.mjs";

const ORIGIN = "chrome-extension://" + "a".repeat(32) + "/";
const PROFILE_BINDING = "4".repeat(64);
const hash = (character) => character.repeat(64);
const resourcePins = () => ({
  chatgpt_target_sha256: hash("1"),
  browser_profile_sha256: hash("2"),
  bridge_identity_sha256: hash("3"),
});
const hostEntry = fileURLToPath(new URL("../native-host/entry.mjs", import.meta.url));

function memoryIdentityStore() {
  let current;
  let tail = Promise.resolve();
  return {
    async atomic(action) {
      let release;
      const next = new Promise((resolve) => { release = resolve; });
      const previous = tail;
      tail = next;
      await previous;
      let draft = current === undefined ? undefined : structuredClone(current);
      try {
        const result = await action({
          get: async () => draft === undefined ? undefined : structuredClone(draft),
          put: async (value) => { draft = structuredClone(value); },
        });
        current = draft;
        return result;
      } finally {
        release();
      }
    },
    inspect: () => current,
  };
}

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), "bke-desktop-native-smoke-"));
  const store = memoryIdentityStore();
  const identity = createDeviceIdentityBridge({
    store,
    cryptoImpl: webcrypto,
    now: () => Date.now(),
  });
  const publicIdentity = await identity.initialize("worker-a");
  assert.equal(publicIdentity.state, "READY", "disposable WebCrypto identity must initialize");
  const policy = {
    version: 1,
    allowed_origin: ORIGIN,
    worker_id: "worker-a",
    public_key_sha256: publicIdentity.public_key_sha256,
    profile_binding_sha256: PROFILE_BINDING,
    resources: resourcePins(),
    expires_at_ms: Date.now() + 60_000,
  };
  const policyPath = join(directory, "owner-policy.json");
  await writeFile(policyPath, JSON.stringify(policy), { mode: 0o600 });
  return { directory, store, identity, publicIdentity, policy, policyPath };
}

function waitForExit(child, timeoutMs = 5_000) {
  if (child.exitCode !== null || child.signalCode !== null) {
    return Promise.resolve({ code: child.exitCode, signal: child.signalCode });
  }
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error("NATIVE_TEST_CHILD_EXIT_TIMEOUT"));
    }, timeoutMs);
    const finish = (code, signal) => {
      clearTimeout(timer);
      resolve({ code, signal });
    };
    child.once("exit", finish);
    child.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
  });
}

function spawnNativeHost(f, options = {}) {
  const child = spawn(
    process.execPath,
    [hostEntry, f.policyPath, options.claimedOrigin ?? ORIGIN],
    {
      stdio: ["pipe", "pipe", "pipe"],
      env: { PATH: process.env.PATH ?? "" },
    },
  );
  const messageListeners = new Set();
  const disconnectListeners = new Set();
  const transcript = { clientMessages: [], sentFrames: [], hostFrames: [], deliveredMessages: [] };
  let buffer = Buffer.alloc(0);
  let disconnected = false;
  let parseFailed = false;
  let stderrBytes = 0;

  child.stdin.on("error", () => { /* Expected for a deliberately terminated child. */ });
  child.stderr.on("data", (chunk) => { stderrBytes += chunk.length; });

  const disconnect = () => {
    if (disconnected) return;
    disconnected = true;
    for (const listener of [...disconnectListeners]) listener();
  };

  child.stdout.on("data", (chunk) => {
    buffer = Buffer.concat([buffer, chunk]);
    while (buffer.length >= 4) {
      const length = buffer.readUInt32LE(0);
      if (length < 1 || length > 4096) {
        parseFailed = true;
        child.kill("SIGTERM");
        disconnect();
        return;
      }
      if (buffer.length < length + 4) break;
      const bytes = buffer.subarray(4, length + 4);
      buffer = buffer.subarray(length + 4);
      let decoded;
      try {
        decoded = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
      } catch {
        parseFailed = true;
        child.kill("SIGTERM");
        disconnect();
        return;
      }
      if (decoded === null || typeof decoded !== "object" || Array.isArray(decoded)) {
        parseFailed = true;
        child.kill("SIGTERM");
        disconnect();
        return;
      }
      transcript.hostFrames.push(decoded);

      if (options.killAtChallenge && decoded.type === "CHALLENGE") {
        child.kill("SIGTERM");
        return;
      }

      const delivered = options.transformIncoming ? options.transformIncoming(decoded) : decoded;
      if (delivered !== undefined && delivered !== null) {
        transcript.deliveredMessages.push(delivered);
        for (const listener of [...messageListeners]) listener(delivered);
      }
    }
  });
  child.once("exit", disconnect);
  child.once("error", disconnect);
  child.stdout.once("end", disconnect);

  const port = {
    postMessage(message) {
      if (child.exitCode !== null || child.signalCode !== null ||
          child.stdin.destroyed || child.stdin.writableEnded) {
        throw new Error("NATIVE_TEST_HOST_ALREADY_EXITED");
      }
      transcript.clientMessages.push(message);
      const sent = options.transformOutgoing ? options.transformOutgoing(message, transcript) : message;
      transcript.sentFrames.push(sent);
      const frame = encodeFrame(sent);
      if (options.duplicateHello && message.type === "HELLO") {
        child.stdin.write(Buffer.concat([frame, encodeFrame(sent)]));
      } else {
        child.stdin.write(frame);
      }
    },
    disconnect() {
      if (!child.stdin.destroyed && !child.stdin.writableEnded) child.stdin.end();
    },
    onMessage: {
      addListener(listener) { messageListeners.add(listener); },
      removeListener(listener) { messageListeners.delete(listener); },
    },
    onDisconnect: {
      addListener(listener) { disconnectListeners.add(listener); },
      removeListener(listener) { disconnectListeners.delete(listener); },
    },
  };

  return {
    child,
    port,
    transcript,
    get parseFailed() { return parseFailed; },
    get stderrBytes() { return stderrBytes; },
    kill() { if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM"); },
  };
}

async function executeClient(f, options = {}) {
  let host = null;
  let connectCount = 0;
  const runtime = {
    getURL: () => options.runtimeOrigin ?? ORIGIN,
    connectNative(name) {
      connectCount += 1;
      assert.equal(name, NATIVE_HOST_NAME);
      host = spawnNativeHost(f, options.host ?? {});
      return host.port;
    },
  };
  const result = await proveLocalNativeHost({
    runtime,
    identity: f.identity,
    workerId: "worker-a",
    resources: resourcePins(),
    profileBindingSha256: PROFILE_BINDING,
    cryptoImpl: webcrypto,
    clock: () => Date.now(),
    timeoutMs: 3_500,
  });
  return { result, host, connectCount };
}

async function closeFixture(f, host = null) {
  try {
    host?.kill();
    if (host) {
      try { await waitForExit(host.child, 1_000); } catch { /* Cleanup remains best effort. */ }
    }
  } finally {
    await rm(f.directory, { recursive: true, force: true });
  }
}

test("real Node host subprocess completes the TypeScript P-256 challenge-response", { timeout: 15_000 }, async () => {
  const f = await fixture();
  let host;
  try {
    const run = await executeClient(f);
    host = run.host;
    assert.equal(run.connectCount, 1);
    assert.equal(run.result.state, "LOCAL_PROOF_OK", JSON.stringify(run.result));
    assert.equal(run.result.worker_id, "worker-a");
    assert.equal(run.result.public_key_sha256, f.publicIdentity.public_key_sha256);
    assert.equal(run.result.admission_authority, "NONE");
    assert.equal(run.result.dispatch_authority, "NONE");
    assert.deepEqual(host.transcript.clientMessages.map((message) => message.type), ["HELLO", "PROOF"]);
    assert.deepEqual(host.transcript.hostFrames.map((message) => message.type), ["CHALLENGE", "LOCAL_PROOF_OK"]);
    assert.equal(host.parseFailed, false);
    const exit = await waitForExit(host.child);
    assert.deepEqual(exit, { code: 0, signal: null });
    assert.equal(f.store.inspect().private_key.extractable, false);
    assert.doesNotMatch(JSON.stringify(run.result), /private_key|token|credential|installation/i);
  } finally {
    await closeFixture(f, host);
  }
});

test("invalid WebExtension origin is refused before native connection", { timeout: 10_000 }, async () => {
  const f = await fixture();
  try {
    const run = await executeClient(f, { runtimeOrigin: "https://chatgpt.com/" });
    assert.equal(run.result.state, "BLOCKED");
    assert.equal(run.result.code, "NATIVE_CLIENT_EXTENSION_ORIGIN_INVALID");
    assert.equal(run.connectCount, 0);
    assert.equal(run.host, null);
  } finally {
    await closeFixture(f);
  }
});

test("native executable independently rejects a forged launch-origin argument", { timeout: 10_000 }, async () => {
  const f = await fixture();
  let host;
  try {
    const run = await executeClient(f, {
      host: { claimedOrigin: "chrome-extension://" + "b".repeat(32) + "/" },
    });
    host = run.host;
    assert.equal(run.result.state, "BLOCKED");
    assert.equal(run.result.code, "NATIVE_CLIENT_OUTCOME_UNCERTAIN");
    assert.deepEqual(host.transcript.hostFrames, []);
    const exit = await waitForExit(host.child);
    assert.equal(exit.code, 1);
    assert.equal(host.parseFailed, false);
  } finally {
    await closeFixture(f, host);
  }
});

test("tampered host challenge is rejected before the private identity signs", { timeout: 10_000 }, async () => {
  const f = await fixture();
  let host;
  try {
    const run = await executeClient(f, {
      host: {
        transformIncoming(message) {
          if (message.type === "CHALLENGE") return { ...message, profile_binding_sha256: hash("f") };
          return message;
        },
      },
    });
    host = run.host;
    assert.equal(run.result.state, "BLOCKED");
    assert.equal(run.result.code, "NATIVE_CLIENT_CHALLENGE_DENIED");
    assert.deepEqual(host.transcript.clientMessages.map((message) => message.type), ["HELLO"]);
    assert.equal(f.store.inspect().used.length, 0);
    await waitForExit(host.child);
    assert.equal(host.transcript.hostFrames.some((message) => message.type === "LOCAL_PROOF_OK"), false);
  } finally {
    await closeFixture(f, host);
  }
});

test("tampered device signature is denied by the real host subprocess", { timeout: 10_000 }, async () => {
  const f = await fixture();
  let host;
  try {
    const run = await executeClient(f, {
      host: {
        transformOutgoing(message) {
          if (message.type === "PROOF") return { ...message, device_signature: "A".repeat(86) };
          return message;
        },
      },
    });
    host = run.host;
    assert.equal(run.result.state, "BLOCKED");
    assert.equal(run.result.code, "NATIVE_CLIENT_OUTCOME_UNCERTAIN");
    const exit = await waitForExit(host.child);
    assert.equal(exit.code, 1);
    assert.deepEqual(host.transcript.hostFrames.map((message) => message.type), ["CHALLENGE"]);
  } finally {
    await closeFixture(f, host);
  }
});

test("a valid proof captured from another process session cannot be replayed", { timeout: 15_000 }, async () => {
  const f = await fixture();
  let firstHost;
  let secondHost;
  try {
    const first = await executeClient(f);
    firstHost = first.host;
    assert.equal(first.result.state, "LOCAL_PROOF_OK");
    const oldProof = firstHost.transcript.sentFrames.find((message) => message.type === "PROOF");
    assert.ok(oldProof, "the first process must emit one proof");
    await waitForExit(firstHost.child);

    const second = await executeClient(f, {
      host: {
        transformOutgoing(message) { return message.type === "PROOF" ? oldProof : message; },
      },
    });
    secondHost = second.host;
    assert.equal(second.result.state, "BLOCKED");
    assert.equal(second.result.code, "NATIVE_CLIENT_OUTCOME_UNCERTAIN");
    const exit = await waitForExit(secondHost.child);
    assert.equal(exit.code, 1);
    assert.equal(secondHost.transcript.hostFrames.some((message) => message.type === "LOCAL_PROOF_OK"), false);
  } finally {
    await closeFixture(f, firstHost);
    if (secondHost) {
      try { await waitForExit(secondHost.child, 1_000); } catch { secondHost.kill(); }
    }
  }
});

test("duplicate HELLO delivery is rejected rather than opening a second host session", { timeout: 10_000 }, async () => {
  const f = await fixture();
  let host;
  try {
    const run = await executeClient(f, { host: { duplicateHello: true } });
    host = run.host;
    assert.equal(run.result.state, "BLOCKED");
    assert.equal(run.result.code, "NATIVE_CLIENT_OUTCOME_UNCERTAIN");
    const exit = await waitForExit(host.child);
    assert.equal(exit.code, 1);
    assert.equal(host.transcript.hostFrames.some((message) => message.type === "LOCAL_PROOF_OK"), false);
  } finally {
    await closeFixture(f, host);
  }
});

test("disconnect during the challenge fails closed without a receipt", { timeout: 10_000 }, async () => {
  const f = await fixture();
  let host;
  try {
    const run = await executeClient(f, { host: { killAtChallenge: true } });
    host = run.host;
    assert.equal(run.result.state, "BLOCKED");
    assert.equal(run.result.code, "NATIVE_CLIENT_OUTCOME_UNCERTAIN");
    const exit = await waitForExit(host.child);
    assert.notEqual(exit.code, 0);
    assert.equal(host.transcript.hostFrames.some((message) => message.type === "LOCAL_PROOF_OK"), false);
  } finally {
    await closeFixture(f, host);
  }
});

test("the smoke remains source-only and exposes no Chrome permission or authority", () => {
  const extensionRoot = fileURLToPath(new URL("../", import.meta.url));
  const manifest = JSON.parse(readFileSync(join(extensionRoot, "manifest.json"), "utf8"));
  const serviceWorker = readFileSync(join(extensionRoot, "src/service-worker.ts"), "utf8");
  const popup = readFileSync(join(extensionRoot, "src/popup.ts"), "utf8");
  const client = readFileSync(join(extensionRoot, "src/native-proof-client.ts"), "utf8");
  assert.deepEqual(manifest.permissions, ["storage"]);
  assert.deepEqual(manifest.optional_permissions, ["nativeMessaging"]);
  assert.equal(JSON.stringify(manifest).includes("debugger"), false);
  assert.match(serviceWorker, /nativeProofAction/);
  assert.match(serviceWorker, /isTrustedPopup/);
  assert.match(popup, /permissions.request/);
  assert.match(client, /admission_authority:"NONE"/);
  assert.match(client, /dispatch_authority:"NONE"/);
});
