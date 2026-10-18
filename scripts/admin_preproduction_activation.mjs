#!/usr/bin/env node
// PREPRODUCTION Admin activation. No production routes, credentials in argv,
// browser-profile access, GitHub App permission changes or OAuth automation.
import { spawnSync } from "node:child_process";
import { resolve, join } from "node:path";
import { fileURLToPath } from "node:url";

const [workerArg, commandArg, workerSha, commandSha] = process.argv.slice(2);
const WRANGLER = "wrangler@4.148.0";
const TARGET_RELAY = "bke-worker-relay-preproduction";
const TARGET_CC = "bke-command-center-preproduction";
const HOST = "cc.jl-bke.com";
const ADMIN_URL = "https://" + HOST + "/admin";
const SHA = /^[a-f0-9]{40}$/u;
const ADMIN_FLAG_NAMES = ["BKE_ADMIN_BROKER_ENABLED", "BKE_ADMIN_REPO_CATALOG_ENABLED"];
const CC_ADMIN_NAMES = ["BKE_ADMIN_DISCOVERY_ENABLED", "BKE_ADMIN_ACCESS_ISSUER",
  "BKE_ADMIN_ACCESS_AUD", "BKE_ADMIN_EMAILS", "GITHUB_DISCOVERY_AUTH_MODE"];
