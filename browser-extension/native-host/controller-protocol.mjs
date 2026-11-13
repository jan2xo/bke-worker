/**
 * F1-03 authenticated native-host <-> controller bridge wire protocol.
 * Strict exact-key allowlist, monotonic seq, command_id replay dedupe, and TTL checks.
 */

export const CONTROLLER_BRIDGE_MODE = "CONTROLLER_BRIDGE_V1";
export const CONTROLLER_PROTOCOL_VERSION = 1;
export const MIN_COMMAND_TTL_MS = 100;
export const MAX_COMMAND_TTL_MS = 60_000;
export const MAX_CLOCK_SKEW_MS = 5_000;
export const MAX_PROMPT_CHARS = 2_048;

export const ALLOWED_COMMAND_ACTIONS = Object.freeze([
  "PING",
  "GET_TARGET_STATUS",
  "PREPARE_FIRST_MESSAGE",
  "DISPATCH_FIRST_MESSAGE",
  "PREPARE_CONTINUATION",
  "DISPATCH_CONTINUATION",
  "HALT",
]);

const ACTION_KEYS = {
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

const COMMAND_ID_RE = /^[A-Za-z0-9_-]{8,128}$/;
const ATTEMPT_ID_RE = /^[a-z0-9][a-z0-9-]{0,95}$/;
const IDENTIFIER_RE = /^[A-Za-z0-9_-]{8,128}$/;
const SHA40_RE = /^[a-f0-9]{40}$/;

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function hasExactKeys(obj, sortedCsv) {
  return isPlainObject(obj) && Object.keys(obj).sort().join(",") === sortedCsv;
}

export function validateControllerCommand(frame, nowMs = Date.now()) {
  if (!isPlainObject(frame)) {
    return { ok: false, code: "COMMAND_NOT_OBJECT" };
  }
  if (frame.type !== "COMMAND" || frame.version !== CONTROLLER_PROTOCOL_VERSION) {
    return { ok: false, code: "COMMAND_HEADER_INVALID" };
  }
  if (typeof frame.action !== "string" || !Object.hasOwn(ACTION_KEYS, frame.action)) {
    return { ok: false, code: "COMMAND_ACTION_FORBIDDEN" };
  }
  if (!hasExactKeys(frame, ACTION_KEYS[frame.action])) {
    return { ok: false, code: "COMMAND_SHAPE_INVALID" };
  }
  if (typeof frame.command_id !== "string" || !COMMAND_ID_RE.test(frame.command_id)) {
    return { ok: false, code: "COMMAND_ID_INVALID" };
  }
  if (!Number.isSafeInteger(frame.seq) || frame.seq < 1) {
    return { ok: false, code: "COMMAND_SEQ_INVALID" };
  }
  if (!Number.isSafeInteger(frame.issued_at_ms) || frame.issued_at_ms <= 0) {
    return { ok: false, code: "COMMAND_TIMESTAMP_INVALID" };
  }
  if (
    !Number.isSafeInteger(frame.ttl_ms) ||
    frame.ttl_ms < MIN_COMMAND_TTL_MS ||
    frame.ttl_ms > MAX_COMMAND_TTL_MS
  ) {
    return { ok: false, code: "COMMAND_TTL_INVALID" };
  }
  if (!Number.isSafeInteger(nowMs) || nowMs <= 0) {
    return { ok: false, code: "COMMAND_CLOCK_INVALID" };
  }
  if (nowMs < frame.issued_at_ms - MAX_CLOCK_SKEW_MS) {
    return { ok: false, code: "COMMAND_NOT_YET_VALID" };
  }
  if (nowMs >= frame.issued_at_ms + frame.ttl_ms) {
    return { ok: false, code: "COMMAND_EXPIRED" };
  }

  if (frame.action === "HALT") {
    if (
      typeof frame.reason !== "string" ||
      frame.reason.trim().length < 3 ||
      frame.reason.length > 256
    ) {
      return { ok: false, code: "COMMAND_HALT_REASON_INVALID" };
    }
    return { ok: true, code: "OK" };
  }

  if (frame.action === "PING" || frame.action === "GET_TARGET_STATUS") {
    return { ok: true, code: "OK" };
  }

  // Binding checks for prepare / dispatch commands
  if (!Number.isSafeInteger(frame.pr_number) || frame.pr_number < 1) {
    return { ok: false, code: "COMMAND_PR_INVALID" };
  }
  if (typeof frame.head_sha !== "string" || !SHA40_RE.test(frame.head_sha)) {
    return { ok: false, code: "COMMAND_HEAD_SHA_INVALID" };
  }
  if (typeof frame.attempt_id !== "string" || !ATTEMPT_ID_RE.test(frame.attempt_id)) {
    return { ok: false, code: "COMMAND_ATTEMPT_ID_INVALID" };
  }
  if (typeof frame.fence_id !== "string" || !IDENTIFIER_RE.test(frame.fence_id)) {
    return { ok: false, code: "COMMAND_FENCE_ID_INVALID" };
  }
  if (typeof frame.target_id !== "string" || !IDENTIFIER_RE.test(frame.target_id)) {
    return { ok: false, code: "COMMAND_TARGET_ID_INVALID" };
  }
  if (typeof frame.profile_id !== "string" || !IDENTIFIER_RE.test(frame.profile_id)) {
    return { ok: false, code: "COMMAND_PROFILE_ID_INVALID" };
  }
  if (!Number.isSafeInteger(frame.target_tab_id) || frame.target_tab_id < 0) {
    return { ok: false, code: "COMMAND_TAB_ID_INVALID" };
  }

  if (
    frame.action === "PREPARE_CONTINUATION" ||
    frame.action === "DISPATCH_CONTINUATION"
  ) {
    if (
      typeof frame.expected_conversation_id !== "string" ||
      !IDENTIFIER_RE.test(frame.expected_conversation_id)
    ) {
      return { ok: false, code: "COMMAND_CONVERSATION_ID_INVALID" };
    }
    if (!Number.isSafeInteger(frame.expected_turn_number) || frame.expected_turn_number < 2) {
      return { ok: false, code: "COMMAND_TURN_NUMBER_INVALID" };
    }
  }

  if (
    frame.action === "DISPATCH_FIRST_MESSAGE" ||
    frame.action === "DISPATCH_CONTINUATION"
  ) {
    if (typeof frame.claim_id !== "string" || !IDENTIFIER_RE.test(frame.claim_id)) {
      return { ok: false, code: "COMMAND_CLAIM_ID_INVALID" };
    }
    if (
      typeof frame.prompt !== "string" ||
      frame.prompt.trim().length === 0 ||
      frame.prompt.length > MAX_PROMPT_CHARS
    ) {
      return { ok: false, code: "COMMAND_PROMPT_INVALID" };
    }
  }

  return { ok: true, code: "OK" };
}

export function validateCommandResult(frame) {
  if (!isPlainObject(frame)) {
    return { ok: false, code: "RESULT_NOT_OBJECT" };
  }
  const keys = Object.keys(frame).sort().join(",");
  if (
    keys !== "code,command_id,ok,seq,type,version" &&
    keys !== "code,command_id,ok,payload,seq,type,version"
  ) {
    return { ok: false, code: "RESULT_SHAPE_INVALID" };
  }
  if (
    frame.type !== "COMMAND_RESULT" ||
    frame.version !== CONTROLLER_PROTOCOL_VERSION ||
    typeof frame.command_id !== "string" ||
    !COMMAND_ID_RE.test(frame.command_id) ||
    !Number.isSafeInteger(frame.seq) ||
    frame.seq < 1 ||
    typeof frame.ok !== "boolean" ||
    typeof frame.code !== "string" ||
    frame.code.length === 0
  ) {
    return { ok: false, code: "RESULT_FIELDS_INVALID" };
  }
  return { ok: true, code: "OK" };
}

export class CommandReplayGuard {
  constructor() {
    this.lastSeq = 0;
    this.seenCommandIds = new Set();
  }

  admit(frame, nowMs = Date.now()) {
    const check = validateControllerCommand(frame, nowMs);
    if (!check.ok) {
      return check;
    }
    if (frame.seq <= this.lastSeq) {
      return { ok: false, code: "COMMAND_SEQ_REPLAY" };
    }
    if (this.seenCommandIds.has(frame.command_id)) {
      return { ok: false, code: "COMMAND_ID_REPLAY" };
    }
    this.lastSeq = frame.seq;
    this.seenCommandIds.add(frame.command_id);
    return { ok: true, code: "OK" };
  }
}
