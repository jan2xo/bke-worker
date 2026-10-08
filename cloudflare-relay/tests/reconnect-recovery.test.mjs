import assert from "node:assert/strict";
import { normalizeRecoveryAssignments, planRecovery, routeGitHubPullRequest } from "../src/protocol.js";

const realisticIssuePayload = [
  { number: 82, state: "open", labels: [{ name: "bke-worker:android-worker-a" }], pull_request: { url: "https://api.github.com/repos/jan2xo/bke-worker/pulls/82" } },
  { number: 999, state: "open", labels: [{ name: "bke-worker:android-worker-a" }], pull_request: { url: "https://api.github.com/repos/jan2xo/bke-worker/pulls/999" } },
];
const realisticPullPayload = [
  { number: 82, state: "open", head: { ref: "bke/task-82", sha: "010ffef9ec62c8e663e6858938cb17b1cf26056d" } },
  { number: 999, state: "closed", head: { ref: "bke/stale", sha: "ffffffffffffffffffffffffffffffffffffffff" } },
];
assert.deepEqual(
  normalizeRecoveryAssignments(realisticIssuePayload, realisticPullPayload, "android-worker-a"),
  [{ workerId: "android-worker-a", number: 82, headRef: "bke/task-82", headSha: "010ffef9ec62c8e663e6858938cb17b1cf26056d" }],
);

const assignment = {
  workerId: "android-worker-a",
  number: 80,
  headRef: "bke/task-79",
  headSha: "1525f3950f483c7a033c45176c61b98bb8f7a1bf",
};

const wake = (prNumber, headSha, phase = "sent") => ({
  wake: {
    pr_number: prNumber,
    expected_head_sha: headSha,
    delivery_id: "existing-delivery",
  },
  phase,
});

assert.deepEqual(
  planRecovery([], null),
  { state: "waiting_for_assignment" },
);

const conflict = planRecovery(
  [assignment, { ...assignment, number: 81, headRef: "bke/task-80", headSha: "2534b147ae98bad366cd8e32eaad1f8207fb3bb1" }],
  null,
);
assert.equal(conflict.state, "conflict");

const preserved = planRecovery(
  [assignment],
  wake(80, assignment.headSha, "accepted"),
);
assert.equal(preserved.state, "preserved_active_assignment");
assert.equal(preserved.activePhase, "accepted");
assert.equal(preserved.assignment.number, 80);

const queued = planRecovery(
  [assignment],
  wake(80, "949aaed2edfad0f1ea889410a1fe6fe28e81f928", "queued"),
);
assert.equal(queued.state, "recovered");
assert.equal(queued.wake.expected_head_sha, assignment.headSha);

const drift = planRecovery(
  [assignment],
  wake(80, "949aaed2edfad0f1ea889410a1fe6fe28e81f928", "sent"),
);
assert.equal(drift.state, "head_converged_without_redelivery");
assert.equal(drift.wake.expected_head_sha, assignment.headSha);

const crossPr = planRecovery(
  [assignment],
  wake(79, "949aaed2edfad0f1ea889410a1fe6fe28e81f928", "sent"),
);
assert.equal(crossPr.state, "recovered");
assert.equal(crossPr.wake.pr_number, 80);

console.log("Reconnect recovery planner: PASS");

const continuationPayload = {
  action: "edited",
  repository: { full_name: "jan2xo/bke-worker" },
  number: 82,
  pull_request: {
    number: 82,
    state: "open",
    body: "<!-- BKE-CONTINUATION-RESUME worker=android-worker-a pr=82 head=010ffef9ec62c8e663e6858938cb17b1cf26056d generation=0123456789abcdef01234567 -->",
    head: { sha: "010ffef9ec62c8e663e6858938cb17b1cf26056d" },
    labels: [{ name: "bke-worker:android-worker-a" }],
  },
  changes: { body: { from: "old body" } },
};
const continuationRoute = routeGitHubPullRequest(continuationPayload, "delivery-continuation-82");
assert.equal(continuationRoute.kind, "route");
assert.equal(continuationRoute.wake.reason, "github_pull_request_continuation");

assert.equal(planRecovery([], wake(80, assignment.headSha, "sent")).state, "waiting_for_assignment");
assert.equal(
  planRecovery(
    [
      assignment,
      { ...assignment, number: 81, headRef: "bke/task-81", headSha: "2534b147ae98bad366cd8e32eaad1f8207fb3bb1" },
    ],
    null,
  ).state,
  "conflict",
);
assert.equal(planRecovery([assignment], wake(80, assignment.headSha, "queued")).state, "recovered");
assert.equal(planRecovery([assignment], wake(80, assignment.headSha, "deferred")).state, "preserved_active_assignment");
assert.equal(planRecovery([assignment], wake(80, assignment.headSha, "sent")).state, "preserved_active_assignment");

const closedPullPayload = {
  ...continuationPayload,
  pull_request: { ...continuationPayload.pull_request, state: "closed" },
};
assert.notEqual(
  routeGitHubPullRequest(closedPullPayload, "delivery-closed-82").wake?.reason,
  "github_pull_request_continuation",
);

const duplicateContinuation = {
  ...continuationPayload,
  changes: { body: { from: continuationPayload.pull_request.body } },
};
assert.equal(
  routeGitHubPullRequest(duplicateContinuation, "delivery-duplicate-82").kind,
  "ignore",
);
