// Private, on-demand GitHub App PR ownership inventory; source-only until a
// separately authorized PREPRODUCTION broker release and trusted CC consumer.
// No token, PEM, arbitrary GitHub URL, PR body or non-worker label crosses RPC.
import { createGitHubAppJwt } from "./github-app.js";

const API = "https://api.github.com";
const VERSION = "2026-03-10";
const PER_PAGE = 100;
const MAX_REPOS = 100;
const MAX_REPO_PAGES = 4;
const MAX_TOTAL_PRS = 2000;
const MAX_ASSIGNMENTS = 500;
const WORKER = /^[a-z0-9][a-z0-9-]{0,62}$/u;
const HEAD = /^[a-f0-9]{40}$/u;
const TOKEN_SCOPE = Object.freeze({ metadata: "read", pull_requests: "read" });

function reject(code) { throw new Error(code); }
function validRepo(item) {
  if (!Number.isSafeInteger(item?.id) || item.id <= 0 ||
      typeof item.full_name !== "string" ||
      !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u.test(item.full_name)) {
    reject("ADMIN_ASSIGNMENT_REPOSITORY_INVALID");
  }
  const parts = item.full_name.split("/");
  if (parts.some(p => p === "." || p === ".." || p.includes(".."))) {
    reject("ADMIN_ASSIGNMENT_REPOSITORY_INVALID");
  }
  return { id: item.id, name: item.full_name };
}
function validBearer(value) {
  return typeof value === "string" && value.startsWith("ghs_") &&
    value.length > 8 && value.length <= 8192 &&
    !/[\x00-\x20\x7f]/u.test(value);
}
function exactGrant(grant) {
  return grant && typeof grant === "object" && !Array.isArray(grant) &&
    Object.keys(grant).sort().join(",") === "metadata,pull_requests" &&
    grant.metadata === "read" && grant.pull_requests === "read";
}
async function safeFetch(fetchImpl, url, opts, stage) {
  let response;
  try { response = await fetchImpl(url, { ...opts, redirect: "manual" }); }
  catch { reject("ADMIN_ASSIGNMENT_" + stage + "_TRANSPORT_UNAVAILABLE"); }
  if (!response || typeof response.status !== "number") {
    reject("ADMIN_ASSIGNMENT_" + stage + "_PROVIDER_UNAVAILABLE");
  }
  if (response.status >= 300 && response.status < 400) {
    reject("ADMIN_ASSIGNMENT_REDIRECT_BLOCKED");
  }
  if (!response.ok) reject("ADMIN_ASSIGNMENT_" + stage + "_PROVIDER_UNAVAILABLE");
  return response;
}
async function json(response, code) {
  const value = await response.json().catch(() => null);
  if (!value) reject(code);
  return value;
}
function requestHeaders(token) {
  return {
    accept: "application/vnd.github+json",
    authorization: "Bearer " + token,
    "user-agent": "bke-admin-worker-ownership",
    "x-github-api-version": VERSION,
  };
}
function prProjection(item, repository) {
  if (!Number.isSafeInteger(item?.number) || item.number < 1 ||
      item.state !== "open" || !HEAD.test(item?.head?.sha || "") ||
      !Array.isArray(item.labels) || item.labels.length > 100) {
    reject("ADMIN_ASSIGNMENT_PULL_REQUEST_INVALID");
  }
  const labels = [];
  for (const label of item.labels) {
    if (!label || typeof label.name !== "string") {
      reject("ADMIN_ASSIGNMENT_PULL_REQUEST_INVALID");
    }
    if (!label.name.startsWith("bke-worker:")) continue;
    if (!WORKER.test(label.name.slice("bke-worker:".length))) {
      reject("ADMIN_ASSIGNMENT_LABEL_INVALID");
    }
    labels.push(label.name);
  }
  if (labels.length > 1) reject("ADMIN_ASSIGNMENT_LABEL_CONFLICT");
  if (!labels.length) return null;
  return {
    repository: repository.name,
    repository_id: repository.id,
    number: item.number,
    state: "open",
    head_sha: item.head.sha,
    labels,
  };
}

