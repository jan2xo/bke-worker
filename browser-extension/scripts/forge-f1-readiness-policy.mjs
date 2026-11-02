import { createHash } from "node:crypto";

const SHA40 = /^[0-9a-f]{40}$/;
const SHA256 = /^[0-9a-f]{64}$/;
const EXTENSION_ID = /^[a-p]{32}$/;
const SESSION_ID = /^[0-9a-f]{24}$/;
const CANONICAL_ORIGINS = new Set([
  "https://github.com/jan2xo/bke-worker",
  "https://github.com/jan2xo/bke-worker.git",
  "git@github.com:jan2xo/bke-worker.git",
  "ssh://git@github.com/jan2xo/bke-worker.git",
]);

function versionMajor(value) {
  if (typeof value !== "string") return null;
  const match = /^v?(\d+)(?:\.\d+){1,3}(?:[-+].*)?$/.exec(value.trim());
  return match ? Number(match[1]) : null;
}

function hasSafeAbsolutePath(value) {
  if (typeof value !== "string" || !value.startsWith("/") || value.includes("\0")) return false;
  if (value === "/" || value.includes("//")) return false;
  return !value.split("/").some((part) => part === "." || part === "..");
}

function add(codes, condition, code) {
  if (condition && !codes.includes(code)) codes.push(code);
}

function shaPath(value) {
  return typeof value === "string" && value.length > 0
    ? createHash("sha256").update(value).digest("hex")
    : null;
}

/**
 * Pure, non-authoritative policy evaluator. Browser/profile input is evidence,
 * not identity authority. This function cannot enroll, dispatch, or send.
 */