function fail(code) { throw new Error(code); }
function run(command, args, cwd, options = {}) {
  const result = spawnSync(command, args, {
    cwd, encoding: "utf8", timeout: 300000, maxBuffer: 1024 * 1024,
    stdio: options.interactive ? "inherit" : ["pipe", "pipe", "pipe"],
    input: options.input,
    env: options.env || process.env,
  });
  if (result.error || result.status !== 0) fail(options.code || "OPERATOR_COMMAND_FAILED");
  return options.interactive ? "" : result.stdout;
}
function wrangler(args, cwd, options = {}) {
  return run("npx", ["--yes", WRANGLER, ...args], cwd, options);
}
function checkpoint(phase, workerShaValue, commandShaValue) {
  const body = [
    "BKE PREPRODUCTION ADMIN ACTIVATION — " + phase,
    "Worker source main " + workerShaValue,
    "Command Center source main " + commandShaValue,
    "Cloudflare targets: " + TARGET_RELAY + " / " + TARGET_CC,
    "Access hostname: " + HOST,
    "Human login remains manual; production locked; no credentials or worker/browser secrets in GitHub.",
  ].join("\n");
  try {
    run("gh", ["issue", "comment", "30", "--repo", "jan2xo/bke-command-center", "--body", body],
      resolve(workerArg), { code: "GITHUB_CHECKPOINT_FAILED" });
  } catch { console.error("BKE ADMIN: GitHub checkpoint unavailable; check issue #30 manually."); }
}
async function cfGet(token, path) {
  let response;
  try {
    response = await fetch("https://api.cloudflare.com/client/v4" + path, {
      headers: { Authorization: "Bearer " + token, Accept: "application/json" },
      redirect: "error",
      signal: AbortSignal.timeout(15000),
    });
  } catch { fail("CLOUDFLARE_READ_UNAVAILABLE"); }
  if (response.status !== 200) fail("CLOUDFLARE_READ_REJECTED");
  const body = await response.json().catch(() => null);
  if (!body || body.success !== true || body.result == null) fail("CLOUDFLARE_READ_INVALID");
  return body.result;
}
function names(bindings) {
  return new Map((Array.isArray(bindings) ? bindings : []).map(x => [x.name, x]));
}
function requireBinding(found, name, type) {
  if (found.get(name)?.type !== type) fail("CLOUDFLARE_REQUIRED_BINDING_MISSING");
}
function noPriorActivation(relay, command) {
  if (ADMIN_FLAG_NAMES.some(x => relay.has(x)) || CC_ADMIN_NAMES.some(x => command.has(x))) {
    fail("ADMIN_ACTIVATION_ALREADY_OR_PARTIALLY_CONFIGURED");
  }
}
function policyIdentity(app, policies, organization) {
  if (app?.domain !== HOST || app.type !== "self_hosted" ||
      !/^[a-zA-Z0-9]{16,128}$/u.test(String(app.aud || ""))) {
    fail("ACCESS_APPLICATION_NOT_TRUSTED");
  }
  if (!Array.isArray(policies) || policies.length !== 1) fail("ACCESS_POLICY_AMBIGUOUS");
  const p = policies[0];
  if (p.decision !== "allow" || p.enabled === false ||
      p.require?.length || p.exclude?.length ||
      !Array.isArray(p.include) || p.include.length !== 1 ||
      Object.keys(p.include[0]).join(",") !== "email") fail("ACCESS_POLICY_NOT_OPERATOR_ONLY");
  const email = p.include[0]?.email?.email;
  if (typeof email !== "string" ||
      !/^[^\s@,]+@[^\s@,]+$/u.test(email) || email.length > 240) {
    fail("ACCESS_OPERATOR_IDENTITY_NOT_DISCOVERED");
  }
  const authDomain = String(organization?.auth_domain || "");
  if (!/^[a-z0-9-]+\.cloudflareaccess\.com$/u.test(authDomain)) {
    fail("ACCESS_ISSUER_INVALID");
  }
  return { email, issuer: "https://" + authDomain, aud: app.aud };
}
async function denyAnonymous(url, accessIssuer) {
  let response;
  try {
    response = await fetch(url, { redirect: "manual", signal: AbortSignal.timeout(20000) });
  } catch { fail("ACCESS_ANONYMOUS_PROBE_UNAVAILABLE"); }
  // An origin 401/403 does not prove the edge Access policy is active.
  // Require a recognizable redirect to Cloudflare Access's login challenge.
  const location = response.headers.get("location") || "";
  let target, original, issuer;
  try {
    target = new URL(location, url);
    original = new URL(url);
    issuer = new URL(accessIssuer);
  } catch { fail("ACCESS_ANONYMOUS_NOT_DENIED"); }
  if ([301, 302, 303, 307, 308].includes(response.status) &&
      target.protocol === "https:" &&
      (target.hostname === issuer.hostname || target.hostname === original.hostname) &&
      target.pathname.startsWith("/cdn-cgi/access/")) return;
  fail("ACCESS_ANONYMOUS_NOT_DENIED");
}
async function latestDeployment(token, accountId, name) {
  const result = await cfGet(token, "/accounts/" + accountId +
    "/workers/scripts/" + name + "/deployments?per_page=5");
  const rows = result?.deployments;
  if (!Array.isArray(rows) || rows.length < 1 || typeof rows[0].id !== "string") {
    fail("CLOUDFLARE_DEPLOYMENT_UNKNOWN");
  }
  return rows[0].id;
}
async function settings(token, accountId, name) {
  return names((await cfGet(token, "/accounts/" + accountId +
    "/workers/scripts/" + name + "/settings")).bindings);
}
async function accessSnapshot(token, accountId) {
  const apps = await cfGet(token, "/accounts/" + accountId + "/access/apps");
  const selected = apps.filter(x => x.domain === HOST);
  if (selected.length !== 1) fail("ACCESS_APPLICATION_AMBIGUOUS");
  const app = selected[0];
  const [policies, org] = await Promise.all([
    cfGet(token, "/accounts/" + accountId + "/access/apps/" + app.id + "/policies"),
    cfGet(token, "/accounts/" + accountId + "/access/organizations"),
  ]);
  return policyIdentity(app, policies, org);
}
async function accountForTargets(token) {
  const accounts = await cfGet(token, "/accounts");
  if (!Array.isArray(accounts)) fail("CLOUDFLARE_ACCOUNTS_INVALID");
  const candidates = [];
  for (const a of accounts) {
    if (!/^[a-f0-9]{32}$/u.test(String(a.id || ""))) continue;
    try {
      const ss = await cfGet(token, "/accounts/" + a.id + "/workers/scripts");
      const found = new Set(ss.map(s => s.id || s.name));
      if (found.has(TARGET_RELAY) && found.has(TARGET_CC)) candidates.push(a.id);
    } catch { /* No access to that account; do not guess it. */ }
  }
  if (candidates.length !== 1) fail("CLOUDFLARE_TARGET_ACCOUNT_AMBIGUOUS");
  return candidates[0];
}
async function preflight(token) {
  const accountId = await accountForTargets(token);
  const [relay, command, access, relayDeployment, ccDeployment] = await Promise.all([
    settings(token, accountId, TARGET_RELAY),
    settings(token, accountId, TARGET_CC),
    accessSnapshot(token, accountId),
    latestDeployment(token, accountId, TARGET_RELAY),
    latestDeployment(token, accountId, TARGET_CC),
  ]);
  for (const name of ["BKE_WORKER_GITHUB_APP_ID",
    "BKE_WORKER_GITHUB_APP_PRIVATE_KEY_PEM", "BKE_WORKER_GITHUB_WEBHOOK_SECRET",
    "BKE_WORKER_RELAY_TOKEN_KEY"]) requireBinding(relay, name, "secret_text");
  requireBinding(relay, "WORKER_SESSIONS", "durable_object_namespace");
  requireBinding(command, "BKE_ACCESS_POLICY_VERIFIED", "secret_text");
  requireBinding(command, "GITHUB_TOKEN", "secret_text");
  requireBinding(command, "BKE_PREPRODUCTION", "plain_text");
  noPriorActivation(relay, command);
  await denyAnonymous(ADMIN_URL, access.issuer);
  return { accountId, relayDeployment, ccDeployment, access };
}
async function verifyTargetChanged(token, accountId, name, oldId) {
  const current = await latestDeployment(token, accountId, name);
  if (current === oldId) fail("DEPLOYMENT_WAS_NOT_PUBLISHED");
  return current;
}
async function verifyBoundRpc(token, accountId) {
  const bindings = await settings(token, accountId, TARGET_CC);
  const binding = bindings.get("BKE_GITHUB_READ_BROKER");
  if (binding?.type !== "service" || binding.service !== TARGET_RELAY ||
      binding.entrypoint !== "CommandCenterReadBroker") {
    fail("ADMIN_PRIVATE_SERVICE_BINDING_NOT_VERIFIED");
  }
}
function secretPut(key, value, cwd) {
  if (!/^[A-Z][A-Z0-9_]+$/u.test(key) || typeof value !== "string" || !value ||
      value.includes("\n")) fail("ADMIN_SECRET_INPUT_INVALID");
  wrangler(["secret", "put", key, "--env", "preproduction"], cwd, {
    input: value + "\n", code: "ADMIN_PREPRODUCTION_SECRET_WRITE_FAILED",
  });
}
async function start() {
  if (!SHA.test(workerSha || "") || !SHA.test(commandSha || "") ||
      !workerArg || !commandArg || Number(process.versions.node.split(".")[0]) < 22) {
    fail("SOURCE_OR_NODE_VERSION_INVALID");
  }
  const workerRoot = resolve(workerArg);
  const commandRoot = resolve(commandArg);
  const relayRoot = join(workerRoot, "cloudflare-relay");
  if (workerRoot === commandRoot) fail("REPOSITORY_IDENTITY_AMBIGUOUS");

  // Only the provider's official login opens a browser. No credential typing.
  try { wrangler(["whoami"], relayRoot, { code: "WRANGLER_AUTH_UNAVAILABLE" }); }
  catch {
    console.log("BKE ADMIN: Cloudflare official login required.");
    wrangler(["login"], relayRoot, { interactive: true, code: "WRANGLER_LOGIN_FAILED" });
    wrangler(["whoami"], relayRoot, { code: "WRANGLER_AUTH_UNAVAILABLE" });
  }
  const json = wrangler(["auth", "token", "--json"], relayRoot, {
    code: "WRANGLER_CREDENTIAL_READ_DENIED",
  });
  let auth;
  try { auth = JSON.parse(json.slice(json.indexOf("{"))); } catch { fail("WRANGLER_TOKEN_RESPONSE_INVALID"); }
  if (!["oauth", "api_token"].includes(auth?.type) ||
      typeof auth.token !== "string" || !auth.token) fail("WRANGLER_TOKEN_MODE_UNSUPPORTED");
  const token = auth.token; // only in process memory; never printed or persisted.
  const snapshot = await preflight(token);
  console.log("BKE ADMIN: Access policy + two PREPRODUCTION Workers verified. Running source checks.");

  run("npm", ["run", "check"], relayRoot, { code: "WORKER_RELAY_SOURCE_CHECK_FAILED" });
  run("npm", ["ci"], commandRoot, { code: "COMMAND_CENTER_INSTALL_FAILED" });
  run("npm", ["test"], commandRoot, { code: "COMMAND_CENTER_TESTS_FAILED" });
  run("npm", ["run", "check"], commandRoot, { code: "COMMAND_CENTER_SOURCE_CHECK_FAILED" });
  run("npm", ["run", "cloudflare:dry-run"], commandRoot, {
    code: "COMMAND_CENTER_PREPRODUCTION_DRY_RUN_FAILED",
  });
  const beforeRelay = await latestDeployment(token, snapshot.accountId, TARGET_RELAY);
  const beforeCC = await latestDeployment(token, snapshot.accountId, TARGET_CC);
  if (beforeRelay !== snapshot.relayDeployment || beforeCC !== snapshot.ccDeployment) {
    fail("DEPLOYMENT_BASELINE_CHANGED");
  }
  const stillAllowed = await accessSnapshot(token, snapshot.accountId);
  if (JSON.stringify(stillAllowed) !== JSON.stringify(snapshot.access)) fail("ACCESS_POLICY_CHANGED");
  await denyAnonymous(ADMIN_URL, snapshot.access.issuer);
  checkpoint("PREFLIGHT_PASS", workerSha, commandSha);
  console.log("BKE ADMIN: deploying authenticated PREPRODUCTION relay.");
  let phase = "RELAY_DEPLOY_STARTED";
  try {
    wrangler(["deploy", "--env", "preproduction"], relayRoot, { code: "RELAY_DEPLOY_FAILED" });
    await verifyTargetChanged(token, snapshot.accountId, TARGET_RELAY, beforeRelay);
    checkpoint("RELAY_SOURCE_DEPLOYED", workerSha, commandSha);
    phase = "RELAY_FLAGS_STARTED";
    secretPut("BKE_ADMIN_BROKER_ENABLED", "true", relayRoot);
    secretPut("BKE_ADMIN_REPO_CATALOG_ENABLED", "true", relayRoot);
    const relayBindings = await settings(token, snapshot.accountId, TARGET_RELAY);
    for (const name of ADMIN_FLAG_NAMES) requireBinding(relayBindings, name, "secret_text");
    checkpoint("RELAY_BROKER_ENABLED", workerSha, commandSha);
    phase = "COMMAND_CENTER_DEPLOY_STARTED";
    if (await latestDeployment(token, snapshot.accountId, TARGET_CC) !== beforeCC) {
      fail("COMMAND_CENTER_DEPLOYMENT_RACE");
    }
    wrangler(["deploy", "--env", "preproduction"], commandRoot, { code: "COMMAND_CENTER_DEPLOY_FAILED" });
    await verifyTargetChanged(token, snapshot.accountId, TARGET_CC, beforeCC);
    await verifyBoundRpc(token, snapshot.accountId);
    checkpoint("COMMAND_CENTER_SOURCE_AND_PRIVATE_BINDING", workerSha, commandSha);
    phase = "ADMIN_IDENTITY_CONFIG_STARTED";
    const afterAccess = await accessSnapshot(token, snapshot.accountId);
    if (JSON.stringify(afterAccess) !== JSON.stringify(snapshot.access)) fail("ACCESS_POLICY_CHANGED");
    await denyAnonymous(ADMIN_URL, snapshot.access.issuer);
    secretPut("BKE_ADMIN_ACCESS_ISSUER", snapshot.access.issuer, commandRoot);
    secretPut("BKE_ADMIN_ACCESS_AUD", snapshot.access.aud, commandRoot);
    secretPut("BKE_ADMIN_EMAILS", snapshot.access.email, commandRoot);
    secretPut("GITHUB_DISCOVERY_AUTH_MODE", "catalog", commandRoot);
    // Enable last: Access JWT verified before RPC, only fixed approved catalog.
    secretPut("BKE_ADMIN_DISCOVERY_ENABLED", "true", commandRoot);
    const ccBindings = await settings(token, snapshot.accountId, TARGET_CC);
    for (const name of CC_ADMIN_NAMES) requireBinding(ccBindings, name, "secret_text");
    await verifyBoundRpc(token, snapshot.accountId);
    await denyAnonymous(ADMIN_URL, snapshot.access.issuer);
    phase = "OWNER_ACCESS_LOGIN_REQUIRED";
    checkpoint(phase, workerSha, commandSha);
  } catch (error) {
    checkpoint("BLOCKED_AFTER_MUTATION_" + phase, workerSha, commandSha);
    throw error;
  }
  console.log("BKE ADMIN: PREPRODUCTION configured; anonymous Access denial verified.");
  console.log("BKE ADMIN: Human Admin MUST open  " + ADMIN_URL + "  and complete Cloudflare Access login.");
  console.log("BKE ADMIN: OWNER_LOGIN_REQUIRED (NOT YET LIVE ACCEPTED); production LOCKED.");
}
// The security predicates are imported by CI tests without launching any CLI.
export { policyIdentity, noPriorActivation, names, denyAnonymous };
if (fileURLToPath(import.meta.url) === resolve(process.argv[1] || "")) {
start().catch(error => {
    // Sanitized error code only; no CLI/JWT/token/body details.
    const code = /^[A-Z0-9_]+$/u.test(error?.message || "")
      ? error.message : "UNCLASSIFIED_ACTIVATION_ERROR";
    console.error("BKE ADMIN: FAIL-CLOSED " + code);
    process.exitCode = 1;
  });
}
