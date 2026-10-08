import test from "node:test";
import assert from "node:assert/strict";
import {
  CONTROL_REPOSITORY,
  CONTROL_REPOSITORIES,
  CROSS_PR_RECOVERY_MARKER,
  PROTOCOL,
  deriveRelayToken,
  relayBearerMatches,
  isValidWorkerId,
  routeGitHubPullRequest,
  validateAck,
  validateRegister,
  validateWake,
  verifyGitHubSignature,
} from "../src/protocol.js";

function payload(overrides = {}) {
  return {
    action: "opened",
    number: 28,
    repository: { full_name: CONTROL_REPOSITORY },
    pull_request: {
      number: 28,
      state: "open",
      labels: [{ name: "bke-worker:android-worker-a" }],
      head: {
        ref: "feat/example",
        sha: "0123456789abcdef0123456789abcdef01234567",
      },
    },
    ...overrides,
  };
}

test("routes exactly one worker label into Android wake protocol v1", () => {
  const result = routeGitHubPullRequest(payload(), "delivery-001");
  assert.equal(result.kind, "route");
  assert.equal(result.workerId, "android-worker-a");
  assert.deepEqual(Object.keys(result.wake).sort(), [
    "delivery_id",
    "expected_head_sha",
    "pr_number",
    "protocol",
    "reason",
    "repo",
    "type",
    "worker_id",
  ].sort());
  assert.equal(result.wake.protocol, PROTOCOL);
  assert.equal(result.wake.type, "wake");
  assert.equal(result.wake.repo, CONTROL_REPOSITORY);
  assert.equal(result.wake.reason, "github_pull_request_opened");
  assert.equal(validateWake(result.wake, "android-worker-a"), true);
  assert.equal("prompt" in result.wake, false);
  assert.equal("javascript" in result.wake, false);
  assert.equal("command" in result.wake, false);
});

