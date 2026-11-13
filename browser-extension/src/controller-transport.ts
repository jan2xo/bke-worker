/**
 * F1-03 MV3 service-worker <-> authenticated Chrome Native Host controller transport.
 *
 * Establishes a P-256 authenticated persistent session (`CONTROLLER_BRIDGE_V1`),
 * enforces strict command allowlist/TTL/seq/command_id replay protection,
 * gates every browser operation on live target observation & single-use dispatch
 * fencing, and fails closed into irreversible uncertainty quarantine if the port
 * disconnects mid-dispatch.
 */
import type { createDeviceIdentityBridge, NativeProofChallenge } from "./device-identity.js";
import { DispatchFence, type ConsumedAttemptRegistry } from "./dispatch-fence.js";
import { NATIVE_HOST_NAME } from "./native-proof-client.js";

export const CONTROLLER_BRIDGE_MODE = "CONTROLLER_BRIDGE_V1" as const;
const PROTOCOL_VERSION = 1 as const;
const HASH = /^[a-f0-9]{64}$/;
const SHA40 = /^[a-f0-9]{40}$/;
const ORIGIN = /^chrome-extension:\/\/[a-p]{32}\/$/;
const COMMAND_ID = /^[A-Za-z0-9_-]{8,128}$/;
const ATTEMPT_ID = /^[a-z0-9][a-z0-9-]{0,95}$/;
const IDENTIFIER = /^[A-Za-z0-9_-]{8,128}$/;
const WORKER_ID = /^[a-z0-9][a-z0-9-]{0,62}$/;
const MIN_TTL_MS = 100;
const MAX_TTL_MS = 60_000;
const MAX_CLOCK_SKEW_MS = 5_000;
const MAX_PROMPT_CHARS = 2_048;

const RESOURCE_KEYS = [
  "chatgpt_target_sha256",
  "browser_profile_sha256",
  "bridge_identity_sha256",
] as const;
const CHALLENGE_KEYS = [
  "client_nonce",
  "expires_at_ms",
  "profile_binding_sha256",
  "server_nonce",
  "type",
  "version",
] as const;
const ESTABLISHED_KEYS = [
  "public_key_sha256",
  "session_id",
  "session_mode",
  "type",
  "version",
  "worker_id",
] as const;

const ACTION_KEYS: Record<string, string> = {
  PING: "action,command_id,issued_at_ms,seq,ttl_ms,type,version",
  GET_TARGET_STATUS: "action,command_id,issued_at_ms,seq,ttl_ms,type,version",
  PREPARE_FIRST_MESSAGE:
    "action,attempt_id,command_id,fence_id,head_sha,issued_at_ms,pr_number,profile_id,seq,target_id,target_tab_id,ttl_ms,type,version",
  DISPATCH_FIRST_MESSAGE:
    "action,attempt_id,claim_id,command_id,fence_id,head_sha,issued_at_ms,pr_number,profile_id,prompt,seq,target_id,target_tab_id,ttl_ms,type,version",
  PREPARE_CONTINUATION:
    "action,attempt_id,command_id,expected_conversation_id,expected_turn_number,fence_id,head_sha,issued_at_ms,pr_number,profile_id,seq,target_id,target_tab_id,ttl_ms,type,version",
  DISPATCH_CONTINUATION:
    "action,attempt_id,claim_id,command_id,expected_conversation_id,expected_turn_number,fence_id,head_sha,issued_at_ms,pr_number,profile_id,prompt,seq,target_id,target_tab_id,ttl_ms,type,version",
  HALT: "action,command_id,issued_at_ms,reason,seq,ttl_ms,type,version",
};

export type ControllerCommandAction =
  | "PING"
  | "GET_TARGET_STATUS"
  | "PREPARE_FIRST_MESSAGE"
  | "DISPATCH_FIRST_MESSAGE"
  | "PREPARE_CONTINUATION"
  | "DISPATCH_CONTINUATION"
  | "HALT";

export interface ControllerBridgeCommandBase {
  type: "COMMAND";
  version: 1;
  command_id: string;
  seq: number;
  issued_at_ms: number;
  ttl_ms: number;
  action: ControllerCommandAction;
}

export type ControllerBridgeCommand = ControllerBridgeCommandBase & Record<string, unknown>;

