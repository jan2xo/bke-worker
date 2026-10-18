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

function fixture({ permissions = { metadata: "read" }, pages, status = 201, token = "ghs_testcredential" } = {}) {
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
        expires_at: new Date(Date.now() + 35 * 60000).toISOString(),
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
  assert.deepEqual(JSON.parse(f.calls[1].options.body), { permissions: {} });
  assert.equal(f.calls[2].options.headers.authorization, "Bearer ghs_testcredential");
  assert.equal(result.total_visible, 2);
  assert.deepEqual(result.repositories.map(r => r.full_name),
    ["jan2xo/BKE_RENDER_DOCK", "jan2xo/bke-worker"]);
  assert.doesNotMatch(JSON.stringify(result), /ghs_|test-fixture-jwt|expires_at/);
  assert.deepEqual(await fulfillCommandCenterAdminCatalog(env, scope, async () => result), result);
});

test("catalog fails closed on extra permissions or missing grant", async () => {
  for (const permissions of [{ metadata: "read", contents: "read" },
    { metadata: "write" }, {}, { issues: "write" }, []]) {
    const f = fixture({ permissions });
    await assert.rejects(() => listAdminInstalledRepositories(env, f.fetchStub, createJwt),
      /ADMIN_CATALOG_TOKEN_SCOPE_INVALID/);
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
  assert.deepEqual(JSON.parse(f.calls[1].options.body), { permissions: {} });
  assert.equal(f.calls[2].options.headers.authorization, "Bearer " + token);
  assert.equal(result.total_visible, 2);
  assert.doesNotMatch(JSON.stringify(result), /ghs_|\.b_c-d\./);
});

test("catalog continues to reject elevated grants, invalid bearer types and header injection", async () => {
  const accepted = "ghs_12345_" + "a".repeat(75) + ".b_c-d." + "e".repeat(80);
  for (const permissions of [{ metadata: "read", contents: "read" },
    { metadata: "read", issues: "write" }, { metadata: "write" }, {},
    { contents: "write" }]) {
    const f = fixture({ permissions, token: accepted });
    await assert.rejects(
      () => listAdminInstalledRepositories(env, f.fetchStub, createJwt),
      /ADMIN_CATALOG_TOKEN_SCOPE_INVALID/,
    );
    assert.equal(f.calls.length, 2);
  }
  for (const token of ["ghu_not_installation", "github_pat_spoof",
    "ghs_", "ghs_abc def", "ghs_abc\\r\\nX-Evil: injected",
    "ghs_" + "a".repeat(8193)]) {
    const f = fixture({ token });
    await assert.rejects(
      () => listAdminInstalledRepositories(env, f.fetchStub, createJwt),
      /ADMIN_CATALOG_TOKEN_SCOPE_INVALID/,
    );
    assert.equal(f.calls.length, 2);
  }
});
