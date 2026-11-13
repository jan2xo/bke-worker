/**
 * F1-03 persistent authenticated Chrome Native Host <-> Controller Bridge.
 *
 * Authenticates the extension via P-256 HELLO -> CHALLENGE -> PROOF, emits
 * SESSION_ESTABLISHED, and then serves a serial single-flight controller command
 * loop with replay protection, TTL enforcement, and fail-closed quarantine on
 * mid-dispatch disconnect or protocol violation.
 */
import { createPublicKey, randomBytes, verify, createHash } from "node:crypto";
import { createServer } from "node:net";
import { lstat, mkdir, rm } from "node:fs/promises";
import { dirname } from "node:path";
import { encodeFrame, MAX_FRAME_BYTES, nativeFrameReader } from "./framing.mjs";
import { nativeProofMessage, validNativeHostPolicy } from "./host.mjs";
import {
  CONTROLLER_BRIDGE_MODE,
  CommandReplayGuard,
  validateCommandResult,
} from "./controller-protocol.mjs";

const HASH = /^[0-9a-f]{64}$/u;
const COORD = /^[A-Za-z0-9_-]{43}$/u;
const CONTROLLER_HELLO_KEYS =
  "client_nonce,public_key,resources,session_mode,type,version,worker_id";
const PROOF_KEYS = "client_nonce,device_signature,server_nonce,type,version";
const RESOURCE_KEYS =
  "bridge_identity_sha256,browser_profile_sha256,chatgpt_target_sha256";
const MAX_CLOCK_SKEW = 30_000;

function exact(obj, fields) {
  return (
    obj &&
    typeof obj === "object" &&
    !Array.isArray(obj) &&
    Object.keys(obj).sort().join(",") === fields
  );
}

function isHash(v) {
  return typeof v === "string" && HASH.test(v);
}

function validPublic(x) {
  return (
    exact(x, "crv,kty,x,y") &&
    x.crv === "P-256" &&
    x.kty === "EC" &&
    typeof x.x === "string" &&
    COORD.test(x.x) &&
    typeof x.y === "string" &&
    COORD.test(x.y)
  );
}

function publicThumbprint(jwk) {
  return createHash("sha256")
    .update(JSON.stringify({ crv: "P-256", kty: "EC", x: jwk.x, y: jwk.y }))
    .digest("hex");
}

function validResources(x) {
  return exact(x, RESOURCE_KEYS) && Object.values(x).every(isHash);
}

function sameResources(a, b) {
  return Object.keys(a).length === 3 && RESOURCE_KEYS.split(",").every((k) => a[k] === b[k]);
}

function matchesControllerHello(v, policy) {
  if (
    !exact(v, CONTROLLER_HELLO_KEYS) ||
    v.type !== "HELLO" ||
    v.version !== 1 ||
    v.session_mode !== CONTROLLER_BRIDGE_MODE ||
    v.worker_id !== policy.worker_id ||
    !validPublic(v.public_key) ||
    !validResources(v.resources) ||
    !sameResources(v.resources, policy.resources) ||
    !isHash(v.client_nonce)
  ) {
    return false;
  }
  try {
    createPublicKey({ key: v.public_key, format: "jwk" });
    return publicThumbprint(v.public_key) === policy.public_key_sha256;
  } catch {
    return false;
  }
}

function decodeP1363(s) {
  if (typeof s !== "string" || !/^[A-Za-z0-9_-]{86}$/u.test(s)) return null;
  const bytes = Buffer.from(s, "base64url");
  return bytes.length === 64 && bytes.toString("base64url") === s ? bytes : null;
}

function matchesProof(value, issued, hello, policy, origin, now) {
  if (
    !exact(value, PROOF_KEYS) ||
    value.type !== "PROOF" ||
    value.version !== 1 ||
    value.client_nonce !== hello.client_nonce ||
    value.server_nonce !== issued.server_nonce ||
    now >= issued.expires_at_ms
  ) {
    return false;
  }
  const signature = decodeP1363(value.device_signature);
  if (!signature) return false;
  const message = nativeProofMessage({
    origin,
    worker_id: hello.worker_id,
    public_key_sha256: policy.public_key_sha256,
    profile_binding_sha256: policy.profile_binding_sha256,
    resources: policy.resources,
    client_nonce: hello.client_nonce,
    server_nonce: issued.server_nonce,
    expires_at_ms: issued.expires_at_ms,
  });
  try {
    const key = createPublicKey({ key: hello.public_key, format: "jwk" });
    return verify(
      "sha256",
      Buffer.from(message, "utf8"),
      { key, dsaEncoding: "ieee-p1363" },
      signature,
    );
  } catch {
    return false;
  }
}

async function writeBridgeFrame(stream, value) {
  const frame = encodeFrame(value, MAX_FRAME_BYTES);
  if (!stream.write(frame)) {
    await new Promise((resolve, reject) => {
      stream.once("drain", resolve);
      stream.once("error", reject);
    });
  }
}

