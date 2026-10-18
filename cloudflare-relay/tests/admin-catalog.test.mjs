import test from "node:test";
import assert from "node:assert/strict";
import { listAdminInstalledRepositories } from "../src/github-app.js";
import { fulfillCommandCenterAdminCatalog } from "../src/admin-broker.js";

const env = {
  BKE_WORKER_GITHUB_APP_ID: "1234",
  BKE_WORKER_GITHUB_APP_PRIVATE_KEY_PEM: "test-only-not-a-key",
  BKE_ADMIN_BROKER_ENABLED: "true",
  BKE_ADMIN_REPO_CATALOG_ENABLED: "true",
};
const scope = { purpose: "admin_installation_repository_catalog" };
const fixtureRepo = (id, name) => ({
  id, full_name: "jan2xo/" + name, default_branch: "main",
  private: true, archived: false,
});
const createJwt = async () => "test-fixture-jwt";

function fixture({ permissions = { metadata: "read" }, pages, status = 201, token = "ghs_testcredential", expiresAt } = {}) {
  const calls = [];
  const fetchStub = async (url, options = {}) => {
    calls.push({ url, options });
    if (url.endsWith("/repos/jan2xo/bke-worker/installation")) {
      return Response.json({ id: 51, permissions: {
        contents: "write", issues: "write", pull_requests: "write",
      } });
    }
    if (url.endsWith("/app/installations/51/access_tokens")) {
      return Response.json({ token,
        expires_at: expiresAt === undefined ? new Date(Date.now() + 35 * 60000).toISOString() : expiresAt,
        permissions }, { status });
    }
    if (url.startsWith("https://api.github.com/installation/repositories?")) {
      const page = Number(new URL(url).searchParams.get("page"));
      return Response.json(pages?.(page) || {
        total_count: 2, repositories: [fixtureRepo(2, "bke-worker"),
          fixtureRepo(3, "BKE_RENDER_DOCK")],
      });
    }
    throw new Error("UNEXPECTED_PROVIDER_ENDPOINT");
  };
  return { fetchStub, calls };
}

test("catalog rejects unsafe owner scopes before GitHub", async () => {
  let invoked = 0;
  const collect = async () => { invoked++; return {}; };
  await assert.rejects(() => fulfillCommandCenterAdminCatalog({}, scope, collect), /ADMIN_CATALOG_LOCKED/);
  await assert.rejects(() => fulfillCommandCenterAdminCatalog(env, { purpose: "other" }, collect), /ADMIN_CATALOG_PURPOSE_INVALID/);
  await assert.rejects(() => fulfillCommandCenterAdminCatalog(env, { ...scope, extra: true }, collect), /ADMIN_CATALOG_PURPOSE_INVALID/);
  assert.equal(invoked, 0);
});

test("catalog returns only approved repository metadata and no credential", async () => {
  const f = fixture();
  const result = await listAdminInstalledRepositories(env, f.fetchStub, createJwt);
  assert.equal(f.calls.length, 3);
  assert.deepEqual(JSON.parse(f.calls[1].options.body), { permissions: { metadata: "read" } });
  assert.equal(f.calls[2].options.headers.authorization, "Bearer ghs_testcredential");
  assert.equal(result.total_visible, 2);
  assert.deepEqual(result.repositories.map(r => r.full_name),
    ["jan2xo/BKE_RENDER_DOCK", "jan2xo/bke-worker"]);
  assert.doesNotMatch(JSON.stringify(result), /ghs_|test-fixture-jwt|expires_at/);
  assert.deepEqual(await fulfillCommandCenterAdminCatalog(env, scope, async () => result), result);
});

test("catalog fails closed on extra permissions or missing grant", async () => {
  for (const permissions of [{ metadata: "read", contents: "read" },
    { metadata: "write" }, { issues: "write" }, [], null]) {
    const f = fixture({ permissions });
    await assert.rejects(() => listAdminInstalledRepositories(env, f.fetchStub, createJwt),
      /ADMIN_CATALOG_TOKEN_GRANT_INVALID/);
    assert.equal(f.calls.length, 2);
  }
});

