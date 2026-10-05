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
const ALLOWED_EVENTS = new Set(["issues", "pull_request_target", "workflow_dispatch"]);

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
  const installationId = String(env.BKE_WORKER_GITHUB_APP_INSTALLATION_ID || "").trim();
  const privateKeyPem = String(env.BKE_WORKER_GITHUB_APP_PRIVATE_KEY_PEM || "").trim();
  if (!/^\d+$/u.test(appId)) throw new Error("GITHUB_APP_ID_UNCONFIGURED");
  if (!/^\d+$/u.test(installationId)) {
    throw new Error("GITHUB_APP_INSTALLATION_ID_UNCONFIGURED");
  }
  if (!privateKeyPem) throw new Error("GITHUB_APP_PRIVATE_KEY_UNCONFIGURED");
  return { appId, installationId, privateKeyPem };
}

async function mintInstallationToken(env, fetchImpl = fetch) {
  const { appId, installationId, privateKeyPem } = requiredAppConfiguration(env);
  const appJwt = await createGitHubAppJwt(appId, privateKeyPem);
  const response = await fetchImpl(
    `https://api.github.com/app/installations/${installationId}/access_tokens`,
    {
      method: "POST",
      headers: {
        accept: "application/vnd.github+json",
        authorization: `Bearer ${appJwt}`,
        "content-type": "application/json",
        "user-agent": "bke-worker-github-app-broker",
        "x-github-api-version": GITHUB_API_VERSION,
      },
      body: JSON.stringify({
        repositories: ["bke-worker"],
        permissions: {
          contents: "write",
          issues: "write",
          pull_requests: "write",
        },
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
    permissions: {
      contents: "write",
      issues: "write",
      pull_requests: "write",
    },
  };
}

export {
  ACTIONS_OIDC_ISSUER,
  BROKER_AUDIENCE,
  CONTROL_REPOSITORY,
  CONTROL_REPOSITORY_ID,
  SERIAL_WORKFLOW_REF,
  createGitHubAppJwt,
  mintInstallationToken,
  validateActionsClaims,
  verifyActionsOidcToken,
};
