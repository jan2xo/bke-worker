import { listInstalledWorkerAssignments } from "./admin-assignment-inventory.js";
import { mintAdminReadToken, listAdminInstalledRepositories } from "./github-app.js";

const REQUIRED_PURPOSE = "admin_source_discovery";
const REQUIRED_REPOSITORY = "jan2xo/bke-worker";

// Cloudflare named WorkerEntrypoint RPC only: NEVER mount as public HTTP route.
// Same-account service binding is the caller capability, not a header/string.
export async function fulfillCommandCenterAdminRead(env, request, mint = mintAdminReadToken) {
  if (env?.BKE_ADMIN_BROKER_ENABLED !== "true") {
    throw new Error("ADMIN_BROKER_LOCKED");
  }
  if (!request || typeof request !== "object" || Array.isArray(request) ||
      Object.keys(request).sort().join(",") !== "purpose,repository" ||
      request.purpose !== REQUIRED_PURPOSE ||
      request.repository !== REQUIRED_REPOSITORY) {
    throw new Error("ADMIN_BROKER_SCOPE_INVALID");
  }
  const minted = await mint(env);
  if (!minted || minted.repository !== REQUIRED_REPOSITORY ||
      minted.principal !== "github_app_installation" ||
      Object.keys(minted.permissions || {}).sort().join(",") !== "contents,issues,pull_requests" ||
      minted.permissions?.contents !== "read" ||
      minted.permissions?.issues !== "read" ||
      minted.permissions?.pull_requests !== "read") {
    throw new Error("ADMIN_BROKER_TOKEN_SCOPE_INVALID");
  }
  return minted;
}

export async function fulfillCommandCenterAdminCatalog(env, request, collect = listAdminInstalledRepositories) {
  if (env?.BKE_ADMIN_BROKER_ENABLED !== "true" ||
      env?.BKE_ADMIN_REPO_CATALOG_ENABLED !== "true") {
    throw new Error("ADMIN_CATALOG_LOCKED");
  }
  if (!request || typeof request !== "object" || Array.isArray(request) ||
      Object.keys(request).sort().join(",") !== "purpose" ||
      request.purpose !== "admin_installation_repository_catalog") {
    throw new Error("ADMIN_CATALOG_PURPOSE_INVALID");
  }
  const result = await collect(env);
  if (!result || result.principal !== "github_app_installation" ||
      result.authority !== "EXISTING_GITHUB_APP_INSTALLATION" ||
      result.repository_scope !== "INSTALLATION_APPROVED_ONLY" ||
      !Array.isArray(result.repositories) ||
      result.repositories.length !== result.total_visible ||
      result.repositories.length > 500) {
    throw new Error("ADMIN_CATALOG_RESULT_INVALID");
  }
  return result;
}


const INVENTORY_PURPOSE = "admin_worker_assignment_inventory";
const WORKER_LABEL = /^bke-worker:[a-z0-9][a-z0-9-]{0,62}$/u;
const REPO_NAME = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u;
const COMMIT_SHA = /^[a-f0-9]{40}$/u;

// One private service-binding RPC for a narrow read-only ownership snapshot.
// A listing is NOT a lock/lease or a safe substitute for fresh GitHub
// revalidation immediately before pairing, wake or reassignment.
export async function fulfillCommandCenterAdminAssignments(
  env, request, collect = listInstalledWorkerAssignments,
) {
  if (env?.BKE_ADMIN_BROKER_ENABLED !== "true" ||
      env?.BKE_ADMIN_PR_INVENTORY_ENABLED !== "true") {
    throw new Error("ADMIN_ASSIGNMENT_LOCKED");
  }
  if (!request || typeof request !== "object" || Array.isArray(request) ||
      Object.keys(request).sort().join(",") !== "purpose" ||
      request.purpose !== INVENTORY_PURPOSE) {
    throw new Error("ADMIN_ASSIGNMENT_PURPOSE_INVALID");
  }
  const result = await collect(env);
  if (!result || typeof result !== "object" || Array.isArray(result) ||
      Object.keys(result).sort().join(",") !==
      "authority,consistency,enumerated_open_pull_requests,installation_id,principal,repository_scope,total_visible_repositories,worker_assignments" ||
      result.principal !== "github_app_installation" ||
      result.authority !== "EXISTING_GITHUB_APP_INSTALLATION" ||
      result.repository_scope !== "INSTALLATION_APPROVED_ONLY" ||
      result.consistency !== "NON_ATOMIC_ENUMERATION" ||
      typeof result.installation_id !== "string" ||
      !/^[1-9][0-9]{0,19}$/u.test(result.installation_id) ||
      !Number.isSafeInteger(result.total_visible_repositories) ||
      result.total_visible_repositories < 0 ||
      result.total_visible_repositories > 100 ||
      !Number.isSafeInteger(result.enumerated_open_pull_requests) ||
      result.enumerated_open_pull_requests < 0 ||
      result.enumerated_open_pull_requests > 2000 ||
      !Array.isArray(result.worker_assignments) ||
      result.worker_assignments.length > 500 ||
      result.worker_assignments.length > result.enumerated_open_pull_requests) {
    throw new Error("ADMIN_ASSIGNMENT_RESPONSE_INVALID");
  }
  const claims = new Set();
  const prs = new Set();
  const safe = [];
  for (const item of result.worker_assignments) {
    if (!item || typeof item !== "object" || Array.isArray(item) ||
        Object.keys(item).sort().join(",") !==
        "head_sha,labels,number,repository,repository_id,state" ||
        typeof item.repository !== "string" ||
        !REPO_NAME.test(item.repository) ||
        item.repository.split("/").some(p => p === "." || p === ".." || p.includes("..")) ||
        !Number.isSafeInteger(item.repository_id) || item.repository_id <= 0 ||
        !Number.isSafeInteger(item.number) || item.number <= 0 ||
        item.state !== "open" || !COMMIT_SHA.test(item.head_sha || "") ||
        !Array.isArray(item.labels) || item.labels.length !== 1 ||
        typeof item.labels[0] !== "string" ||
        !WORKER_LABEL.test(item.labels[0])) {
      throw new Error("ADMIN_ASSIGNMENT_RESPONSE_INVALID");
    }
    const key = item.repository.toLowerCase() + "#" + item.number;
    const worker = item.labels[0];
    if (prs.has(key) || claims.has(worker)) {
      throw new Error("ADMIN_ASSIGNMENT_RESPONSE_INVALID");
    }
    prs.add(key);
    claims.add(worker);
    safe.push({
      repository: item.repository, repository_id: item.repository_id,
      number: item.number, state: "open", head_sha: item.head_sha,
      labels: [worker],
    });
  }
  // Construct a fresh allowlisted projection rather than transferring any
  // upstream result object or hidden provider fields.
  return {
    principal: "github_app_installation",
    authority: "EXISTING_GITHUB_APP_INSTALLATION",
    repository_scope: "INSTALLATION_APPROVED_ONLY",
    installation_id: result.installation_id,
    total_visible_repositories: result.total_visible_repositories,
    enumerated_open_pull_requests: result.enumerated_open_pull_requests,
    consistency: "NON_ATOMIC_ENUMERATION",
    worker_assignments: safe,
  };
}
