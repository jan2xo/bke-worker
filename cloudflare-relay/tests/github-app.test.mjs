import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import test from "node:test";
import {
  BROKER_AUDIENCE,
  CONTROL_REPOSITORY,
  CONTROL_REPOSITORY_ID,
  SERIAL_WORKFLOW_REF,
  createGitHubAppJwt,
  mintInstallationToken,
  validateActionsClaims,
} from "../src/github-app.js";

function validClaims(now = Math.floor(Date.now() / 1000)) {
  return {
    iss: "https://token.actions.githubusercontent.com",
    aud: BROKER_AUDIENCE,
    repository: CONTROL_REPOSITORY,
    repository_id: CONTROL_REPOSITORY_ID,
    workflow_ref: SERIAL_WORKFLOW_REF,
    workflow: "Serial Master Queue Dispatcher",
    ref: "refs/heads/main",
    event_name: "workflow_dispatch",
    iat: now - 5,
    nbf: now - 5,
    exp: now + 300,
  };
}

function privateKeyPem() {
  const { privateKey } = generateKeyPairSync("rsa", {
    modulusLength: 2048,
    privateKeyEncoding: {
      type: "pkcs8",
      format: "pem",
    },
    publicKeyEncoding: {
      type: "spki",
      format: "pem",
    },
  });
  return privateKey;
}

test("trusted serial dispatcher claims pass", () => {
  assert.equal(validateActionsClaims(validClaims()), true);
});

test("wrong repository, workflow, ref, or event fails closed", () => {
  for (const [field, value] of [
    ["repository", "jan2xo/other"],
    ["repository_id", "1"],
    ["workflow_ref", "jan2xo/bke-worker/.github/workflows/evil.yml@refs/heads/main"],
    ["workflow", "Other Workflow"],
    ["ref", "refs/heads/feature"],
    ["event_name", "push"],
  ]) {
    const claims = validClaims();
    claims[field] = value;
    assert.throws(() => validateActionsClaims(claims), /OIDC_/u);
  }
});

test("GitHub App JWT is RS256-shaped and short-lived", async () => {
  const now = 1_800_000_000;
  const token = await createGitHubAppJwt("12345", privateKeyPem(), now);
  const parts = token.split(".");
  assert.equal(parts.length, 3);

  const decode = (value) => JSON.parse(
    Buffer.from(value.replaceAll("-", "+").replaceAll("_", "/"), "base64").toString("utf8"),
  );
  const header = decode(parts[0]);
  const payload = decode(parts[1]);
  assert.equal(header.alg, "RS256");
  assert.equal(payload.iss, "12345");
  assert.equal(payload.iat, now - 60);
  assert.equal(payload.exp, now + 540);
});

test("installation token request is repository and permission scoped", async () => {
  const seen = [];
  const fetchImpl = async (url, options) => {
    seen.push({ url, options });
    return new Response(
      JSON.stringify({
        token: "ghs_test_token",
        expires_at: "2026-10-05T06:00:00Z",
      }),
      {
        status: 201,
        headers: { "content-type": "application/json" },
      },
    );
  };

  const result = await mintInstallationToken(
    {
      BKE_WORKER_GITHUB_APP_ID: "12345",
      BKE_WORKER_GITHUB_APP_INSTALLATION_ID: "67890",
      BKE_WORKER_GITHUB_APP_PRIVATE_KEY_PEM: privateKeyPem(),
    },
    fetchImpl,
  );

  assert.equal(seen.length, 1);
  assert.equal(
    seen[0].url,
    "https://api.github.com/app/installations/67890/access_tokens",
  );
  const body = JSON.parse(seen[0].options.body);
  assert.deepEqual(body.repositories, ["bke-worker"]);
  assert.deepEqual(body.permissions, {
    contents: "write",
    issues: "write",
    pull_requests: "write",
  });
  assert.equal(result.repository, "jan2xo/bke-worker");
  assert.equal(result.token, "ghs_test_token");
});