test("catalog detects duplicate, changing and truncated provider pages", async () => {
  const first = { total_count: 2, repositories: [fixtureRepo(1, "one")] };
  const second = { total_count: 2, repositories: [fixtureRepo(2, "two")] };
  const good = fixture({ pages: page => page === 1 ? first : second });
  const result = await listAdminInstalledRepositories(env, good.fetchStub, createJwt);
  assert.equal(result.total_visible, 2);
  const duplicate = fixture({ pages: () => first });
  await assert.rejects(() => listAdminInstalledRepositories(env, duplicate.fetchStub, createJwt),
    /ADMIN_CATALOG_DUPLICATE_REPOSITORY/);
  const changed = fixture({ pages: page => page === 1 ? first :
    { ...second, total_count: 3 } });
  await assert.rejects(() => listAdminInstalledRepositories(env, changed.fetchStub, createJwt),
    /ADMIN_CATALOG_REPOSITORIES_INVALID/);
  const truncated = fixture({ pages: () => ({ total_count: 501, repositories: [] }) });
  await assert.rejects(() => listAdminInstalledRepositories(env, truncated.fetchStub, createJwt),
    /ADMIN_CATALOG_REPOSITORIES_INVALID/);
});

test("catalog rejects invalid repository paths before returning a partial result", async () => {
  const f = fixture({ pages: () => ({ total_count: 1,
    repositories: [{ ...fixtureRepo(10, "ok"), full_name: "jan2xo/../invalid" }] }) });
  await assert.rejects(() => listAdminInstalledRepositories(env, f.fetchStub, createJwt),
    /ADMIN_CATALOG_REPOSITORY_INVALID/);
});

test("catalog accepts GitHub 2026 stateless JWT-format installation tokens without introspection", async () => {
  // Synthetic token: no real GitHub credential or signing material in tests.
  const token = "ghs_12345_" + "a".repeat(75) + ".b_c-d." + "e".repeat(80);
  const f = fixture({ token });
  const result = await listAdminInstalledRepositories(env, f.fetchStub, createJwt);
  assert.equal(f.calls.length, 3);
  assert.deepEqual(JSON.parse(f.calls[1].options.body), { permissions: { metadata: "read" } });
  assert.equal(f.calls[2].options.headers.authorization, "Bearer " + token);
  assert.equal(result.total_visible, 2);
  assert.doesNotMatch(JSON.stringify(result), /ghs_|\.b_c-d\./);
});

test("catalog continues to reject elevated grants, invalid bearer types and header injection", async () => {
  const accepted = "ghs_12345_" + "a".repeat(75) + ".b_c-d." + "e".repeat(80);
  for (const permissions of [{ metadata: "read", contents: "read" },
    { metadata: "read", issues: "write" }, { metadata: "write" },
    { contents: "write" }]) {
    const f = fixture({ permissions, token: accepted });
    await assert.rejects(
      () => listAdminInstalledRepositories(env, f.fetchStub, createJwt),
      /ADMIN_CATALOG_TOKEN_GRANT_INVALID/,
    );
    assert.equal(f.calls.length, 2);
  }
  for (const token of ["ghu_not_installation", "github_pat_spoof",
    "ghs_", "ghs_abc def", "ghs_abc" + String.fromCharCode(13, 10) + "X-Evil: injected",
    "ghs_" + "a".repeat(8193)]) {
    const f = fixture({ token });
    await assert.rejects(
      () => listAdminInstalledRepositories(env, f.fetchStub, createJwt),
      /ADMIN_CATALOG_TOKEN_BEARER_INVALID/,
    );
    assert.equal(f.calls.length, 2);
  }
});