test("synchronize routes the latest exact PR head", () => {
  const result = routeGitHubPullRequest(
    payload({
      action: "synchronize",
      pull_request: {
        ...payload().pull_request,
        head: {
          ref: "feat/example",
          sha: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        },
      },
    }),
    "delivery-002",
  );
  assert.equal(result.kind, "route");
  assert.equal(
    result.wake.expected_head_sha,
    "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  );
});

test("unassigned PR is ignored", () => {
  const result = routeGitHubPullRequest(
    payload({
      pull_request: {
        ...payload().pull_request,
        labels: [],
      },
    }),
    "delivery-003",
  );
  assert.deepEqual(result, {
    kind: "ignore",
    reason: "UNASSIGNED_PULL_REQUEST",
    pullRequest: 28,
  });
});

test("ambiguous worker labels fail closed", () => {
  const result = routeGitHubPullRequest(
    payload({
      pull_request: {
        ...payload().pull_request,
        labels: [
          { name: "bke-worker:android-worker-a" },
          { name: "bke-worker:worker-b" },
        ],
      },
    }),
    "delivery-004",
  );
  assert.equal(result.kind, "error");
  assert.equal(result.status, 409);
  assert.equal(result.error, "AMBIGUOUS_PR_ASSIGNMENT");
});

test("labeled event only routes when the added label is the assignment label", () => {
  const result = routeGitHubPullRequest(
    payload({
      action: "labeled",
      label: { name: "documentation" },
    }),
    "delivery-005",
  );
  assert.equal(result.kind, "ignore");
  assert.equal(result.reason, "NON_ASSIGNMENT_LABEL_EVENT");
});

test("edited event routes only an exact cross-PR recovery marker", () => {
  const base = payload();
  const head = base.pull_request.head.sha;
  const marker = `<!-- ${CROSS_PR_RECOVERY_MARKER} worker=android-worker-a pr=28 head=${head} -->`;
  const result = routeGitHubPullRequest(
    payload({
      action: "edited",
      pull_request: {
        ...base.pull_request,
        body: `Task intent\n\n${marker}`,
      },
      changes: { body: { from: "Task intent" } },
    }),
    "delivery-recovery-001",
  );
  assert.equal(result.kind, "route");
  assert.equal(result.wake.reason, "github_pull_request_cross_pr_recovery");

  const malformed = routeGitHubPullRequest(
    payload({
      action: "edited",
      pull_request: {
        ...base.pull_request,
        body: `<!-- ${CROSS_PR_RECOVERY_MARKER} worker=other pr=28 head=${head} -->`,
      },
      changes: { body: { from: "Task intent" } },
    }),
    "delivery-recovery-002",
  );
  assert.equal(malformed.kind, "error");
  assert.equal(malformed.error, "CROSS_PR_RECOVERY_MARKER_INVALID");

  const ordinaryEdit = routeGitHubPullRequest(
    payload({
      action: "edited",
      pull_request: { ...base.pull_request, body: "ordinary edit" },
    }),
    "delivery-recovery-003",
  );
  assert.equal(ordinaryEdit.kind, "ignore");
  assert.equal(ordinaryEdit.reason, "NON_RECOVERY_EDIT_EVENT");

  const replay = routeGitHubPullRequest(
    payload({
      action: "edited",
      pull_request: {
        ...base.pull_request,
        body: `Task intent\n\n${marker}\nextra edit`,
      },
      changes: { body: { from: `Task intent\n\n${marker}` } },
    }),
    "delivery-recovery-004",
  );
  assert.equal(replay.kind, "ignore");
  assert.equal(replay.reason, "CROSS_PR_RECOVERY_MARKER_NOT_NEW");
});

test("explicitly allowed demo repository routes with its own canonical repo identity", () => {
  const demoRepo = "jan2xo/bke-demo-app";
  assert.equal(CONTROL_REPOSITORIES.has(demoRepo), true);

  const result = routeGitHubPullRequest(
    payload({ repository: { full_name: demoRepo } }),
    "delivery-demo-001",
  );

  assert.equal(result.kind, "route");
  assert.equal(result.workerId, "android-worker-a");
  assert.equal(result.wake.repo, demoRepo);
  assert.equal(validateWake(result.wake, "android-worker-a"), true);
});

test("non-control repository is ignored", () => {
  const result = routeGitHubPullRequest(
    payload({ repository: { full_name: "jan2xo/other" } }),
    "delivery-006",
  );
  assert.equal(result.kind, "ignore");
  assert.equal(result.reason, "NON_CONTROL_REPOSITORY");
});

test("worker id and relay bearer tokens are worker-bound", async () => {
  assert.equal(isValidWorkerId("android-worker-a"), true);
  assert.equal(isValidWorkerId("Android-Worker-A"), false);

  const key = "0123456789abcdef0123456789abcdef";
  const androidToken = await deriveRelayToken(key, "android-worker-a");
  assert.match(androidToken, /^[A-Za-z0-9_-]{43}$/);

  assert.equal(
    await relayBearerMatches(`Bearer ${androidToken}`, key, "android-worker-a"),
    true,
  );
  assert.equal(
    await relayBearerMatches(`Bearer ${androidToken}`, key, "worker-b"),
    false,
  );
  assert.equal(
    await relayBearerMatches("Bearer invalid", key, "android-worker-a"),
    false,
  );
});

test("register and ack packets match the Android protocol", () => {
  assert.equal(validateRegister({
    protocol: 1,
    type: "register",
    worker_id: "android-worker-a",
    session_id: "session-1",
  }, "android-worker-a"), true);

  for (const state of ["accepted", "deferred", "rejected", "completed"]) {
    assert.equal(validateAck({
      protocol: 1,
      type: "ack",
      worker_id: "android-worker-a",
      delivery_id: "delivery-007",
      state,
    }, "android-worker-a"), true);
  }
});

test("GitHub HMAC SHA-256 verification accepts only the matching body", async () => {
  const secret = "test-secret";
  const body = new TextEncoder().encode('{"zen":"keep it logically awesome"}');
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = new Uint8Array(await crypto.subtle.sign("HMAC", key, body));
  const hex = [...signature].map((byte) => byte.toString(16).padStart(2, "0")).join("");

  assert.equal(
    await verifyGitHubSignature(body, `sha256=${hex}`, secret),
    true,
  );
  assert.equal(
    await verifyGitHubSignature(
      new TextEncoder().encode('{"zen":"changed"}'),
      `sha256=${hex}`,
      secret,
    ),
    false,
  );
});