export interface ControllerCommandResult {
  type: "COMMAND_RESULT";
  version: 1;
  command_id: string;
  seq: number;
  ok: boolean;
  code: string;
  payload?: Record<string, unknown>;
}

export type ResourcePins = {
  chatgpt_target_sha256: string;
  browser_profile_sha256: string;
  bridge_identity_sha256: string;
};

type DeviceIdentity = ReturnType<typeof createDeviceIdentityBridge>;
type Listener = (message: unknown) => void;
type DisconnectListener = () => void;

export type NativePort = {
  postMessage(message: unknown): void;
  disconnect(): void;
  onMessage: { addListener(fn: Listener): void; removeListener(fn: Listener): void };
  onDisconnect: { addListener(fn: DisconnectListener): void; removeListener(fn: DisconnectListener): void };
};

export type NativeRuntime = {
  getURL(path: string): string;
  connectNative(name: string): NativePort;
};

export interface ClientReplayState {
  lastSeq: number;
  seenCommandIds: Set<string>;
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

function exact(v: unknown, keys: readonly string[]): v is Record<string, unknown> {
  return (
    isPlainObject(v) &&
    Object.keys(v).sort().join(",") === [...keys].sort().join(",")
  );
}

function resourceShape(v: unknown): v is ResourcePins {
  return (
    exact(v, RESOURCE_KEYS) &&
    RESOURCE_KEYS.every((k) => typeof v[k] === "string" && HASH.test(v[k]))
  );
}

function freshTime(clock: () => number): number | null {
  try {
    const at = clock();
    return Number.isSafeInteger(at) && at > 0 && at < Number.MAX_SAFE_INTEGER - 65_000
      ? at
      : null;
  } catch {
    return null;
  }
}

function randomHexNonce(cryptoImpl: Pick<Crypto, "getRandomValues">): string {
  const b = new Uint8Array(32);
  cryptoImpl.getRandomValues(b);
  return [...b].map((x) => x.toString(16).padStart(2, "0")).join("");
}

function validChallenge(
  x: unknown,
  nonce: string,
  profile: string,
  at: number,
  ttl: number,
): x is {
  type: "CHALLENGE";
  version: 1;
  client_nonce: string;
  server_nonce: string;
  expires_at_ms: number;
  profile_binding_sha256: string;
} {
  return (
    exact(x, CHALLENGE_KEYS) &&
    x.type === "CHALLENGE" &&
    x.version === 1 &&
    x.client_nonce === nonce &&
    typeof x.server_nonce === "string" &&
    HASH.test(x.server_nonce) &&
    x.server_nonce !== nonce &&
    x.profile_binding_sha256 === profile &&
    typeof x.expires_at_ms === "number" &&
    Number.isSafeInteger(x.expires_at_ms) &&
    x.expires_at_ms > at &&
    x.expires_at_ms <= at + ttl
  );
}

function validEstablished(
  x: unknown,
  workerId: string,
  publicKeySha256: string,
): x is {
  type: "SESSION_ESTABLISHED";
  version: 1;
  session_mode: typeof CONTROLLER_BRIDGE_MODE;
  session_id: string;
  worker_id: string;
  public_key_sha256: string;
} {
  return (
    exact(x, ESTABLISHED_KEYS) &&
    x.type === "SESSION_ESTABLISHED" &&
    x.version === 1 &&
    x.session_mode === CONTROLLER_BRIDGE_MODE &&
    typeof x.session_id === "string" &&
    HASH.test(x.session_id) &&
    x.worker_id === workerId &&
    x.public_key_sha256 === publicKeySha256
  );
}

export function validateIncomingControllerCommand(
  frame: unknown,
  nowMs: number,
  replay: ClientReplayState,
): { ok: true; command: ControllerBridgeCommand } | { ok: false; code: string } {
  if (!isPlainObject(frame)) {
    return { ok: false, code: "COMMAND_NOT_OBJECT" };
  }
  if (frame.type !== "COMMAND" || frame.version !== PROTOCOL_VERSION) {
    return { ok: false, code: "COMMAND_HEADER_INVALID" };
  }
  const action = frame.action;
  if (typeof action !== "string" || !Object.hasOwn(ACTION_KEYS, action)) {
    return { ok: false, code: "COMMAND_ACTION_FORBIDDEN" };
  }
  const expectedKeys = ACTION_KEYS[action];
  if (!expectedKeys || Object.keys(frame).sort().join(",") !== expectedKeys) {
    return { ok: false, code: "COMMAND_SHAPE_INVALID" };
  }
  const commandId = frame.command_id;
  const seq = frame.seq;
  const issuedAtMs = frame.issued_at_ms;
  const ttlMs = frame.ttl_ms;

  if (typeof commandId !== "string" || !COMMAND_ID.test(commandId)) {
    return { ok: false, code: "COMMAND_ID_INVALID" };
  }
  if (typeof seq !== "number" || !Number.isSafeInteger(seq) || seq < 1) {
    return { ok: false, code: "COMMAND_SEQ_INVALID" };
  }
  if (typeof issuedAtMs !== "number" || !Number.isSafeInteger(issuedAtMs) || issuedAtMs <= 0) {
    return { ok: false, code: "COMMAND_TIMESTAMP_INVALID" };
  }
  if (
    typeof ttlMs !== "number" ||
    !Number.isSafeInteger(ttlMs) ||
    ttlMs < MIN_TTL_MS ||
    ttlMs > MAX_TTL_MS
  ) {
    return { ok: false, code: "COMMAND_TTL_INVALID" };
  }
  if (!Number.isSafeInteger(nowMs) || nowMs <= 0) {
    return { ok: false, code: "COMMAND_CLOCK_INVALID" };
  }
  if (nowMs < issuedAtMs - MAX_CLOCK_SKEW_MS) {
    return { ok: false, code: "COMMAND_NOT_YET_VALID" };
  }
  if (nowMs >= issuedAtMs + ttlMs) {
    return { ok: false, code: "COMMAND_EXPIRED" };
  }
  if (seq <= replay.lastSeq) {
    return { ok: false, code: "COMMAND_SEQ_REPLAY" };
  }
  if (replay.seenCommandIds.has(commandId)) {
    return { ok: false, code: "COMMAND_ID_REPLAY" };
  }

  if (action === "HALT") {
    const reason = frame.reason;
    if (typeof reason !== "string" || reason.trim().length < 3 || reason.length > 256) {
      return { ok: false, code: "COMMAND_HALT_REASON_INVALID" };
    }
    replay.lastSeq = seq;
    replay.seenCommandIds.add(commandId);
    return { ok: true, command: frame as ControllerBridgeCommand };
  }

  if (action === "PING" || action === "GET_TARGET_STATUS") {
    replay.lastSeq = seq;
    replay.seenCommandIds.add(commandId);
    return { ok: true, command: frame as ControllerBridgeCommand };
  }

  if (
    typeof frame.pr_number !== "number" ||
    !Number.isSafeInteger(frame.pr_number) ||
    frame.pr_number < 1 ||
    typeof frame.head_sha !== "string" ||
    !SHA40.test(frame.head_sha) ||
    typeof frame.attempt_id !== "string" ||
    !ATTEMPT_ID.test(frame.attempt_id) ||
    typeof frame.fence_id !== "string" ||
    !IDENTIFIER.test(frame.fence_id) ||
    typeof frame.target_id !== "string" ||
    !IDENTIFIER.test(frame.target_id) ||
    typeof frame.profile_id !== "string" ||
    !IDENTIFIER.test(frame.profile_id) ||
    typeof frame.target_tab_id !== "number" ||
    !Number.isSafeInteger(frame.target_tab_id) ||
    frame.target_tab_id < 0
  ) {
    return { ok: false, code: "COMMAND_BINDING_INVALID" };
  }

  if (action === "PREPARE_CONTINUATION" || action === "DISPATCH_CONTINUATION") {
    if (
      typeof frame.expected_conversation_id !== "string" ||
      !IDENTIFIER.test(frame.expected_conversation_id) ||
      typeof frame.expected_turn_number !== "number" ||
      !Number.isSafeInteger(frame.expected_turn_number) ||
      frame.expected_turn_number < 2
    ) {
      return { ok: false, code: "COMMAND_CONTINUATION_BINDING_INVALID" };
    }
  }

  if (action === "DISPATCH_FIRST_MESSAGE" || action === "DISPATCH_CONTINUATION") {
    if (
      typeof frame.claim_id !== "string" ||
      !IDENTIFIER.test(frame.claim_id) ||
      typeof frame.prompt !== "string" ||
      frame.prompt.trim().length === 0 ||
      frame.prompt.length > MAX_PROMPT_CHARS
    ) {
      return { ok: false, code: "COMMAND_DISPATCH_PAYLOAD_INVALID" };
    }
  }

  replay.lastSeq = seq;
  replay.seenCommandIds.add(commandId);
  return { ok: true, command: frame as ControllerBridgeCommand };
}

export interface ControllerBridgeHandlers {
  getTargetStatus: () => Promise<{ ok: boolean; code: string; payload?: Record<string, unknown> }>;
  withTargetLock: <T>(
    run: () => Promise<T>,
  ) => Promise<{ ok: true; value: T } | { ok: false; code: string }>;
  dispatchFirstMessage: (
    command: ControllerBridgeCommand,
  ) => Promise<{ ok: boolean; code: string; payload?: Record<string, unknown> }>;
  dispatchContinuation: (
    command: ControllerBridgeCommand,
  ) => Promise<{ ok: boolean; code: string; payload?: Record<string, unknown> }>;
  onHalt?: (reason: string) => void;
  onUncertainDisconnect?: () => void;
}

export interface ConnectControllerBridgeOpts {
  runtime: NativeRuntime;
  identity: DeviceIdentity;
  workerId: string;
  resources: ResourcePins;
  profileBindingSha256: string;
  checkPermission: () => Promise<boolean>;
  handlers: ControllerBridgeHandlers;
  consumedRegistry?: ConsumedAttemptRegistry;
  clock?: () => number;
  cryptoImpl?: Pick<Crypto, "getRandomValues">;
  handshakeTimeoutMs?: number;
}

export type ControllerBridgeSessionState = "ESTABLISHED" | "QUARANTINED" | "CLOSED";

export interface ControllerBridgeConnection {
  readonly sessionId: string;
  readonly workerId: string;
  readonly publicKeySha256: string;
  state(): ControllerBridgeSessionState;
  wasInFlightDisconnect(): boolean;
  sendKeepalive(): boolean;
  close(): void;
  waitClosed(): Promise<string>;
}

export type ConnectControllerBridgeResult =
  | { ok: true; session: ControllerBridgeConnection }
  | { ok: false; code: string };

export async function connectControllerNativeBridge(
  opts: ConnectControllerBridgeOpts,
): Promise<ConnectControllerBridgeResult> {
  const {
    runtime,
    identity,
    workerId,
    resources,
    profileBindingSha256,
    checkPermission,
    handlers,
    clock = () => Date.now(),
    cryptoImpl = crypto,
    handshakeTimeoutMs = 15_000,
  } = opts;

  if (
    typeof workerId !== "string" ||
    !WORKER_ID.test(workerId) ||
    !resourceShape(resources) ||
    typeof profileBindingSha256 !== "string" ||
    !HASH.test(profileBindingSha256) ||
    !Number.isSafeInteger(handshakeTimeoutMs) ||
    handshakeTimeoutMs < 100 ||
    handshakeTimeoutMs > 15_000
  ) {
    return { ok: false, code: "BRIDGE_CLIENT_CONFIG_INVALID" };
  }

  let permitted = false;
  try {
    permitted = (await checkPermission()) === true;
  } catch {
    permitted = false;
  }
  if (!permitted) {
    return { ok: false, code: "BRIDGE_PERMISSION_NOT_GRANTED" };
  }

  const origin = runtime.getURL("");
  if (typeof origin !== "string" || !ORIGIN.test(origin)) {
    return { ok: false, code: "BRIDGE_EXTENSION_ORIGIN_INVALID" };
  }

  const startMs = freshTime(clock);
  if (startMs === null) {
    return { ok: false, code: "BRIDGE_CLOCK_INVALID" };
  }

  let pub;
  try {
    pub = await identity.read(workerId);
  } catch {
    return { ok: false, code: "BRIDGE_IDENTITY_UNAVAILABLE" };
  }
  if (pub.state !== "READY") {
    return { ok: false, code: "BRIDGE_IDENTITY_UNAVAILABLE" };
  }

  let clientNonce: string;
  try {
    clientNonce = randomHexNonce(cryptoImpl);
  } catch {
    return { ok: false, code: "BRIDGE_RANDOM_UNAVAILABLE" };
  }
  if (!HASH.test(clientNonce)) {
    return { ok: false, code: "BRIDGE_RANDOM_UNAVAILABLE" };
  }

  let port: NativePort;
  try {
    port = runtime.connectNative(NATIVE_HOST_NAME);
  } catch {
    return { ok: false, code: "BRIDGE_NATIVE_HOST_UNAVAILABLE" };
  }

  const handshakeQueue: unknown[] = [];
  let handshakeWake: ((msg: unknown) => void) | null = null;
  let handshakeFail: ((err: Error) => void) | null = null;
  let established = false;
  let closed = false;
  let quarantined = false;
  let inFlight = false;
  let disconnectedWhileInFlight = false;
  let sessionId = "";
  let resolveClosed!: (reason: string) => void;
  const closedPromise = new Promise<string>((resolve) => {
    resolveClosed = resolve;
  });

  const replay: ClientReplayState = {
    lastSeq: 0,
    seenCommandIds: new Set<string>(),
  };

  const memorySet = new Set<string>();
  const registry: ConsumedAttemptRegistry = opts.consumedRegistry ?? {
    consumeOnce(attemptId: string): boolean {
      if (memorySet.has(attemptId)) return false;
      memorySet.add(attemptId);
      return true;
    },
  };
  const dispatchFence = new DispatchFence(registry);

  const cleanup = (reason: string) => {
    if (closed) return;
    closed = true;
    if (inFlight) {
      quarantined = true;
      disconnectedWhileInFlight = true;
      handlers.onUncertainDisconnect?.();
    }
    port.onMessage.removeListener(onMessage);
    port.onDisconnect.removeListener(onDisconnect);
    try {
      port.disconnect();
    } catch {
      // Ignore disconnect errors on already-closed port.
    }
    if (handshakeFail) {
      const f = handshakeFail;
      handshakeFail = null;
      handshakeWake = null;
      f(Error(reason));
    }
    resolveClosed(reason);
  };

  const handleCommand = async (rawFrame: unknown) => {
    const now = freshTime(clock) ?? Date.now();
    const checked = validateIncomingControllerCommand(rawFrame, now, replay);
    if (!checked.ok) {
      if (isPlainObject(rawFrame) && typeof rawFrame.command_id === "string" && Number.isSafeInteger(rawFrame.seq)) {
        try {
          port.postMessage({
            type: "COMMAND_RESULT",
            version: 1,
            command_id: rawFrame.command_id,
            seq: rawFrame.seq,
            ok: false,
            code: checked.code,
          });
        } catch {
          // Port may already be closed.
        }
      }
      return;
    }

    const cmd = checked.command;
    const sendResult = (ok: boolean, code: string, payload?: Record<string, unknown>) => {
      if (closed) return;
      const resultMsg: ControllerCommandResult = {
        type: "COMMAND_RESULT",
        version: 1,
        command_id: cmd.command_id,
        seq: cmd.seq,
        ok,
        code,
        ...(payload ? { payload } : {}),
      };
      try {
        port.postMessage(resultMsg);
      } catch {
        cleanup("BRIDGE_POST_FAILED");
      }
    };

    if (quarantined) {
      sendResult(false, "BRIDGE_SESSION_QUARANTINED");
      return;
    }

    if (cmd.action === "HALT") {
      quarantined = true;
      handlers.onHalt?.(String(cmd.reason));
      sendResult(true, "HALTED");
      cleanup("CONTROLLER_HALTED");
      return;
    }

    if (inFlight) {
      sendResult(false, "BRIDGE_COMMAND_IN_FLIGHT");
      return;
    }

    inFlight = true;
    try {
      if (cmd.action === "PING") {
        sendResult(true, "PONG", { worker_id: workerId, session_id: sessionId });
        return;
      }

      if (cmd.action === "GET_TARGET_STATUS") {
        const res = await handlers.withTargetLock(() => handlers.getTargetStatus());
        if (!res.ok) {
          sendResult(false, res.code);
          return;
        }
        sendResult(res.value.ok, res.value.code, res.value.payload);
        return;
      }

      if (cmd.action === "PREPARE_FIRST_MESSAGE" || cmd.action === "PREPARE_CONTINUATION") {
        const res = await handlers.withTargetLock(() => handlers.getTargetStatus());
        if (!res.ok) {
          sendResult(false, res.code);
          return;
        }
        sendResult(res.value.ok, res.value.code, {
          ...res.value.payload,
          prepared: res.value.ok,
          attempt_id: cmd.attempt_id,
          fence_id: cmd.fence_id,
        });
        return;
      }

      if (cmd.action === "DISPATCH_FIRST_MESSAGE" || cmd.action === "DISPATCH_CONTINUATION") {
        const prNumber = Number(cmd.pr_number);
        const attemptId = String(cmd.attempt_id);
        const headSha = String(cmd.head_sha);

        let dispatchResult: { ok: boolean; code: string; payload?: Record<string, unknown> } | null = null;
        const locked = await handlers.withTargetLock(async () => {
          const fenceRes = await dispatchFence.attempt(
            { prNumber, attemptId, headSha },
            {
              code: "CREATED",
              prNumber,
              attemptId,
              headSha,
              ref: `refs/bke/claims/${prNumber}/${attemptId}`,
            },
            {
              clickOnce: async () => {
                dispatchResult =
                  cmd.action === "DISPATCH_FIRST_MESSAGE"
                    ? await handlers.dispatchFirstMessage(cmd)
                    : await handlers.dispatchContinuation(cmd);
                if (!dispatchResult.ok) {
                  throw Error(dispatchResult.code);
                }
              },
            },
          );
          return fenceRes;
        });

        if (!locked.ok) {
          quarantined = true;
          sendResult(false, locked.code);
          return;
        }
        const finalRes = dispatchResult as { ok: boolean; code: string; payload?: Record<string, unknown> } | null;
        if (locked.value.code !== "ATTEMPTED") {
          quarantined = true;
          const failureCode = finalRes
            ? finalRes.code
            : (locked.value.reason ?? "DISPATCH_ABORTED");
          sendResult(false, failureCode);
          return;
        }
        if (!finalRes) {
          quarantined = true;
          sendResult(false, "DISPATCH_NOT_EXECUTED");
          return;
        }
        sendResult(finalRes.ok, finalRes.code, finalRes.payload);
      }
    } catch {
      quarantined = true;
      sendResult(false, "BRIDGE_HANDLER_UNCERTAIN");
    } finally {
      inFlight = false;
    }
  };

  const onMessage = (msg: unknown) => {
    if (closed) return;
    if (!established) {
      if (handshakeWake) {
        const w = handshakeWake;
        handshakeWake = null;
        handshakeFail = null;
        w(msg);
      } else {
        handshakeQueue.push(msg);
      }
      return;
    }
    if (isPlainObject(msg) && msg.type === "KEEPALIVE_PONG") {
      return;
    }
    void handleCommand(msg);
  };

  const onDisconnect = () => {
    cleanup("NATIVE_PORT_DISCONNECTED");
  };

  port.onMessage.addListener(onMessage);
  port.onDisconnect.addListener(onDisconnect);

  const deadline = startMs + handshakeTimeoutMs;
  const receiveHandshake = async (): Promise<unknown> => {
    if (closed) throw Error("BRIDGE_CLOSED");
    if (handshakeQueue.length > 0) return handshakeQueue.shift();
    const left = Math.min(deadline - clock(), 15_000);
    if (!Number.isSafeInteger(left) || left <= 0) throw Error("BRIDGE_HANDSHAKE_TIMEOUT");
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        handshakeWake = null;
        handshakeFail = null;
        reject(Error("BRIDGE_HANDSHAKE_TIMEOUT"));
      }, left);
      handshakeWake = (x) => {
        clearTimeout(timer);
        resolve(x);
      };
      handshakeFail = (err) => {
        clearTimeout(timer);
        reject(err);
      };
    });
  };

  try {
    port.postMessage({
      type: "HELLO",
      version: PROTOCOL_VERSION,
      session_mode: CONTROLLER_BRIDGE_MODE,
      worker_id: workerId,
      public_key: pub.public_key,
      resources: { ...resources },
      client_nonce: clientNonce,
    });

    const challengeMsg = await receiveHandshake();
    const now = freshTime(clock);
    if (now === null || !validChallenge(challengeMsg, clientNonce, profileBindingSha256, now, 15_000)) {
      cleanup("BRIDGE_CHALLENGE_DENIED");
      return { ok: false, code: "BRIDGE_CHALLENGE_DENIED" };
    }

    const challenge: NativeProofChallenge = {
      origin,
      worker_id: workerId,
      public_key_sha256: pub.public_key_sha256,
      profile_binding_sha256: profileBindingSha256,
      resources: { ...resources },
      client_nonce: clientNonce,
      server_nonce: challengeMsg.server_nonce,
      expires_at_ms: challengeMsg.expires_at_ms,
    };

    const proof = await identity.signNativeProof(workerId, challenge);
    if (proof.state !== "SIGNED") {
      cleanup("BRIDGE_PROOF_DENIED");
      return { ok: false, code: "BRIDGE_PROOF_DENIED" };
    }
    if (freshTime(clock) === null || clock() >= challenge.expires_at_ms) {
      cleanup("BRIDGE_CHALLENGE_EXPIRED");
      return { ok: false, code: "BRIDGE_CHALLENGE_EXPIRED" };
    }

    port.postMessage({
      type: "PROOF",
      version: PROTOCOL_VERSION,
      client_nonce: clientNonce,
      server_nonce: challengeMsg.server_nonce,
      device_signature: proof.device_signature,
    });

    const establishedMsg = await receiveHandshake();
    if (!validEstablished(establishedMsg, workerId, pub.public_key_sha256)) {
      cleanup("BRIDGE_ESTABLISHED_DENIED");
      return { ok: false, code: "BRIDGE_ESTABLISHED_DENIED" };
    }

    sessionId = establishedMsg.session_id;
    established = true;

    const connection: ControllerBridgeConnection = Object.freeze({
      sessionId,
      workerId,
      publicKeySha256: pub.public_key_sha256,
      state(): ControllerBridgeSessionState {
        if (quarantined) return "QUARANTINED";
        if (closed) return "CLOSED";
        return "ESTABLISHED";
      },
      wasInFlightDisconnect: () => disconnectedWhileInFlight,
      sendKeepalive(): boolean {
        if (closed || quarantined || inFlight) return false;
        try {
          port.postMessage({
            type: "KEEPALIVE_PING",
            version: 1,
            session_id: sessionId,
          });
          return true;
        } catch {
          cleanup("KEEPALIVE_SEND_FAILED");
          return false;
        }
      },
      close: () => cleanup("CLIENT_CLOSED"),
      waitClosed: () => closedPromise,
    });

    return { ok: true, session: connection };
  } catch {
    cleanup("BRIDGE_HANDSHAKE_FAILED");
    return { ok: false, code: "BRIDGE_HANDSHAKE_FAILED" };
  }
}

