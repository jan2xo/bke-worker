const CONTROL_REPOSITORY = "jan2xo/bke-worker";
const CONTROL_REPOSITORY_ID = "1354026486";
const SERIAL_WORKFLOW_REF =
  "jan2xo/bke-worker/.github/workflows/serial-dispatcher.yml@refs/heads/main";
const SERIAL_WORKFLOW_NAME = "Serial Master Queue Dispatcher";
const ACTIONS_OIDC_ISSUER = "https://token.actions.githubusercontent.com";
const ACTIONS_OIDC_JWKS =
  "https://token.actions.githubusercontent.com/.well-known/jwks";
const BROKER_AUDIENCE = "bke-worker-github-app-broker";
const GITHUB_API_VERSION = "2026-03-10";
const ALLOWED_EVENTS = new Set(["issues", "pull_request_target", "workflow_dispatch", "schedule"]);
const REQUIRED_TOKEN_PERMISSIONS = Object.freeze({
  contents: "write",
  issues: "write",
  pull_requests: "write",
});

function base64UrlEncodeBytes(bytes) {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary)
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/u, "");
}

function base64UrlEncodeJson(value) {
  return base64UrlEncodeBytes(
    new TextEncoder().encode(JSON.stringify(value)),
  );
}

function base64UrlDecodeBytes(value) {
  const padded = value
    .replaceAll("-", "+")
    .replaceAll("_", "/")
    .padEnd(Math.ceil(value.length / 4) * 4, "=");
  const binary = atob(padded);
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

function pemBytes(pem, beginLabel, endLabel) {
  if (typeof pem !== "string") throw new Error("GITHUB_APP_PRIVATE_KEY_INVALID");
  const normalized = pem.trim();
  if (!normalized.startsWith(beginLabel) || !normalized.endsWith(endLabel)) {
    return null;
  }
  const body = normalized
    .slice(beginLabel.length, -endLabel.length)
    .replace(/\s+/gu, "");
  if (!body) throw new Error("GITHUB_APP_PRIVATE_KEY_INVALID");
  return Uint8Array.from(atob(body), (character) => character.charCodeAt(0));
}

function derLength(length) {
  if (length < 0x80) return Uint8Array.of(length);
  const bytes = [];
  let remaining = length;
  while (remaining > 0) {
    bytes.unshift(remaining & 0xff);
    remaining >>= 8;
  }
  return Uint8Array.of(0x80 | bytes.length, ...bytes);
}

function derWrap(tag, value) {
  return Uint8Array.of(tag, ...derLength(value.length), ...value);
}

function pkcs1ToPkcs8(pkcs1) {
  const rsaAlgorithmIdentifier = Uint8Array.of(
    0x30, 0x0d,
    0x06, 0x09,
    0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x01, 0x01, 0x01,
    0x05, 0x00,
  );
  const version = Uint8Array.of(0x02, 0x01, 0x00);
  const privateKey = derWrap(0x04, pkcs1);
  return derWrap(
    0x30,
    Uint8Array.of(...version, ...rsaAlgorithmIdentifier, ...privateKey),
  );
}

async function importAppPrivateKey(pem) {
  const pkcs8 = pemBytes(
    pem,
    "-----BEGIN PRIVATE KEY-----",
    "-----END PRIVATE KEY-----",
  );
  const pkcs1 = pemBytes(
    pem,
    "-----BEGIN RSA PRIVATE KEY-----",
    "-----END RSA PRIVATE KEY-----",
  );
  const encoded = pkcs8 || (pkcs1 ? pkcs1ToPkcs8(pkcs1) : null);
  if (!encoded) throw new Error("GITHUB_APP_PRIVATE_KEY_INVALID");

  return crypto.subtle.importKey(
    "pkcs8",
    encoded,
    {
      name: "RSASSA-PKCS1-v1_5",
      hash: "SHA-256",
    },
    false,
    ["sign"],
  );
}

async function createGitHubAppJwt(appId, privateKeyPem, nowSeconds = Math.floor(Date.now() / 1000)) {
  if (!/^\d+$/u.test(String(appId || ""))) {
    throw new Error("GITHUB_APP_ID_INVALID");
  }
  const header = {
    alg: "RS256",
    typ: "JWT",
  };
  const payload = {
    iat: nowSeconds - 60,
    exp: nowSeconds + 9 * 60,
    iss: String(appId),
  };
  const encodedHeader = base64UrlEncodeJson(header);
  const encodedPayload = base64UrlEncodeJson(payload);
  const signingInput = `${encodedHeader}.${encodedPayload}`;
  const key = await importAppPrivateKey(privateKeyPem);
  const signature = new Uint8Array(
    await crypto.subtle.sign(
      "RSASSA-PKCS1-v1_5",
      key,
      new TextEncoder().encode(signingInput),
    ),
  );
  return `${signingInput}.${base64UrlEncodeBytes(signature)}`;
}

function parseJwt(token) {
  if (typeof token !== "string") throw new Error("OIDC_TOKEN_INVALID");
  const parts = token.split(".");
  if (parts.length !== 3) throw new Error("OIDC_TOKEN_INVALID");
  let header;
  let claims;
  try {
    header = JSON.parse(new TextDecoder().decode(base64UrlDecodeBytes(parts[0])));
    claims = JSON.parse(new TextDecoder().decode(base64UrlDecodeBytes(parts[1])));
  } catch {
    throw new Error("OIDC_TOKEN_INVALID");
  }
  return {
    header,
    claims,
    signingInput: `${parts[0]}.${parts[1]}`,
    signature: base64UrlDecodeBytes(parts[2]),
  };
}

function audienceMatches(audience) {
  if (typeof audience === "string") return audience === BROKER_AUDIENCE;
  return Array.isArray(audience) && audience.includes(BROKER_AUDIENCE);
}

function validateActionsClaims(claims, nowSeconds = Math.floor(Date.now() / 1000)) {
  if (!claims || typeof claims !== "object") throw new Error("OIDC_CLAIMS_INVALID");
  if (claims.iss !== ACTIONS_OIDC_ISSUER) throw new Error("OIDC_ISSUER_INVALID");
  if (!audienceMatches(claims.aud)) throw new Error("OIDC_AUDIENCE_INVALID");
  if (String(claims.repository || "").toLowerCase() !== CONTROL_REPOSITORY) {
    throw new Error("OIDC_REPOSITORY_INVALID");
  }
  if (String(claims.repository_id || "") !== CONTROL_REPOSITORY_ID) {
    throw new Error("OIDC_REPOSITORY_ID_INVALID");
  }
  if (claims.workflow_ref !== SERIAL_WORKFLOW_REF) {
    throw new Error("OIDC_WORKFLOW_REF_INVALID");
  }
  if (claims.workflow !== SERIAL_WORKFLOW_NAME) {
    throw new Error("OIDC_WORKFLOW_INVALID");
  }
  if (claims.ref !== "refs/heads/main") throw new Error("OIDC_REF_INVALID");
  if (!ALLOWED_EVENTS.has(String(claims.event_name || ""))) {
    throw new Error("OIDC_EVENT_INVALID");
  }

  const exp = Number(claims.exp);
  const nbf = Number(claims.nbf ?? claims.iat);
  const iat = Number(claims.iat);
  if (!Number.isFinite(exp) || exp < nowSeconds - 30) {
    throw new Error("OIDC_EXPIRED");
  }
  if (!Number.isFinite(nbf) || nbf > nowSeconds + 30) {
    throw new Error("OIDC_NOT_YET_VALID");
  }
  if (!Number.isFinite(iat) || iat > nowSeconds + 30 || iat < nowSeconds - 600) {
    throw new Error("OIDC_ISSUED_AT_INVALID");
  }
  return true;
}

async function verifyActionsOidcToken(token, fetchImpl = fetch) {
  const parsed = parseJwt(token);
  if (parsed.header?.alg !== "RS256" || typeof parsed.header?.kid !== "string") {
    throw new Error("OIDC_HEADER_INVALID");
  }

  const response = await fetchImpl(ACTIONS_OIDC_JWKS, {
    headers: {
      accept: "application/json",
    },
  });
  if (!response.ok) throw new Error("OIDC_JWKS_UNAVAILABLE");
  const jwks = await response.json();
  const jwk = (jwks?.keys || []).find((candidate) =>
    candidate?.kid === parsed.header.kid && candidate?.kty === "RSA"
  );
  if (!jwk) throw new Error("OIDC_SIGNING_KEY_UNKNOWN");

  const key = await crypto.subtle.importKey(
    "jwk",
    jwk,
    {
      name: "RSASSA-PKCS1-v1_5",
      hash: "SHA-256",
    },
    false,
    ["verify"],
  );
  const valid = await crypto.subtle.verify(
    "RSASSA-PKCS1-v1_5",
    key,
    parsed.signature,
    new TextEncoder().encode(parsed.signingInput),
  );
  if (!valid) throw new Error("OIDC_SIGNATURE_INVALID");
  validateActionsClaims(parsed.claims);
  return parsed.claims;
}

function requiredAppConfiguration(env) {
  const appId = String(env.BKE_WORKER_GITHUB_APP_ID || "").trim();
  const privateKeyPem = String(env.BKE_WORKER_GITHUB_APP_PRIVATE_KEY_PEM || "").trim();
  if (!/^\d+$/u.test(appId)) throw new Error("GITHUB_APP_ID_UNCONFIGURED");
  if (!privateKeyPem) throw new Error("GITHUB_APP_PRIVATE_KEY_UNCONFIGURED");
  return { appId, privateKeyPem };
}

function appHeaders(appJwt) {
  return {
    accept: "application/vnd.github+json",
    authorization: `Bearer ${appJwt}`,
    "user-agent": "bke-worker-github-app-broker",
    "x-github-api-version": GITHUB_API_VERSION,
  };
}

function permissionSatisfies(granted, required) {
  if (required === "read") return granted === "read" || granted === "write";
  return granted === "write";
}

function validateInstallationPermissions(permissions) {
  const granted = permissions && typeof permissions === "object" ? permissions : {};
  for (const [name, required] of Object.entries(REQUIRED_TOKEN_PERMISSIONS)) {
    const actual = String(granted[name] || "none");
    if (!permissionSatisfies(actual, required)) {
      throw new Error(
        `GITHUB_APP_PERMISSION_REQUIRED:${name}=${required};granted=${actual}`,
      );
    }
  }
}

async function resolveInstallation(appJwt, fetchImpl = fetch) {
  const response = await fetchImpl(
    "https://api.github.com/repos/jan2xo/bke-worker/installation",
    {
      headers: appHeaders(appJwt),
    },
  );
  const payload = await response.json().catch(() => null);
  if (!response.ok) {
    throw new Error(`GITHUB_APP_INSTALLATION_RESOLUTION_FAILED:${response.status}`);
  }
  const installationId = String(payload?.id || "");
  if (!/^\d+$/u.test(installationId)) {
    throw new Error("GITHUB_APP_INSTALLATION_RESPONSE_INVALID");
  }
  validateInstallationPermissions(payload?.permissions);
  return {
    id: installationId,
    repositorySelection: String(payload?.repository_selection || ""),
  };
}

async function mintInstallationToken(env, fetchImpl = fetch) {
  const { appId, privateKeyPem } = requiredAppConfiguration(env);
  const appJwt = await createGitHubAppJwt(appId, privateKeyPem);
  const installation = await resolveInstallation(appJwt, fetchImpl);
  const response = await fetchImpl(
    `https://api.github.com/app/installations/${installation.id}/access_tokens`,
    {
      method: "POST",
      headers: {
        ...appHeaders(appJwt),
        "content-type": "application/json",
      },
      body: JSON.stringify({
        repository_ids: [Number(CONTROL_REPOSITORY_ID)],
        permissions: REQUIRED_TOKEN_PERMISSIONS,
      }),
    },
  );

  const payload = await response.json().catch(() => null);
  if (!response.ok) {
    const required = response.headers.get("x-accepted-github-permissions");
    const suffix = required ? ` required_permissions=${required}` : "";
    throw new Error(`GITHUB_APP_TOKEN_MINT_FAILED:${response.status}${suffix}`);
  }
  if (!payload || typeof payload.token !== "string" || typeof payload.expires_at !== "string") {
    throw new Error("GITHUB_APP_TOKEN_RESPONSE_INVALID");
  }
  return {
    token: payload.token,
    expires_at: payload.expires_at,
    repository: CONTROL_REPOSITORY,
    permissions: REQUIRED_TOKEN_PERMISSIONS,
  };
}


// GitHub completed rollout of stateless ghs_APPID_JWT installation tokens
// in October 2026. Treat GitHub-issued installation bearer strings as opaque:
// the modern format contains periods, hyphens and underscores. This check
// enforces only the token type and safe HTTP-header characters, NOT JWT claims.
// Scope and expiry are separately verified from the HTTPS issuance response.
function isOpaqueGitHubInstallationToken(token) {
  return typeof token === "string" &&
    token.startsWith("ghs_") &&
    token.length > 8 && token.length <= 8192 &&
    !/[\x00-\x20\x7f]/u.test(token);
}

const ADMIN_READ_PERMISSIONS = Object.freeze({
  contents: "read",
  issues: "read",
  pull_requests: "read",
});

// Separate read-only token from the existing dispatcher mutation credential.
// The unmodified dispatcher must continue using mintInstallationToken().
async function mintAdminReadToken(env, fetchImpl = fetch) {
  const { appId, privateKeyPem } = requiredAppConfiguration(env);
  const jwt = await createGitHubAppJwt(appId, privateKeyPem);
  const installation = await resolveInstallation(jwt, fetchImpl);
  const response = await fetchImpl(
    `https://api.github.com/app/installations/${installation.id}/access_tokens`,
    {
      method: "POST",
      headers: { ...appHeaders(jwt), "content-type": "application/json" },
      body: JSON.stringify({
        repository_ids: [Number(CONTROL_REPOSITORY_ID)],
        permissions: ADMIN_READ_PERMISSIONS,
      }),
    },
  );
  // GitHub is the only issuer; never use a manually supplied installation ID.
  if (!response.ok) throw new Error("ADMIN_GITHUB_TOKEN_MINT_REJECTED");
  const payload = await response.json().catch(() => null);
  const expiry = typeof payload?.expires_at === "string" ? Date.parse(payload.expires_at) : NaN;
  const remaining = expiry - Date.now();
  if (!payload || typeof payload.token !== "string" ||
      !isOpaqueGitHubInstallationToken(payload.token) ||
      !Number.isFinite(remaining) || remaining < 120000 || remaining > 3660000) {
    throw new Error("ADMIN_GITHUB_TOKEN_INVALID");
  }
  // GitHub responded to an exact-repository, read-only token request; never
  // return the write-scoped dispatcher token or its wider permissions.
  return {
    token: payload.token,
    expires_at: payload.expires_at,
    repository: CONTROL_REPOSITORY,
    permissions: ADMIN_READ_PERMISSIONS,
    principal: "github_app_installation",
  };
}


const CATALOG_MAX_PAGES = 5;
const CATALOG_PAGE_SIZE = 100;
function safeCatalogRepository(item) {
  if (!Number.isSafeInteger(item?.id) || item.id <= 0 ||
      typeof item?.full_name !== "string" ||
      !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u.test(item.full_name)) {
    throw new Error("ADMIN_CATALOG_REPOSITORY_INVALID");
  }
  const [owner, name] = item.full_name.split("/");
  if ([owner, name].some(value => value === "." || value === ".." || value.includes(".."))) {
    throw new Error("ADMIN_CATALOG_REPOSITORY_INVALID");
  }
  return {
    id: item.id,
    full_name: item.full_name,
    default_branch: typeof item.default_branch === "string" &&
      /^[A-Za-z0-9_./-]{1,250}$/u.test(item.default_branch) ? item.default_branch : null,
    private: item.private === true,
    archived: item.archived === true,
    html_url: "https://github.com/" + owner + "/" + name,
  };
}

// Lists only repositories already approved in the EXISTING GitHub App
// installation. The catalogue token stays inside this Cloudflare relay.
// This DOES NOT increase the installed app's GitHub permissions.
async function listAdminInstalledRepositories(env, fetchImpl = fetch, createJwt = createGitHubAppJwt) {
  const { appId, privateKeyPem } = requiredAppConfiguration(env);
  const jwt = await createJwt(appId, privateKeyPem);
  const installation = await resolveInstallation(jwt, fetchImpl);
  const response = await fetchImpl(
    "https://api.github.com/app/installations/" + installation.id + "/access_tokens",
    {
      method: "POST",
      headers: { ...appHeaders(jwt), "content-type": "application/json" },
      // Explicit empty optional permissions requests metadata-only access;
      // never omit permissions (that would inherit write scopes).
      body: JSON.stringify({ permissions: {} }),
    },
  );
  if (!response.ok) throw new Error("ADMIN_CATALOG_TOKEN_REJECTED");
  const tokenInfo = await response.json().catch(() => null);
  const token = tokenInfo?.token;
  const remaining = Date.parse(tokenInfo?.expires_at || "") - Date.now();
  // Diagnostic stages are fixed codes ONLY. Never include the token,
  // GitHub permissions object, response body, key material or timestamps
  // in thrown errors, logs, PR checkpoints or Command Center responses.
  if (!isOpaqueGitHubInstallationToken(token)) {
    throw new Error("ADMIN_CATALOG_TOKEN_BEARER_INVALID");
  }
  if (!Number.isFinite(remaining) || remaining < 120000 || remaining > 3660000) {
    throw new Error("ADMIN_CATALOG_TOKEN_EXPIRY_INVALID");
  }
  // GitHub documents that GET /installation/repositories needs no
  // additional repository permissions for an installation token. A granted
  // empty permissions map is therefore safely sufficient for this catalog;
  // implicit metadata:read is also safe. NEVER accept optional read/write
  // grants (contents, issues, administration, etc.) or missing attestation.
  const granted = tokenInfo.permissions;
  const safeEmptyGrant = granted && typeof granted === "object" &&
    !Array.isArray(granted) && Object.keys(granted).length === 0;
  const safeMetadataGrant = granted && typeof granted === "object" &&
    !Array.isArray(granted) && Object.keys(granted).length === 1 &&
    granted.metadata === "read";
  if (!safeEmptyGrant && !safeMetadataGrant) {
    throw new Error("ADMIN_CATALOG_TOKEN_GRANT_INVALID");
  }
  const out = [];
  const seen = new Set();
  let expectedTotal = null;
  for (let page = 1; page <= CATALOG_MAX_PAGES; page++) {
    const qs = new URLSearchParams({ per_page: String(CATALOG_PAGE_SIZE), page: String(page) });
    const dataResponse = await fetchImpl(
      "https://api.github.com/installation/repositories?" + qs.toString(),
      {
        method: "GET",
        headers: {
          accept: "application/vnd.github+json",
          authorization: "Bearer " + token,
          "user-agent": "bke-admin-installation-catalog",
          "x-github-api-version": GITHUB_API_VERSION,
        },
        redirect: "error",
      },
    );
    if (!dataResponse.ok) throw new Error("ADMIN_CATALOG_REPOSITORIES_UNAVAILABLE");
    const data = await dataResponse.json().catch(() => null);
    if (!Array.isArray(data?.repositories) || data.repositories.length > CATALOG_PAGE_SIZE ||
        !Number.isSafeInteger(data?.total_count) || data.total_count < 0 ||
        data.total_count > CATALOG_MAX_PAGES * CATALOG_PAGE_SIZE ||
        (page > 1 && data.total_count !== expectedTotal)) {
      throw new Error("ADMIN_CATALOG_REPOSITORIES_INVALID");
    }
    if (page === 1) expectedTotal = data.total_count;
    for (const item of data.repositories) {
      const repo = safeCatalogRepository(item);
      if (seen.has(repo.id)) throw new Error("ADMIN_CATALOG_DUPLICATE_REPOSITORY");
      seen.add(repo.id);
      out.push(repo);
    }
    if (out.length === data.total_count) {
      return {
        principal: "github_app_installation",
        authority: "EXISTING_GITHUB_APP_INSTALLATION",
        repository_scope: "INSTALLATION_APPROVED_ONLY",
        total_visible: out.length,
        repositories: out.sort((a, b) => a.full_name.localeCompare(b.full_name)),
      };
    }
    if (page === CATALOG_MAX_PAGES || data.repositories.length === 0) {
      throw new Error("ADMIN_CATALOG_PAGINATION_INCOMPLETE");
    }
  }
  throw new Error("ADMIN_CATALOG_PAGINATION_INCOMPLETE");
}

export {
  ACTIONS_OIDC_ISSUER,
  BROKER_AUDIENCE,
  CONTROL_REPOSITORY,
  CONTROL_REPOSITORY_ID,
  SERIAL_WORKFLOW_REF,
  createGitHubAppJwt,
  mintInstallationToken,
  mintAdminReadToken,
  listAdminInstalledRepositories,
  resolveInstallation,
  validateActionsClaims,
  validateInstallationPermissions,
  verifyActionsOidcToken,
};
