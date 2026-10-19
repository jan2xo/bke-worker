import test from "node:test";
import assert from "node:assert/strict";
import { listInstalledWorkerAssignments } from "../src/admin-assignment-inventory.js";
import { fulfillCommandCenterAdminAssignments } from "../src/admin-broker.js";

const env = {
  BKE_WORKER_GITHUB_APP_ID: "123",
  BKE_WORKER_GITHUB_APP_PRIVATE_KEY_PEM: "fixture-not-a-real-private-key",
  BKE_ADMIN_BROKER_ENABLED: "true",
  BKE_ADMIN_PR_INVENTORY_ENABLED: "true",
};
const scope = { purpose: "admin_worker_assignment_inventory" };
const sign = async () => "fixture-app-jwt";
const repo = (id, name) => ({ id, full_name: "jan2xo/" + name });
const pr = (number, labels = [], sha = "a".repeat(40)) => ({
  number, state: "open", head: { sha },
  labels: labels.map(name => ({ name })),
});
const baseRepos = [repo(1354026486, "bke-worker"), repo(2, "render-dock")];
function fixture({
  repositories = baseRepos, grants = { metadata: "read", pull_requests: "read" },
  prPages, repoPages, installation = {
    id: 51, repository_selection: "selected", permissions: { pull_requests: "write" },
  }, expiresAt, token = "ghs_scopedopaque", redirects = [], throws = [], status = {},
  overrideGraph,
} = {}) {
  const calls = [];
  const fetcher = async (url, options = {}) => {
    calls.push({ url, options });
    assert.ok(url.startsWith("https://api.github.com/"));
    if (throws.some(x => url.includes(x))) throw Error("sensitive transport failure");
    if (redirects.some(x => url.includes(x))) {
      return new Response("", { status: 302, headers: { Location: "https://untrusted.test/" } });
    }
    const u = new URL(url);
    if (u.pathname === "/repos/jan2xo/bke-worker/installation") {
      return Response.json(installation, { status: status.installation || 200 });
    }
    if (u.pathname === "/app/installations/51/access_tokens") {
      return Response.json({
        token, permissions: grants,
        expires_at: expiresAt ?? new Date(Date.now() + 35 * 60000).toISOString(),
      }, { status: status.mint || 201 });
    }
    if (u.pathname === "/installation/repositories") {
      const page = Number(u.searchParams.get("page"));
      return Response.json(repoPages ? repoPages(page) : {
        total_count: repositories.length,
        repositories: page === 1 ? repositories : [],
      }, { status: status.repos || 200 });
    }
    if (u.pathname === "/graphql") {
      const body = JSON.parse(options.body);
      assert.equal(typeof body.query, "string");
      assert.match(body.query, /pullRequests\(first:100,states:OPEN/u);
      assert.doesNotMatch(body.query, /mutation|contents|issues/u);
      const data = {};
      for (let i = 0; Object.hasOwn(body.variables, "owner" + i); i++) {
        const name = body.variables["owner" + i] + "/" + body.variables["name" + i];
        const match = repositories.find(x => x.full_name === name);
        const cursor = body.variables["cursor" + i];
        const page = cursor === null ? 1 : Number(String(cursor).replace("page", ""));
        const get = p => {
          const arr = prPages?.(name, p);
          return Array.isArray(arr) ? arr : [];
        };
        const first = get(1);
        let totalCount = first.length;
        if (first.length === 100) {
          for (let p = 2; p <= 5; p++) {
            const next = get(p);
            totalCount += next.length;
            if (next.length < 100) break;
          }
        }
        const items = get(page);
        data["r" + i] = {
          databaseId: match?.id, nameWithOwner: name,
          pullRequests: {
            totalCount,
            pageInfo: {
              hasNextPage: page * 100 < totalCount,
              endCursor: "page" + (page + 1),
            },
            nodes: items.map(x => ({
              number: x.number,
              state: typeof x.state === "string" ? x.state.toUpperCase() : x.state,
              headRefOid: x.head?.sha,
              labels: { nodes: x.labels, pageInfo: { hasNextPage: false } },
            })),
          },
        };
      }
      return Response.json(overrideGraph ? overrideGraph(data) : { data },
        { status: status.pr || 200 });
    }
    throw Error("unexpected fixture request");
  };
  return { fetcher, calls };
}
const collect = async f => listInstalledWorkerAssignments(env, f.fetcher, sign);
const denied = async (call, code) => assert.rejects(call, { message: code });

test("private RPC is default locked and has strict purpose-only request", async () => {
  let invoked = 0;
  const collectFake = async () => { invoked++; return {}; };
  for (const e of [{}, { ...env, BKE_ADMIN_PR_INVENTORY_ENABLED: "false" },
    { ...env, BKE_ADMIN_BROKER_ENABLED: undefined }]) {
    await denied(() => fulfillCommandCenterAdminAssignments(e, scope, collectFake),
      "ADMIN_ASSIGNMENT_LOCKED");
  }
  for (const input of [null, {}, { purpose: "read_admin_token" },
    { ...scope, repository: "jan2xo/arbitrary" },
    { ...scope, installation_id: "51" }, { ...scope, worker_id: "worker-a" }]) {
    await denied(() => fulfillCommandCenterAdminAssignments(env, input, collectFake),
      "ADMIN_ASSIGNMENT_PURPOSE_INVALID");
  }
  assert.equal(invoked, 0);
});

test("exact read-only GitHub installation permissions; no token crosses RPC", async () => {
  const f = fixture({ prPages: (name, page) => page !== 1 ? [] :
    name === "jan2xo/bke-worker" ?
      [pr(10, ["triage", "bke-worker:worker-a"], "b".repeat(40)), pr(11)] :
      [pr(3, ["bke-worker:worker-b"], "c".repeat(40))],
  });
  const observed = await collect(f);
  const safe = await fulfillCommandCenterAdminAssignments(env, scope, async () => observed);
  assert.deepEqual(safe, {
    principal: "github_app_installation",
    authority: "EXISTING_GITHUB_APP_INSTALLATION",
    repository_scope: "INSTALLATION_APPROVED_ONLY",
    installation_id: "51",
    total_visible_repositories: 2,
    enumerated_open_pull_requests: 3,
    consistency: "NON_ATOMIC_ENUMERATION",
    worker_assignments: [
      { repository: "jan2xo/bke-worker", repository_id: 1354026486, number: 10,
        state: "open", head_sha: "b".repeat(40), labels: ["bke-worker:worker-a"] },
      { repository: "jan2xo/render-dock", repository_id: 2, number: 3,
        state: "open", head_sha: "c".repeat(40), labels: ["bke-worker:worker-b"] },
    ],
  });
  const mint = f.calls.find(c => c.url.endsWith("/access_tokens"));
  assert.deepEqual(JSON.parse(mint.options.body), {
    permissions: { metadata: "read", pull_requests: "read" },
  });
  assert.equal(f.calls.length, 4);
  for (const item of f.calls) assert.equal(item.options.redirect, "manual");
  assert.doesNotMatch(JSON.stringify(safe), /ghs_|fixture-app-jwt|expires_at|private-key/u);
});

test("rejects missing or higher-than-requested permissions and invalid TTL", async () => {
  for (const grants of [{ metadata: "read" }, { pull_requests: "read" },
    { metadata: "read", pull_requests: "write" },
    { metadata: "read", pull_requests: "read", contents: "read" },
    { metadata: "write", pull_requests: "read" }, {}, null]) {
    const f = fixture({ grants });
    await denied(() => collect(f), "ADMIN_ASSIGNMENT_TOKEN_SCOPE_INVALID");
    assert.equal(f.calls.length, 2);
  }
  for (const config of [
    { token: "ghp_personal" },
    { expiresAt: new Date(Date.now() + 60000).toISOString() },
    { expiresAt: new Date(Date.now() + 120 * 60000).toISOString() },
  ]) {
    await denied(() => collect(fixture(config)), "ADMIN_ASSIGNMENT_TOKEN_SCOPE_INVALID");
  }
});

test("installation permission, identity and origin resolved server-side", async () => {
  for (const installation of [
    { id: 0, repository_selection: "all", permissions: { pull_requests: "read" } },
    { id: 51, repository_selection: "untrusted", permissions: { pull_requests: "read" } },
    { id: 51, repository_selection: "all", permissions: { pull_requests: "none" } },
  ]) {
    await denied(() => collect(fixture({ installation })),
      "ADMIN_ASSIGNMENT_INSTALLATION_SCOPE_INVALID");
  }
  await denied(() => collect(fixture({ status: { installation: 403 } })),
    "ADMIN_ASSIGNMENT_INSTALLATION_PROVIDER_UNAVAILABLE");
});

test("rejects redirect and transport failures before returning partial claims", async () => {
  for (const path of ["/installation", "/access_tokens",
    "/installation/repositories", "/graphql"]) {
    await denied(() => collect(fixture({ redirects: [path] })),
      "ADMIN_ASSIGNMENT_REDIRECT_BLOCKED");
    const stage = path === "/installation" ? "INSTALLATION" :
      path === "/access_tokens" ? "TOKEN" :
      path === "/installation/repositories" ? "REPOSITORIES" : "PULL_REQUESTS";
    await denied(() => collect(fixture({ throws: [path] })),
      "ADMIN_ASSIGNMENT_" + stage + "_TRANSPORT_UNAVAILABLE");
  }
});

test("all 100 installation-approved repositories must be fully checked", async () => {
  const hundred = [repo(1354026486, "bke-worker"),
    ...Array.from({ length: 99 }, (_, i) => repo(i + 1, "r" + (i + 1)))];
  const f = fixture({ repositories: hundred, prPages: (name) =>
    name === "jan2xo/r99" ? [pr(8, ["bke-worker:worker-a"])] : [] });
  const result = await collect(f);
  assert.equal(result.total_visible_repositories, 100);
  assert.equal(result.worker_assignments.length, 1);
  assert.equal(f.calls.filter(x => x.url.endsWith("/graphql")).length, 13);
  await denied(() => collect(fixture({
    repositories: [...hundred, repo(101, "r100")],
  })), "ADMIN_ASSIGNMENT_REPOSITORIES_INCOMPLETE");
});

test("repository pagination cannot omit an approved repository", async () => {
  const one = { total_count: 2, repositories: [repo(1354026486, "bke-worker")] };
  const f = fixture({ repoPages: page => page === 1 ? one :
    { total_count: 2, repositories: [] } });
  await denied(() => collect(f), "ADMIN_ASSIGNMENT_REPOSITORIES_INCOMPLETE");
  const f2 = fixture({ repoPages: () => one });
  await denied(() => collect(f2), "ADMIN_ASSIGNMENT_REPOSITORIES_INCOMPLETE");
  const f3 = fixture({ repositories: [repo(1, "a"), repo(1, "b")] });
  await denied(() => collect(f3), "ADMIN_ASSIGNMENT_REPOSITORY_DUPLICATE");
});

test("all PR pages are checked, including exact-full first page", async () => {
  const f = fixture({ repositories: [repo(1354026486, "bke-worker")],
    prPages: (_, page) => page === 1 ?
      Array.from({ length: 100 }, (_, i) => pr(i + 1)) :
      page === 2 ? [pr(101, ["bke-worker:worker-c"])] : [] });
  const r = await collect(f);
  assert.equal(r.enumerated_open_pull_requests, 101);
  assert.deepEqual(r.worker_assignments.map(x => x.number), [101]);
  assert.equal(f.calls.filter(x => x.url.endsWith("/graphql")).length, 2);
});

test("PR page limit or duplicate PRs cannot be treated as complete", async () => {
  const f = fixture({ repositories: [repo(1354026486, "bke-worker")],
    prPages: (_, page) => Array.from({ length: 100 }, (_, i) => pr((page - 1) * 100 + i + 1)) });
  await denied(() => collect(f), "ADMIN_ASSIGNMENT_PULL_REQUESTS_INVALID");
  const f2 = fixture({ repositories: [repo(1354026486, "bke-worker")],
    prPages: (_, page) => page === 1 ? [pr(1), pr(1)] : [] });
  await denied(() => collect(f2), "ADMIN_ASSIGNMENT_PR_DUPLICATE");
});

test("duplicate worker claims or multi-worker PR labels fail closed globally", async () => {
  const one = fixture({ prPages: name =>
    name.endsWith("bke-worker") ? [pr(1, ["bke-worker:worker-a"])] :
      [pr(9, ["bke-worker:worker-a"])] });
  await denied(() => collect(one), "ADMIN_ASSIGNMENT_WORKER_CONFLICT");
  const multi = fixture({ prPages: () =>
    [pr(1, ["bke-worker:worker-a", "bke-worker:worker-b"])] });
  await denied(() => collect(multi), "ADMIN_ASSIGNMENT_LABEL_CONFLICT");
  const invalid = fixture({ prPages: () => [pr(1, ["bke-worker:BAD"])] });
  await denied(() => collect(invalid), "ADMIN_ASSIGNMENT_LABEL_INVALID");
});

test("malformed labels, PR heads, repository paths and counts fail closed", async () => {
  for (const bad of [
    { ...pr(1), head: { sha: "not-sha" } },
    { ...pr(1), labels: [{ nope: true }] },
    { ...pr(1), state: "closed" },
    { ...pr(1), number: 0 },
  ]) {
    const f = fixture({ prPages: () => [bad] });
    await denied(() => collect(f), "ADMIN_ASSIGNMENT_PULL_REQUEST_INVALID");
  }
  await denied(() => collect(fixture({ repositories: [repo(1, "a/../b")] })),
    "ADMIN_ASSIGNMENT_REPOSITORY_INVALID");
});

test("private RPC independently rejects polluted upstream and duplicate assignments", async () => {
  const good = await collect(fixture({ prPages: name =>
    name.endsWith("/bke-worker") ? [pr(1, ["bke-worker:worker-a"])] : [] }));
  for (const value of [
    { ...good, token: "ghs_exfiltrate" },
    { ...good, worker_assignments: [...good.worker_assignments,
      { ...good.worker_assignments[0], repository: "jan2xo/other", number: 3 }] },
    { ...good, consistency: "ATOMIC" },
    { ...good, worker_assignments: [{ ...good.worker_assignments[0], labels: ["bke-worker:worker-B"] }] },
  ]) await denied(() => fulfillCommandCenterAdminAssignments(env, scope, async () => value),
    "ADMIN_ASSIGNMENT_RESPONSE_INVALID");
});

test("new RPC never becomes a public worker relay HTTP route", async () => {
  const { readFileSync } = await import("node:fs");
  const entry = readFileSync(new URL("../src/index.js", import.meta.url), "utf8");
  const wrangler = readFileSync(new URL("../wrangler.toml", import.meta.url), "utf8");
  assert.match(entry, /listVerifiedWorkerAssignments\(request\)/u);
  assert.doesNotMatch(entry, /url\.pathname\s*===\s*"\/admin\/assignments"/u);
  assert.doesNotMatch(wrangler, /BKE_ADMIN_PR_INVENTORY_ENABLED\s*=\s*"true"/u);
});
