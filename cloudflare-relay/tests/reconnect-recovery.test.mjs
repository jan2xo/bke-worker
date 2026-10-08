import assert from "node:assert/strict";
import { planRecovery } from "../src/protocol.js";

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
