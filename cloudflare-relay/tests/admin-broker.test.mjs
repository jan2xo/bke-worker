import test from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { mintAdminReadToken } from "../src/github-app.js";
import { fulfillCommandCenterAdminRead } from "../src/admin-broker.js";

let key;
function privateKeyPem() {
  if (!key) {
    key = generateKeyPairSync("rsa", {
      modulusLength: 2048,
      publicKeyEncoding: { type: "spki", format: "pem" },
      privateKeyEncoding: { type: "pkcs8", format: "pem" },
    }).privateKey;
  }
  return key;
}
const env = () => ({
  BKE_WORKER_GITHUB_APP_ID: "12345",
  BKE_WORKER_GITHUB_APP_PRIVATE_KEY_PEM: privateKeyPem(),
  BKE_ADMIN_BROKER_ENABLED: "true",
});
const scope = { purpose: "admin_source_discovery", repository: "jan2xo/bke-worker" };

test("Admin broker OFF by default and rejects wrong purpose before credential access", async () => {
  let issued = 0;
  const mint = async () => { issued++; return {}; };
  await assert.rejects(() => fulfillCommandCenterAdminRead({}, scope, mint), /ADMIN_BROKER_LOCKED/);
  await assert.rejects(() => fulfillCommandCenterAdminRead(env(), { ...scope, repository: "jan2xo/another" }, mint), /ADMIN_BROKER_SCOPE_INVALID/);
  await assert.rejects(() => fulfillCommandCenterAdminRead(env(), { ...scope, purpose: "worker_mutation" }, mint), /ADMIN_BROKER_SCOPE_INVALID/);
  await assert.rejects(() => fulfillCommandCenterAdminRead(env(), { ...scope, role: "admin" }, mint), /ADMIN_BROKER_SCOPE_INVALID/);
  assert.equal(issued, 0);
});

test("Admin broker rejects minted tokens with wrong repo, principal, or elevated permissions", async () => {
  const good = {
    token: "ghs_fake", expires_at: new Date(Date.now() + 15 * 60000).toISOString(),
    repository: "jan2xo/bke-worker", principal: "github_app_installation",
    permissions: { contents: "read", issues: "read", pull_requests: "read" },
  };
  assert.deepEqual(await fulfillCommandCenterAdminRead(env(), scope, async () => good), good);
  for (const mutant of [
    { ...good, repository: "jan2xo/other" },
    { ...good, principal: "admin_user" },
    { ...good, permissions: { ...good.permissions, contents: "write" } },
    { ...good, permissions: { ...good.permissions, issues: "write" } },
    { ...good, permissions: { ...good.permissions, pull_requests: "write" } },
  ]) {
    await assert.rejects(
      () => fulfillCommandCenterAdminRead(env(), scope, async () => mutant),
      /ADMIN_BROKER_TOKEN_SCOPE_INVALID/,
    );
  }
});

test("Admin GitHub App request mints narrowly read-only token for fixed repo ID", async () => {
  const calls = [];
  const out = await mintAdminReadToken(env(), async (url, options = {}) => {
    calls.push({ url, options });
    if (url.endsWith("/repos/jan2xo/bke-worker/installation")) {
      return Response.json({
        id: 98765, repository_selection: "selected",
        permissions: { contents: "write", issues: "write", pull_requests: "write", metadata: "read" },
      });
    }
    if (url.endsWith("/app/installations/98765/access_tokens")) {
      return Response.json({
        token: "ghs_fixturescoped",
        expires_at: new Date(Date.now() + 45 * 60000).toISOString(),
      }, { status: 201 });
    }
    throw new Error("unexpected GitHub route");
  });
  assert.equal(calls.length, 2);
  assert.equal(calls[0].url, "https://api.github.com/repos/jan2xo/bke-worker/installation");
  assert.equal(calls[1].url, "https://api.github.com/app/installations/98765/access_tokens");
  const request = JSON.parse(calls[1].options.body);
  assert.deepEqual(request.repository_ids, [1354026486]);
  assert.deepEqual(request.permissions, {
    contents: "read", issues: "read", pull_requests: "read",
  });
  assert.equal(request.repositories, undefined);
  assert.equal(out.principal, "github_app_installation");
  assert.equal(out.repository, "jan2xo/bke-worker");
  assert.equal(out.token, "ghs_fixturescoped");
});

test("Refuses stale/implausible token TTL, API denial, invalid token responses", async () => {
  const mkFetch = (status, token, minutes) => async (url) =>
    url.endsWith("/installation") ?
      Response.json({
        id: 98765,
        repository_selection: "selected",
        permissions: { contents: "write", issues: "write", pull_requests: "write" },
      }) :
      Response.json({
        token, expires_at: new Date(Date.now() + minutes * 60000).toISOString(),
      }, { status });
  for(const [status, token, minutes, expected] of [
    [403, "ghs_valid", 45, "ADMIN_GITHUB_TOKEN_MINT_REJECTED"],
    [201, "ghs_valid", -5, "ADMIN_GITHUB_TOKEN_INVALID"],
    [201, "ghs_valid", 1, "ADMIN_GITHUB_TOKEN_INVALID"],
    [201, "ghs_valid", 120, "ADMIN_GITHUB_TOKEN_INVALID"],
    [201, "ghu_user_pat", 45, "ADMIN_GITHUB_TOKEN_INVALID"],
  ]) {
    await assert.rejects(
      () => mintAdminReadToken(env(), mkFetch(status, token, minutes)),
      new RegExp(expected),
    );
  }
});

test("Public relay HTTP routes never advertise private broker RPC or token", async () => {
  const { readFileSync } = await import("node:fs");
  const source = readFileSync(new URL("../src/index.js", import.meta.url), "utf8");
  assert.match(source, /class CommandCenterReadBroker extends WorkerEntrypoint/u);
  assert.doesNotMatch(source, /url.pathname === "\/admin"/u);
  assert.doesNotMatch(source, /url.pathname === "\/github\/admin\/read-token"/u);
  assert.match(source, /mintReadOnlyGitHubToken/u);
});