export interface ControllerBridgeSupervisor {
  connect(): Promise<ConnectControllerBridgeResult>;
  reconnectIfIdle(): Promise<ConnectControllerBridgeResult>;
  isQuarantined(): boolean;
  currentSession(): ControllerBridgeConnection | null;
  disconnect(): void;
}

/**
 * Maintains idle connectivity for the MV3 service worker bridge.
 * Never reconnects if a previous session disconnected while a dispatch/command
 * was in flight (fail-closed uncertainty quarantine).
 */
export function createControllerBridgeSupervisor(
  connectFn: () => Promise<ConnectControllerBridgeResult>,
): ControllerBridgeSupervisor {
  let active: ControllerBridgeConnection | null = null;
  let quarantined = false;

  const connect = async (): Promise<ConnectControllerBridgeResult> => {
    if (quarantined) {
      return { ok: false, code: "SUPERVISOR_QUARANTINED_AFTER_INFLIGHT_DISCONNECT" };
    }
    if (active && active.state() === "ESTABLISHED") {
      return { ok: true, session: active };
    }
    const res = await connectFn();
    if (res.ok) {
      active = res.session;
      void res.session.waitClosed().then(() => {
        if (res.session.wasInFlightDisconnect() || res.session.state() === "QUARANTINED") {
          quarantined = true;
        }
        if (active === res.session) {
          active = null;
        }
      });
    }
    return res;
  };

  const reconnectIfIdle = async (): Promise<ConnectControllerBridgeResult> => {
    if (active?.wasInFlightDisconnect() || active?.state() === "QUARANTINED") {
      quarantined = true;
    }
    if (quarantined) {
      return { ok: false, code: "SUPERVISOR_QUARANTINED_AFTER_INFLIGHT_DISCONNECT" };
    }
    return connect();
  };

  return Object.freeze({
    connect,
    reconnectIfIdle,
    isQuarantined: () => quarantined,
    currentSession: () => active,
    disconnect() {
      active?.close();
      active = null;
    },
  });
}