test("catalog rejects invalid TTL separately and leaks no token metadata", async () => {
  const values = [null, "invalid", "2000-01-01T00:00:00Z",
    new Date(Date.now() + 30000).toISOString(),
    new Date(Date.now() + 90 * 60000).toISOString()];
  for (const expiresAt of values) {
    const f = fixture({ expiresAt });
    await assert.rejects(() => listAdminInstalledRepositories(env, f.fetchStub, createJwt),
      error => {
        assert.equal(error.message, "ADMIN_CATALOG_TOKEN_EXPIRY_INVALID");
        assert.doesNotMatch(error.message, /ghs_|expires_at|permissions|2000-01-01/i);
        return true;
      });
    assert.equal(f.calls.length, 2);
  }
});

test("malformed bearer and excessive grants stay distinct and stop before catalog read", async () => {
  for (const input of [
    { token: "ghs_abc" + String.fromCharCode(13, 10) + "X-Evil: injected",
      expected: "ADMIN_CATALOG_TOKEN_BEARER_INVALID" },
    { token: null, expected: "ADMIN_CATALOG_TOKEN_BEARER_INVALID" },
    { token: "ghs_1234567", permissions: { checks: "read" },
      expected: "ADMIN_CATALOG_TOKEN_GRANT_INVALID" },
    { token: "ghs_1234567", permissions: { metadata: "read", contents: "read" },
      expected: "ADMIN_CATALOG_TOKEN_GRANT_INVALID" },
  ]) {
    const f = fixture(input);
    await assert.rejects(() => listAdminInstalledRepositories(env, f.fetchStub, createJwt),
      error => {
        assert.equal(error.message, input.expected);
        assert.doesNotMatch(error.message, /injected|metadata|contents|ghs_/);
        return true;
      });
    assert.equal(f.calls.length, 2);
    assert.deepEqual(JSON.parse(f.calls[1].options.body), { permissions: { metadata: "read" } });
  }
});

test("valid metadata-only token still enumerates only existing approved repositories", async () => {
  const f = fixture({
    token: "ghs_12345_" + "a".repeat(60) + ".payload.signature",
    permissions: { metadata: "read" },
    expiresAt: new Date(Date.now() + 15 * 60000).toISOString(),
  });
  const result = await listAdminInstalledRepositories(env, f.fetchStub, createJwt);
  assert.equal(result.total_visible, 2);
  assert.equal(f.calls.length, 3);
  assert.doesNotMatch(JSON.stringify(result), /ghs_|payload.signature/);
});

test("catalog rejects ambiguous empty returned grants even after explicit metadata-read mint", async () => {
  const f = fixture({
    permissions: {},
    token: "ghs_12345_" + "a".repeat(68) + ".payload.signature",
  });
  await assert.rejects(() => listAdminInstalledRepositories(env, f.fetchStub, createJwt),
    /ADMIN_CATALOG_TOKEN_GRANT_INVALID/);
  assert.deepEqual(JSON.parse(f.calls[1].options.body),
    { permissions: { metadata: "read" } });
  assert.equal(f.calls.length, 2); // Never query repositories on ambiguous grants.
});

test("catalog rejects optional grants, metadata write and missing or ambiguous grant object", async () => {
  for (const permissions of [
    {contents:"read"}, {contents:"write"}, {issues:"read"},
    {metadata:"read", contents:"read"},
    {metadata:"read", checks:"read"}, {metadata:"write"},
    {actions:"read"}, {}, ["metadata", "read"], null, "metadata",
  ]) {
    const f = fixture({permissions});
    await assert.rejects(() => listAdminInstalledRepositories(env, f.fetchStub, createJwt),
      /ADMIN_CATALOG_TOKEN_GRANT_INVALID/);
    assert.equal(f.calls.length, 2);
  }
});