// Never call this on an automatic dashboard refresh or from untrusted device
// input. Even a successful response is a NON-ATOMIC enumeration across repos.
// Before authorizing a worker pairing/dispatch, the caller MUST revalidate
// current GitHub ownership; "no assignments" here is not an exclusive lock.
export async function listInstalledWorkerAssignments(
  env, fetchImpl = fetch, signJwt = createGitHubAppJwt,
) {
  const appId = String(env?.BKE_WORKER_GITHUB_APP_ID || "").trim();
  const pem = String(env?.BKE_WORKER_GITHUB_APP_PRIVATE_KEY_PEM || "").trim();
  if (!/^[1-9][0-9]*$/u.test(appId) || !pem) reject("ADMIN_ASSIGNMENT_APP_UNCONFIGURED");
  let jwt;
  try { jwt = await signJwt(appId, pem); }
  catch { reject("ADMIN_ASSIGNMENT_SIGNING_UNAVAILABLE"); }
  // Dedicated read-side installation resolution. Do NOT import the
  // write-scoped serial-dispatcher resolver or follow upstream redirects.
  const installationResponse = await safeFetch(fetchImpl,
    API + "/repos/jan2xo/bke-worker/installation",
    { method: "GET", headers: {
      accept: "application/vnd.github+json",
      authorization: "Bearer " + jwt,
      "user-agent": "bke-admin-worker-ownership",
      "x-github-api-version": VERSION,
    } }, "INSTALLATION");
  const installationInfo = await json(installationResponse,
    "ADMIN_ASSIGNMENT_INSTALLATION_INVALID");
  const installation = {
    id: String(installationInfo.id || ""),
    repositorySelection: installationInfo.repository_selection,
  };
  if (!/^[1-9][0-9]{0,19}$/u.test(installation.id) ||
      !["all", "selected"].includes(installation.repositorySelection) ||
      !["read", "write"].includes(installationInfo.permissions?.pull_requests)) {
    reject("ADMIN_ASSIGNMENT_INSTALLATION_SCOPE_INVALID");
  }
  const mint = await safeFetch(fetchImpl,
    API + "/app/installations/" + installation.id + "/access_tokens",
    { method: "POST", headers: {
      accept: "application/vnd.github+json",
      authorization: "Bearer " + jwt,
      "user-agent": "bke-admin-worker-ownership",
      "x-github-api-version": VERSION,
      "content-type": "application/json",
    }, body: JSON.stringify({ permissions: TOKEN_SCOPE }) }, "TOKEN");
  const tokenInfo = await json(mint, "ADMIN_ASSIGNMENT_TOKEN_INVALID");
  const ttl = Date.parse(tokenInfo.expires_at || "") - Date.now();
  if (!validBearer(tokenInfo.token) || !exactGrant(tokenInfo.permissions) ||
      !Number.isFinite(ttl) || ttl < 120000 || ttl > 3660000) {
    reject("ADMIN_ASSIGNMENT_TOKEN_SCOPE_INVALID");
  }
  const headers = requestHeaders(tokenInfo.token);
  const repos = [];
  const repoIds = new Set();
  const repoNames = new Set();
  let count = null;
  for (let page = 1; page <= Math.ceil(MAX_REPOS / PER_PAGE); page++) {
    const url = API + "/installation/repositories?" +
      new URLSearchParams({ per_page: String(PER_PAGE), page: String(page) });
    const response = await safeFetch(fetchImpl, url,
      { method: "GET", headers }, "REPOSITORIES");
    const data = await json(response, "ADMIN_ASSIGNMENT_REPOSITORIES_INVALID");
    if (!Number.isSafeInteger(data.total_count) || data.total_count < 0 ||
        data.total_count > MAX_REPOS || !Array.isArray(data.repositories) ||
        data.repositories.length > PER_PAGE ||
        (count !== null && count !== data.total_count)) {
      reject("ADMIN_ASSIGNMENT_REPOSITORIES_INCOMPLETE");
    }
    if (count === null) count = data.total_count;
    for (const item of data.repositories) {
      const repo = validRepo(item);
      if (repoIds.has(repo.id) || repoNames.has(repo.name.toLowerCase())) {
        reject("ADMIN_ASSIGNMENT_REPOSITORY_DUPLICATE");
      }
      repoIds.add(repo.id);
      repoNames.add(repo.name.toLowerCase());
      repos.push(repo);
    }
    if (repos.length === count) break;
    if (page * PER_PAGE >= MAX_REPOS || data.repositories.length === 0) {
      reject("ADMIN_ASSIGNMENT_REPOSITORIES_INCOMPLETE");
    }
  }
  if (repos.length !== count || count === 0 ||
      !repos.some(r => r.id === 1354026486 && r.name === "jan2xo/bke-worker")) {
    reject("ADMIN_ASSIGNMENT_REPOSITORIES_INCOMPLETE");
  }

  const assignments = [];
  const workerClaims = new Set();
  let enumeratedOpen = 0;
  // One complete pagination for every installation-approved repository.
  // Never classify a worker FREE from partial upstream reads.
  for (const repo of repos) {
    const numbers = new Set();
    let reachedEnd = false;
    for (let page = 1; page <= MAX_REPO_PAGES; page++) {
      const [owner, name] = repo.name.split("/");
      const url = API + "/repos/" + owner + "/" + name + "/pulls?" +
        new URLSearchParams({ state: "open", per_page: String(PER_PAGE), page: String(page) });
      const response = await safeFetch(fetchImpl, url,
        { method: "GET", headers }, "PULL_REQUESTS");
      const items = await json(response, "ADMIN_ASSIGNMENT_PULL_REQUESTS_INVALID");
      if (!Array.isArray(items) || items.length > PER_PAGE) {
        reject("ADMIN_ASSIGNMENT_PULL_REQUESTS_INVALID");
      }
      // A short page with an advertised next page is inconsistent.
      const link = response.headers?.get?.("link") || "";
      if (items.length < PER_PAGE && /rel="next"/u.test(link)) {
        reject("ADMIN_ASSIGNMENT_PAGINATION_AMBIGUOUS");
      }
      enumeratedOpen += items.length;
      if (enumeratedOpen > MAX_TOTAL_PRS) reject("ADMIN_ASSIGNMENT_CAPACITY_EXCEEDED");
      for (const pr of items) {
        if (numbers.has(pr?.number)) reject("ADMIN_ASSIGNMENT_PR_DUPLICATE");
        const projected = prProjection(pr, repo);
        numbers.add(pr.number);
        if (projected) {
          const worker = projected.labels[0].slice("bke-worker:".length);
          if (workerClaims.has(worker)) reject("ADMIN_ASSIGNMENT_WORKER_CONFLICT");
          workerClaims.add(worker);
          assignments.push(projected);
          if (assignments.length > MAX_ASSIGNMENTS) {
            reject("ADMIN_ASSIGNMENT_CAPACITY_EXCEEDED");
          }
        }
      }
      if (items.length < PER_PAGE) { reachedEnd = true; break; }
    }
    if (!reachedEnd) reject("ADMIN_ASSIGNMENT_PAGINATION_INCOMPLETE");
  }
  return {
    principal: "github_app_installation",
    authority: "EXISTING_GITHUB_APP_INSTALLATION",
    repository_scope: "INSTALLATION_APPROVED_ONLY",
    installation_id: installation.id,
    total_visible_repositories: repos.length,
    enumerated_open_pull_requests: enumeratedOpen,
    consistency: "NON_ATOMIC_ENUMERATION",
    worker_assignments: assignments.sort((a, b) =>
      a.repository.localeCompare(b.repository) || a.number - b.number),
  };
}