export function evaluateF1DesktopReadiness(evidence) {
  const e = evidence && typeof evidence === "object" && !Array.isArray(evidence) ? evidence : {};
  const repo = e.repository || {};
  const smoke = e.sourceSmoke || {};
  const browser = e.browser || {};
  const profile = e.profile || {};
  const extension = e.extension || {};
  const host = e.nativeHost || {};
  const chatgpt = e.chatgpt || {};
  const safety = e.safety || {};
  const sessionId = typeof e.readinessSessionId === "string" ? e.readinessSessionId : "";

  const sourceBlockers = [];
  add(sourceBlockers, !CANONICAL_ORIGINS.has(repo.origin), "REPOSITORY_ORIGIN_UNTRUSTED");
  add(sourceBlockers, repo.branch !== "main", "CHECKOUT_NOT_MAIN");
  add(sourceBlockers, repo.clean !== true, "CHECKOUT_DIRTY");
  add(sourceBlockers, typeof repo.headSha !== "string" || !SHA40.test(repo.headSha), "CHECKOUT_SHA_INVALID");
  add(sourceBlockers, typeof repo.remoteMainSha !== "string" || !SHA40.test(repo.remoteMainSha), "REMOTE_MAIN_SHA_INVALID");
  add(sourceBlockers, repo.headSha !== repo.remoteMainSha, "STALE_CHECKOUT");
  add(sourceBlockers, smoke.status !== "PASS", "SOURCE_SMOKE_NOT_PASS");
  add(sourceBlockers, smoke.sourceSha !== repo.headSha, "SOURCE_SMOKE_SHA_MISMATCH");

  const sourceStatus = sourceBlockers.length === 0 ? "SOURCE_SMOKE_PASS" : "SOURCE_SMOKE_BLOCKED";
  const blockers = [...sourceBlockers];
  add(blockers, !SESSION_ID.test(sessionId), "READINESS_SESSION_ID_INVALID");

  add(blockers, !["Darwin", "Linux"].includes(browser.platform), "UNSUPPORTED_OPERATING_SYSTEM");
  add(blockers, browser.installed !== true, "GOOGLE_CHROME_NOT_FOUND");
  add(blockers, browser.name !== "Google Chrome", "UNTRUSTED_OR_UNSUPPORTED_BROWSER");
  add(blockers, versionMajor(browser.version) === null || versionMajor(browser.version) < 116, "CHROME_VERSION_UNSUPPORTED");
  add(blockers, typeof browser.binarySha256 !== "string" || !SHA256.test(browser.binarySha256), "CHROME_RUNTIME_SHA_INVALID");
  add(blockers, versionMajor(browser.nodeVersion) === null || versionMajor(browser.nodeVersion) < 22, "NODE_RUNTIME_UNSUPPORTED");
  add(blockers, typeof browser.nodeBinarySha256 !== "string" || !SHA256.test(browser.nodeBinarySha256), "NODE_RUNTIME_SHA_INVALID");

  add(blockers, profile.exists !== true, "ISOLATED_PROFILE_MISSING");
  add(blockers, !hasSafeAbsolutePath(profile.path), "PROFILE_PATH_UNSAFE");
  add(blockers, profile.pathCanonical !== true, "PROFILE_PATH_NOT_CANONICAL");
  add(blockers, profile.ownerMatches !== true, "PROFILE_OWNER_MISMATCH");
  add(blockers, profile.privateMode !== true, "PROFILE_PERMISSIONS_NOT_PRIVATE");
  add(blockers, profile.dedicated !== true, "PROFILE_NOT_ISOLATED");
  add(blockers, profile.activeProcess !== true, "CHROME_NOT_ATTACHED_TO_SELECTED_PROFILE");
  add(blockers, profile.exclusiveOwnerAttested !== true, "PROFILE_EXCLUSIVITY_NOT_ATTESTED");

  const extensionId = typeof extension.id === "string" ? extension.id : "";
  const expectedOrigin = EXTENSION_ID.test(extensionId) ? "chrome-extension://" + extensionId + "/" : "";
  add(blockers, !EXTENSION_ID.test(extensionId), "EXTENSION_ID_INVALID_OR_MISSING");
  add(blockers, extension.matchCount !== 1, "EXTENSION_MISSING_OR_DUPLICATE");
  add(blockers, extension.enabled !== true, "EXTENSION_NOT_ENABLED");
  add(blockers, extension.pathMatches !== true, "EXTENSION_SOURCE_PATH_MISMATCH");
  add(blockers, extension.versionMatches !== true, "EXTENSION_VERSION_MISMATCH");
  add(blockers, extension.manifestVersion !== 3, "EXTENSION_MANIFEST_VERSION_UNSUPPORTED");
  add(blockers, !Array.isArray(extension.permissions) ||
    extension.permissions.length !== 1 || extension.permissions[0] !== "storage",
  "EXTENSION_PERMISSION_BOUNDARY_DRIFT");
  add(blockers, !Array.isArray(extension.hostPermissions) ||
    extension.hostPermissions.length !== 1 || extension.hostPermissions[0] !== "https://chatgpt.com/*",
  "EXTENSION_HOST_PERMISSION_BOUNDARY_DRIFT");
  add(blockers, extension.nativeMessagingPermission !== false, "UNAUTHORIZED_NATIVE_MESSAGING_PERMISSION");

  add(blockers, host.status !== "VERIFIED_REGISTRATION_ONLY", "NATIVE_HOST_REGISTRATION_NOT_VERIFIED");
  add(blockers, host.name !== "bke.worker.desktop", "NATIVE_HOST_IDENTITY_MISMATCH");
  add(blockers, host.origin !== expectedOrigin || !expectedOrigin, "NATIVE_HOST_EXTENSION_ORIGIN_MISMATCH");
  add(blockers, host.policyVerified !== true, "NATIVE_HOST_OWNER_POLICY_NOT_VERIFIED");

  add(blockers, chatgpt.targetCount !== 1, "CHATGPT_TARGET_COUNT_NOT_ONE");
  add(blockers, chatgpt.exclusivityAttested !== true, "CHATGPT_TARGET_EXCLUSIVITY_NOT_ATTESTED");
  add(blockers, chatgpt.authenticatedAndIdle !== true, "CHATGPT_NOT_HUMAN_CONFIRMED_AUTHENTICATED_AND_IDLE");

  add(blockers, safety.messageSendAttempted !== false, "MESSAGE_SEND_NOT_PROVEN_ABSENT");
  add(blockers, safety.profileSecretsRead !== false, "PROFILE_SECRET_READ_NOT_PROVEN_ABSENT");
  add(blockers, safety.otherProfilesTouched !== false, "OTHER_PROFILE_ACCESS_NOT_PROVEN_ABSENT");
  add(blockers, safety.credentialsWritten !== false, "CREDENTIAL_WRITE_NOT_PROVEN_ABSENT");
  add(blockers, typeof e.operatorBlocker === "string" &&
    /^[A-Z0-9_]{1,80}$/.test(e.operatorBlocker), e.operatorBlocker);

  const ready = sourceStatus === "SOURCE_SMOKE_PASS" && blockers.length === 0;
  const profilePathSha256 = shaPath(profile.path);
  const extensionPathSha256 = shaPath(extension.path);

  return {
    schema_version: 1,
    program: "FORGE F1-01 desktop Chrome readiness",
    readiness_session_id: SESSION_ID.test(sessionId) ? sessionId : "INVALID",
    source_status: sourceStatus,
    real_chrome_status: ready ? "REAL_CHROME_READY" : "BLOCKED",
    blocker_codes: blockers,
    source: {
      repository: "jan2xo/bke-worker",
      branch: repo.branch || "UNKNOWN",
      head_sha: typeof repo.headSha === "string" && SHA40.test(repo.headSha) ? repo.headSha : "UNAVAILABLE",
      remote_main_sha: typeof repo.remoteMainSha === "string" && SHA40.test(repo.remoteMainSha) ? repo.remoteMainSha : "UNAVAILABLE",
      smoke_status: smoke.status || "NOT_RUN",
      smoke_source_sha: typeof smoke.sourceSha === "string" && SHA40.test(smoke.sourceSha) ? smoke.sourceSha : "UNAVAILABLE",
      node_version: browser.nodeVersion || "UNAVAILABLE",
      node_runtime_sha256: typeof browser.nodeBinarySha256 === "string" && SHA256.test(browser.nodeBinarySha256)
        ? browser.nodeBinarySha256 : "UNAVAILABLE",
    },
    browser: {
      platform: browser.platform || "UNKNOWN",
      name: browser.name || "UNKNOWN",
      version: browser.version || "UNAVAILABLE",
      runtime_sha256: typeof browser.binarySha256 === "string" && SHA256.test(browser.binarySha256)
        ? browser.binarySha256 : "UNAVAILABLE",
      profile_path_sha256: profilePathSha256,
    },
    extension: {
      id: EXTENSION_ID.test(extensionId) ? extensionId : "UNAVAILABLE",
      version: extension.version || "UNAVAILABLE",
      manifest_version: extension.manifestVersion ?? null,
      source_path_sha256: extensionPathSha256,
      identity_evidence_source: "OWNER_VISUAL_ATTESTATION",
      loaded_enabled_from_canonical_source_owner_attested: extension.enabled === true &&
        extension.pathMatches === true && extension.versionMatches === true && extension.matchCount === 1,
      native_messaging_permission: extension.nativeMessagingPermission === false
        ? "ABSENT_BY_DESIGN" : "UNEXPECTED_OR_UNVERIFIED",
      allowed_host_permissions: Array.isArray(extension.hostPermissions) &&
        extension.hostPermissions.length === 1 && extension.hostPermissions[0] === "https://chatgpt.com/*"
        ? ["https://chatgpt.com/*"] : [],
    },
    native_host: {
      name: host.name || "UNAVAILABLE",
      status: host.status || "NOT_CHECKED",
      extension_origin_matches: host.origin === expectedOrigin && !!expectedOrigin,
      owner_policy_verified: host.policyVerified === true,
      live_chrome_connection: "NOT_TESTED_NATIVE_MESSAGING_PERMISSION_ABSENT_BY_DESIGN",
    },
    chatgpt: {
      open_target_count: Number.isInteger(chatgpt.targetCount) ? chatgpt.targetCount : null,
      target_count_source: "OWNER_VISUAL_ATTESTATION",
      authenticated_and_idle: chatgpt.authenticatedAndIdle === true,
      authentication_evidence_source: "OWNER_VISUAL_ATTESTATION_NO_PROFILE_SECRETS_READ",
      conversation_id: "NOT_CREATED_NO_SEND_OCCURRED",
    },
    authority: {
      worker_assignment: "UNENROLLED",
      assignment_authority: "NONE",
      dispatch_authority: "NONE",
      message_send_authority: "NONE",
      production: "LOCKED",
    },
    safety: {
      message_send_attempted: safety.messageSendAttempted === true,
      profile_secrets_read: safety.profileSecretsRead === true,
      other_profiles_touched: safety.otherProfilesTouched === true,
      credentials_written: safety.credentialsWritten === true,
    },
  };
}