test("explicit metadata-only mint cannot silently inherit dispatcher privileges", async () => {
  const f = fixture({ permissions: {
    metadata: "read", contents: "write", issues: "write",
    pull_requests: "write",
  } });
  await assert.rejects(
    () => listAdminInstalledRepositories(env, f.fetchStub, createJwt),
    /ADMIN_CATALOG_TOKEN_GRANT_INVALID/,
  );
  assert.deepEqual(JSON.parse(f.calls[1].options.body),
    { permissions: { metadata: "read" } });
  assert.equal(f.calls.length, 2);
});

test("catalog rejects extra grants even where the provider returned metadata-read", async () => {
  for (const permissions of [
    { metadata:"read", contents:"read" },
    { metadata:"read", issues:"read" },
    { metadata:"read", checks:"read" },
    { metadata:"read", pull_requests:"write" },
  ]) {
    const f = fixture({ permissions });
    await assert.rejects(
      () => listAdminInstalledRepositories(env, f.fetchStub, createJwt),
      /ADMIN_CATALOG_TOKEN_GRANT_INVALID/,
    );
    assert.equal(f.calls.length, 2);
  }
});


test("catalog runtime stage failures stay fixed, redacted and before unsafe results", async () => {
  const stages = [
    { stage:"signing", code:"ADMIN_CATALOG_APP_SIGNING_UNAVAILABLE", calls:0 },
    { stage:"installation", code:"ADMIN_CATALOG_INSTALLATION_LOOKUP_UNAVAILABLE", calls:1 },
    { stage:"mint", code:"ADMIN_CATALOG_TOKEN_TRANSPORT_UNAVAILABLE", calls:2 },
    { stage:"repository-list", code:"ADMIN_CATALOG_REPOSITORIES_TRANSPORT_UNAVAILABLE", calls:3 },
  ];
  for (const {stage,code,calls} of stages) {
    const f = fixture();
    const fetchMock = async (url, options) => {
      if ((stage === "installation" && url.includes("/repos/jan2xo/bke-worker/installation")) ||
          (stage === "mint" && url.includes("/app/installations/51/access_tokens")) ||
          (stage === "repository-list" && url.includes("/installation/repositories?"))) {
        f.calls.push({url,options});
        throw new TypeError("TOKEN_SENSITIVE ghs_private jwt material");
      }
      return f.fetchStub(url,options);
    };
    const sign = stage === "signing"
      ? async () => { throw new TypeError("PRIVATE_RSA_MATERIAL"); }
      : createJwt;
    await assert.rejects(() => listAdminInstalledRepositories(env,fetchMock,sign), error => {
      assert.equal(error.message,code);
      assert.doesNotMatch(error.message,/ghs_|TOKEN_|RSA_MATERIAL|private|jwt|material/i);
      return true;
    });
    assert.equal(f.calls.length,calls);
  }
});

test("catalog keeps bounded safe GitHub HTTP failure codes", async () => {
  const unavailableInstallation = fixture();
  const statusInstallation = async (url,options) =>
    url.includes("/repos/jan2xo/bke-worker/installation")
      ? new Response("not available",{status:403})
      : unavailableInstallation.fetchStub(url,options);
  await assert.rejects(
    () => listAdminInstalledRepositories(env,statusInstallation,createJwt),
    /GITHUB_APP_INSTALLATION_RESOLUTION_FAILED:403/);
  const rejectedToken = fixture({status:422});
  await assert.rejects(() => listAdminInstalledRepositories(env,rejectedToken.fetchStub,createJwt),
    /ADMIN_CATALOG_TOKEN_REJECTED/);
  assert.equal(rejectedToken.calls.length,2);
  const rejectedList = fixture();
  const listFetch = async (url,options) =>
    url.includes("/installation/repositories?")
      ? new Response("forbidden",{status:403})
      : rejectedList.fetchStub(url,options);
  await assert.rejects(() => listAdminInstalledRepositories(env,listFetch,createJwt),
    /ADMIN_CATALOG_REPOSITORIES_UNAVAILABLE/);
  assert.equal(rejectedList.calls.length,2);
});