async function ensurePrivateSocketDir(socketPath) {
  const parent = dirname(socketPath);
  await mkdir(parent, { recursive: true, mode: 0o700 });
  const info = await lstat(parent);
  if (!info.isDirectory() || info.isSymbolicLink()) {
    throw Error("CONTROLLER_IPC_DIR_UNSAFE");
  }
  if (typeof process.getuid === "function" && info.uid !== process.getuid()) {
    throw Error("CONTROLLER_IPC_DIR_OWNER_INVALID");
  }
  await rm(socketPath, { force: true });
}

export async function runNativeControllerBridge({
  input,
  output,
  policy,
  claimedOrigin,
  now = () => Date.now(),
  nonce = () => randomBytes(32).toString("hex"),
  handshakeTimeoutMs = 15_000,
  ipcSocketPath = null,
  onEstablished = null,
}) {
  const started = now();
  if (
    !validNativeHostPolicy(policy, started) ||
    claimedOrigin !== policy.allowed_origin ||
    !Number.isSafeInteger(handshakeTimeoutMs) ||
    handshakeTimeoutMs < 100 ||
    handshakeTimeoutMs > 15_000
  ) {
    throw Error("NATIVE_POLICY_DENIED");
  }

  const reader = nativeFrameReader(input, MAX_FRAME_BYTES);

  const nextWithTimeout = async (timeoutMs) => {
    let timer = null;
    try {
      return await Promise.race([
        reader.next(),
        new Promise((_, reject) => {
          timer = setTimeout(() => reject(Error("NATIVE_TIMEOUT")), timeoutMs);
          timer.unref?.();
        }),
      ]);
    } finally {
      if (timer !== null) clearTimeout(timer);
    }
  };

  // Persistent controller command session state (initialized before SESSION_ESTABLISHED)
  const guard = new CommandReplayGuard();
  let closed = false;
  let quarantined = false;
  let pending = null; // { command_id, seq, timer, resolve }
  let resolveClosed;
  const closedPromise = new Promise((resolve) => {
    resolveClosed = resolve;
  });
  let ipcServer = null;
  const ipcSockets = new Set();
  let sessionId = "";

  const failPending = (code) => {
    if (!pending) return;
    const active = pending;
    pending = null;
    clearTimeout(active.timer);
    quarantined = true;
    active.resolve({
      type: "COMMAND_RESULT",
      version: 1,
      command_id: active.command_id,
      seq: active.seq,
      ok: false,
      code,
      uncertain: true,
    });
  };

  const shutdown = (reason = "BRIDGE_CLOSED") => {
    if (closed) return;
    closed = true;
    failPending(reason === "BRIDGE_CLOSED" ? "BRIDGE_DISCONNECTED_UNCERTAIN" : reason);
    reader.close();
    for (const s of ipcSockets) {
      try {
        s.destroy();
      } catch {
        // Ignore socket destroy errors.
      }
    }
    ipcSockets.clear();
    if (ipcServer) {
      try {
        ipcServer.close();
      } catch {
        // Ignore close errors.
      }
      if (ipcSocketPath) {
        void rm(ipcSocketPath, { force: true }).catch(() => undefined);
      }
    }
    resolveClosed(reason);
  };

  const dispatchCommand = async (command, timeoutMs = 10_000) => {
    if (closed) {
      return {
        ok: false,
        code: "CONTROLLER_SESSION_CLOSED",
        uncertain: false,
      };
    }
    if (quarantined) {
      return {
        ok: false,
        code: "CONTROLLER_SESSION_QUARANTINED",
        uncertain: true,
      };
    }
    if (pending) {
      return {
        ok: false,
        code: "CONTROLLER_COMMAND_IN_FLIGHT",
        uncertain: false,
      };
    }
    const admitted = guard.admit(command, now());
    if (!admitted.ok) {
      return {
        ok: false,
        code: admitted.code,
        uncertain: false,
      };
    }

    if (now() >= policy.expires_at_ms) {
      quarantined = true;
      shutdown("NATIVE_POLICY_EXPIRED");
      return {
        ok: false,
        code: "NATIVE_POLICY_EXPIRED",
        uncertain: false,
      };
    }

    return new Promise((resolve) => {
      const effectiveTimeout = Number.isSafeInteger(timeoutMs) && timeoutMs >= 50 ? timeoutMs : 10_000;
      const timer = setTimeout(() => {
        if (pending && pending.command_id === command.command_id) {
          pending = null;
          quarantined = true;
          resolve({
            type: "COMMAND_RESULT",
            version: 1,
            command_id: command.command_id,
            seq: command.seq,
            ok: false,
            code: "COMMAND_TIMEOUT_UNCERTAIN",
            uncertain: true,
          });
        }
      }, effectiveTimeout);
      timer.unref?.();

      pending = {
        command_id: command.command_id,
        seq: command.seq,
        timer,
        resolve,
      };

      writeBridgeFrame(output, command)
        .then(() => {
          if (command.action === "HALT" && pending && pending.command_id === command.command_id) {
            const active = pending;
            pending = null;
            clearTimeout(active.timer);
            quarantined = true;
            active.resolve({
              type: "COMMAND_RESULT",
              version: 1,
              command_id: command.command_id,
              seq: command.seq,
              ok: true,
              code: "HALT_ISSUED",
            });
            const t = setTimeout(() => shutdown("CONTROLLER_HALTED"), 15);
            t.unref?.();
          }
        })
        .catch(() => {
          failPending("BRIDGE_WRITE_FAILED_UNCERTAIN");
          shutdown("BRIDGE_WRITE_FAILED");
        });
    });
  };

  // Handshake
  try {
    const hello = await nextWithTimeout(handshakeTimeoutMs);
    if (!matchesControllerHello(hello, policy)) {
      throw Error("NATIVE_HELLO_DENIED");
    }
    const server_nonce = nonce();
    if (!isHash(server_nonce) || server_nonce === hello.client_nonce) {
      throw Error("NATIVE_NONCE_DENIED");
    }
    const moment = now();
    if (moment < started - MAX_CLOCK_SKEW || moment >= policy.expires_at_ms) {
      throw Error("NATIVE_CLOCK_DENIED");
    }
    const expires_at_ms = Math.min(moment + handshakeTimeoutMs, policy.expires_at_ms);
    const issued = {
      type: "CHALLENGE",
      version: 1,
      server_nonce,
      client_nonce: hello.client_nonce,
      expires_at_ms,
      profile_binding_sha256: policy.profile_binding_sha256,
    };
    await writeBridgeFrame(output, issued);

    const proof = await nextWithTimeout(handshakeTimeoutMs);
    if (!matchesProof(proof, issued, hello, policy, claimedOrigin, now())) {
      throw Error("NATIVE_PROOF_DENIED");
    }

    if (typeof ipcSocketPath === "string" && ipcSocketPath.length > 0) {
      await ensurePrivateSocketDir(ipcSocketPath);
      ipcServer = createServer((socket) => {
        ipcSockets.add(socket);
        socket.once("close", () => ipcSockets.delete(socket));
        let buf = "";
        socket.on("data", (chunk) => {
          buf += chunk.toString("utf8");
          let idx;
          while ((idx = buf.indexOf("\n")) >= 0) {
            const line = buf.slice(0, idx).trim();
            buf = buf.slice(idx + 1);
            if (!line) continue;
            let cmd;
            try {
              cmd = JSON.parse(line);
            } catch {
              socket.write(JSON.stringify({ ok: false, code: "IPC_JSON_INVALID" }) + "\n");
              continue;
            }
            void dispatchCommand(cmd).then((res) => {
              if (!socket.destroyed) {
                socket.write(JSON.stringify(res) + "\n");
              }
            });
          }
        });
      });
      await new Promise((resolve, reject) => {
        ipcServer.once("error", reject);
        ipcServer.listen(ipcSocketPath, resolve);
      });
    }

    sessionId = randomBytes(32).toString("hex");
    await writeBridgeFrame(output, {
      type: "SESSION_ESTABLISHED",
      version: 1,
      session_mode: CONTROLLER_BRIDGE_MODE,
      session_id: sessionId,
      worker_id: policy.worker_id,
      public_key_sha256: policy.public_key_sha256,
    });
  } catch (err) {
    shutdown("BRIDGE_HANDSHAKE_FAILED");
    throw err;
  }

  // Pump frames coming from Chrome extension
  const pumpExtensionFrames = (async () => {
    try {
      while (!closed) {
        const frame = await reader.next();
        if (frame.type === "KEEPALIVE_PING" && frame.version === 1 && frame.session_id === sessionId) {
          await writeBridgeFrame(output, {
            type: "KEEPALIVE_PONG",
            version: 1,
            session_id: sessionId,
            at_ms: now(),
          });
          continue;
        }
        if (frame.type === "COMMAND_RESULT") {
          const valid = validateCommandResult(frame);
          if (!valid.ok || !pending || frame.command_id !== pending.command_id || frame.seq !== pending.seq) {
            failPending("BRIDGE_PROTOCOL_MISMATCH_UNCERTAIN");
            shutdown("BRIDGE_PROTOCOL_MISMATCH");
            return;
          }
          const active = pending;
          pending = null;
          clearTimeout(active.timer);
          active.resolve(frame);
          continue;
        }
        // Unexpected unsolicited message breaks trust invariants
        failPending("BRIDGE_UNEXPECTED_FRAME_UNCERTAIN");
        shutdown("BRIDGE_UNEXPECTED_FRAME");
        return;
      }
    } catch {
      shutdown("BRIDGE_DISCONNECTED_UNCERTAIN");
    }
  })();
  void pumpExtensionFrames;

  const session = Object.freeze({
    sessionId,
    workerId: policy.worker_id,
    publicKeySha256: policy.public_key_sha256,
    isClosed: () => closed,
    isQuarantined: () => quarantined,
    dispatchCommand,
    close: () => shutdown("BRIDGE_CLOSED"),
    waitClosed: () => closedPromise,
  });

  if (typeof onEstablished === "function") {
    await onEstablished(session);
  }
  return session;
}
