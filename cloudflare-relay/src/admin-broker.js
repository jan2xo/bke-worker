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
