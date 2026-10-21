import assert from "node:assert/strict";
import { normalizeRecoveryAssignments, planRecovery, routeGitHubPullRequest, relayCheckpointIssuePath, recoverySendFenceKey, persistRecoverySendAttempt, inspectRecoverySendAttempt } from "../src/protocol.js";

const realisticIssuePayload = [
  { number: 82, state: "open", labels: [{ name: "bke-worker:android-worker-a" }], pull_request: { url: "https://api.github.com/repos/jan2xo/bke-worker/pulls/82" } },
  { number: 999, state: "open", labels: [{ name: "bke-worker:android-worker-a" }], pull_request: { url: "https://api.github.com/repos/jan2xo/bke-worker/pulls/999" } },
];
const realisticPullPayload = [
  { number: 82, state: "open", labels: [{ name: "bke-worker:android-worker-a" }], head: { ref: "bke/task-82", sha: "010ffef9ec62c8e663e6858938cb17b1cf26056d" } },
  { number: 999, state: "closed", head: { ref: "bke/stale", sha: "ffffffffffffffffffffffffffffffffffffffff" } },
];
assert.deepEqual(
  normalizeRecoveryAssignments(realisticIssuePayload, realisticPullPayload, "android-worker-a"),
  [{ workerId: "android-worker-a", number: 82, headRef: "bke/task-82", headSha: "010ffef9ec62c8e663e6858938cb17b1cf26056d" }],
);

for (const liveLabels of [
  [],
  [{ name: "bke-worker:another-worker" }],
  [{ name: "bke-worker:android-worker-a" }, { name: "bke-worker:other-worker" }],
]) {
  assert.throws(
    () => normalizeRecoveryAssignments(
      realisticIssuePayload.slice(0, 1),
      [{ ...realisticPullPayload[0], labels: liveLabels }],
      "android-worker-a",
    ),
    /RECOVERY_ASSIGNMENT_LABEL_CHANGED:82/,
    "live PR details cannot validate stale ownership from an earlier issue listing",
  );
}
assert.throws(
  () => normalizeRecoveryAssignments(
    realisticIssuePayload.slice(0, 1),
    [{ ...realisticPullPayload[0], labels: undefined }],
    "android-worker-a",
  ),
  /RECOVERY_ASSIGNMENT_LABEL_CHANGED:82/,
  "missing current PR labels are not evidence of ownership",
);

// GitHub assignment state must never appear FREE when details are unreadable.
assert.throws(
  () => normalizeRecoveryAssignments(
    realisticIssuePayload.slice(0, 1),
    [],
    "android-worker-a",
  ),
  /RECOVERY_ASSIGNMENT_DETAIL_MISSING:82/,
);
assert.throws(
  () => normalizeRecoveryAssignments(
    realisticIssuePayload.slice(0, 1),
    [{ ...realisticPullPayload[0], head: { ref: "bke/task-82", sha: "invalid" } }],
    "android-worker-a",
  ),
  /RECOVERY_ASSIGNMENT_HEAD_INVALID:82/,
);
assert.deepEqual(
  normalizeRecoveryAssignments(
    realisticIssuePayload.slice(0, 1),
    [{ ...realisticPullPayload[0], state: "closed" }],
    "android-worker-a",
  ),
  [],
);

const assignment = {
  workerId: "android-worker-a",
  number: 80,
  headRef: "bke/task-79",
  headSha: "1525f3950f483c7a033c45176c61b98bb8f7a1bf",
};

const wake = (prNumber, headSha, phase = "sent") => ({
  wake: {
    worker_id: "android-worker-a",
    repo: "jan2xo/bke-worker",
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
assert.equal(drift.state, "assignment_drift_requires_owner");
assert.equal(drift.deliveryId, "existing-delivery");
assert.equal(drift.activePhase, "sent");
assert.equal(drift.assignment.headSha, assignment.headSha);

const crossPr = planRecovery(
  [assignment],
  wake(79, "949aaed2edfad0f1ea889410a1fe6fe28e81f928", "sent"),
);
assert.equal(crossPr.state, "assignment_drift_requires_owner");
assert.equal(crossPr.deliveryId, "existing-delivery");
assert.equal(crossPr.activePhase, "sent");

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

for (const phase of ["queued", "sent", "accepted", "deferred", "recovery_required"]) {
  const preserved = planRecovery([], wake(80, assignment.headSha, phase));
  assert.equal(preserved.state, "unassigned_delivery_preserved");
  assert.equal(preserved.deliveryId, "existing-delivery");
  assert.equal(preserved.activePhase, phase);
  assert.equal(preserved.queuedDeliveryId, null);
}
const orphanedQueued = planRecovery([], null, {
  pr_number: 80,
  expected_head_sha: assignment.headSha,
  delivery_id: "queued-delivery",
});
assert.equal(orphanedQueued.state, "unassigned_delivery_preserved");
assert.equal(orphanedQueued.queuedDeliveryId, "queued-delivery");
assert.equal(orphanedQueued.deliveryId, null);
for (const phase of ["sent", "accepted", "deferred", "recovery_required"]) {
  const drift = planRecovery([assignment], wake(79, assignment.headSha, phase));
  assert.equal(drift.state, "assignment_drift_requires_owner");
  assert.equal(drift.deliveryId, "existing-delivery");
}
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

import { retainDisplacedWakes, inspectSupersessionEvidence, classifyUnmatchedRelayAck } from "../src/protocol.js";
const priorWake = {
  protocol: 1, type: "wake", worker_id: "android-worker-a",
  repo: "jan2xo/bke-worker", pr_number: 82,
  expected_head_sha: "010ffef9ec62c8e663e6858938cb17b1cf26056d",
  reason: "github_pull_request_opened", delivery_id: "old-active-82",
};
const queuedWake = {...priorWake, delivery_id: "old-queued-82"};
const retained = retainDisplacedWakes(undefined, [
  {wake: priorWake, phase: "sent"}, {wake: queuedWake, phase: "queued"},
], "android-worker-a");
assert.deepEqual(retained?.map(x => [x.wake.delivery_id, x.phase]), [
  ["old-active-82", "sent"], ["old-queued-82", "queued"],
]);
assert.equal(retainDisplacedWakes(retained, [
  {wake: {...priorWake}, phase: "sent"},
], "android-worker-a")?.length, 2, "identical source wake is idempotent");
assert.equal(retainDisplacedWakes(undefined, [
  {wake: priorWake, phase: "sent"}, {wake: {...priorWake}, phase: "sent"},
], "android-worker-a")?.length, 1,
"repeating one new displacement is idempotent before durable persistence");
const corruptPersistedDuplicate = [
  {wake: priorWake, phase: "sent"}, {wake: {...priorWake}, phase: "sent"},
];
assert.equal(retainDisplacedWakes(corruptPersistedDuplicate, [],
  "android-worker-a"), null,
  "previously stored identical duplicate is corrupt, not a clean state");
assert.equal(retainDisplacedWakes(corruptPersistedDuplicate, [
  {wake: queuedWake, phase: "queued"},
], "android-worker-a"), null,
  "appending a new wake cannot silently normalize a duplicate persisted archive");
assert.equal(retainDisplacedWakes(corruptPersistedDuplicate, [
  {wake: {...priorWake}, phase: "sent"},
], "android-worker-a"), null,
  "an otherwise idempotent retry cannot repair already-corrupt persistent history");
assert.equal(inspectSupersessionEvidence(corruptPersistedDuplicate, "android-worker-a").state,
  "invalid", "archive read path and append path reject the same duplicate history");
assert.equal(retainDisplacedWakes(retained, [
  {wake: {...priorWake, expected_head_sha: "a".repeat(40)}, phase: "sent"},
], "android-worker-a"), null, "same delivery ID with different head fails closed");
assert.equal(retainDisplacedWakes(retained, [
  {wake: priorWake, phase: "accepted"},
], "android-worker-a"), null, "same delivery ID with conflicting phase fails closed");
assert.equal(retainDisplacedWakes([], [{wake: priorWake, phase: "sent"}],
  "another-worker"), null, "cross-worker displacement fails closed");
assert.equal(retainDisplacedWakes([], [{wake: {delivery_id: "bad"}, phase: "sent"}],
  "android-worker-a"), null, "malformed displaced wake fails closed");
const cap = Array.from({length: 64}, (_, n) => ({
  wake: {...priorWake, delivery_id: `old-${n}`}, phase: "queued",
}));
assert.equal(retainDisplacedWakes(cap, [{wake: queuedWake, phase: "queued"}],
  "android-worker-a"), null, "full ledger may not silently erase older evidence");

const evidence = inspectSupersessionEvidence(retained, "android-worker-a", "old-active-82");
assert.deepEqual(evidence, {state: "archived_replay", count: 2},
  "archived ID remains a replay denial even if recent 64-ID cache forgets it");
assert.deepEqual(inspectSupersessionEvidence(retained, "android-worker-a", "new-delivery"),
  {state: "observed", count: 2});
assert.deepEqual(inspectSupersessionEvidence(undefined, "android-worker-a", "new-delivery"),
  {state: "none", count: 0});
assert.equal(inspectSupersessionEvidence("corrupted", "android-worker-a").state, "invalid");
assert.equal(inspectSupersessionEvidence([
  retained[0], {...retained[0]},
], "android-worker-a").state, "invalid", "duplicate archived records block recovery");
assert.equal(inspectSupersessionEvidence(retained, "another-worker").state, "invalid");
assert.equal(inspectSupersessionEvidence(retained, "android-worker-a", "bad id").state,
  "invalid", "malformed prospective ID cannot bypass the archive scan");

const cleanArchivedRecovery = planRecovery([], null, null, 2);
assert.equal(cleanArchivedRecovery.state, "unassigned_delivery_preserved",
  "archived evidence means no assignment cannot be reported as FREE");
assert.equal(cleanArchivedRecovery.archivedCount, 2);
const ambiguousArchivedRecovery = planRecovery([assignment], null, null, 2);
assert.equal(ambiguousArchivedRecovery.state, "historical_delivery_requires_owner",
  "recovery may not synthesize a new wake over unadjudicated archived evidence");
assert.equal(ambiguousArchivedRecovery.archivedCount, 2);
assert.equal(planRecovery([assignment], wake(80, assignment.headSha, "queued"), null, 2).state,
  "historical_delivery_requires_owner",
  "queued state is not proof that previous archived sends were cancelled");
assert.equal(planRecovery([assignment], wake(80, assignment.headSha, "accepted"), null, 2).state,
  "preserved_active_assignment",
  "the matching active accepted delivery remains preserved without new dispatch");
assert.deepEqual(planRecovery([], null, null, 0), {state: "waiting_for_assignment"},
  "no archived state retains the existing empty recovery contract");
assert.throws(() => planRecovery([], null, null, -1), /RECOVERY_ARCHIVE_COUNT_INVALID/);

const matchingControlWake = wake(80, assignment.headSha, "accepted");
const foreignActive = {
  ...matchingControlWake,
  wake: {...matchingControlWake.wake, repo: "jan2xo/bke-demo-app"},
};
assert.equal(
  planRecovery([assignment], foreignActive).state,
  "assignment_identity_requires_owner",
  "same PR number and SHA in a different repository must not preserve assignment");
assert.equal(
  planRecovery([assignment], matchingControlWake, {
    ...matchingControlWake.wake,
    repo: "jan2xo/bke-demo-app",
    delivery_id: "foreign-queued",
  }).state,
  "assignment_identity_requires_owner",
  "a foreign queued wake must prevent false clean ownership even if active matches");
assert.equal(
  planRecovery([assignment], {
    ...matchingControlWake,
    wake: {...matchingControlWake.wake, worker_id: "different-worker"},
  }).state,
  "assignment_identity_requires_owner",
  "cross-worker persisted context is not proof of worker ownership");
const sameIdentity = planRecovery([assignment], matchingControlWake);
assert.equal(sameIdentity.state, "preserved_active_assignment");
assert.equal(sameIdentity.deliveryId, "existing-delivery");
assert.equal(
  planRecovery([assignment], foreignActive, null, 1).archivedCount, 1,
  "identity conflict preserves archive count for owner adjudication");

const checkpointWake = {
  protocol: 1, type: "wake", worker_id: "android-worker-a",
  repo: "jan2xo/bke-worker", pr_number: 145,
  expected_head_sha: "0123456789abcdef0123456789abcdef01234567",
  reason: "github_pull_request_opened", delivery_id: "checkpoint-bke-145",
};
assert.equal(relayCheckpointIssuePath(checkpointWake),
  "/repos/jan2xo/bke-worker/issues/145/comments",
  "control-repo checkpoint stays on its exact PR");
assert.equal(relayCheckpointIssuePath({
  ...checkpointWake, repo: "jan2xo/bke-demo-app",
}), "/repos/jan2xo/bke-demo-app/issues/145/comments",
"same-number demo PR checkpoint MUST NOT write to the control PR");
assert.equal(relayCheckpointIssuePath({
  ...checkpointWake, repo: "jan2xo/unknown",
}), null, "nonallowlisted repository is never a checkpoint target");
assert.equal(relayCheckpointIssuePath({
  ...checkpointWake, pr_number: 0,
}), null, "nonpositive PR number cannot produce a checkpoint target");
assert.equal(relayCheckpointIssuePath({
  ...checkpointWake, worker_id: "invalid/worker",
}), null, "invalid worker identity cannot produce a checkpoint target");
assert.equal(relayCheckpointIssuePath(null), null,
  "absent/malformed wake cannot become a GitHub write target");


assert.equal(classifyUnmatchedRelayAck(
  Array.from({length:64},(_,i)=>"newer-delivery-"+i),
  retained, "android-worker-a", "old-active-82",
), "stale_archived",
  "a sent wake still ACKing after recent-ID eviction must not kill its successor socket");
assert.equal(classifyUnmatchedRelayAck(
  ["old-active-82"], retained, "android-worker-a", "old-active-82",
), "stale_recent", "recent duplicates preserve original benign behavior");
assert.equal(classifyUnmatchedRelayAck(
  [], retained, "android-worker-a", "old-queued-82",
), "unknown", "queued-only archival metadata is not proof of a sent wake");
assert.equal(classifyUnmatchedRelayAck(
  [], retained, "android-worker-a", "never-issued",
), "unknown", "unknown ACK IDs still fail closed");
assert.equal(classifyUnmatchedRelayAck(
  [], [{wake:{...priorWake,worker_id:"another-worker"},phase:"sent"}],
  "android-worker-a", "old-active-82",
), "invalid", "cross-worker archive corruption fails closed");
assert.equal(classifyUnmatchedRelayAck(
  ["INVALID DELIVERY"], retained, "android-worker-a", "old-active-82",
), "invalid", "invalid recent-ID storage is not valid ACK evidence");
assert.equal(classifyUnmatchedRelayAck(
  [], retained, "another-worker", "old-active-82",
), "invalid", "wrong worker cannot use archived ACK exemption");

const sameRepoForeignQueued = {
  ...matchingControlWake.wake,
  pr_number: assignment.number + 1,
  delivery_id: "same-repo-different-pr-queued",
};
const queuedMismatchWithActive = planRecovery(
  [assignment], matchingControlWake, sameRepoForeignQueued,
);
assert.equal(queuedMismatchWithActive.state, "assignment_identity_requires_owner",
  "matching active PR cannot conceal an unrelated queued PR in the same repo");
assert.equal(queuedMismatchWithActive.deliveryId, "existing-delivery",
  "owner receives the preserved active delivery identity");
assert.equal(queuedMismatchWithActive.queuedDeliveryId,
  "same-repo-different-pr-queued", "conflicting queued delivery remains visible");
assert.equal(queuedMismatchWithActive.archivedCount, 0);
const queuedMismatchWithoutActive = planRecovery(
  [assignment], null, sameRepoForeignQueued,
);
assert.equal(queuedMismatchWithoutActive.state, "assignment_identity_requires_owner",
  "empty active slot cannot permit recreating one PR over a different queued PR");
assert.equal(queuedMismatchWithoutActive.queuedDeliveryId,
  "same-repo-different-pr-queued");
assert.equal(planRecovery(
  [assignment], wake(80, assignment.headSha, "queued"), sameRepoForeignQueued,
).state, "assignment_identity_requires_owner",
"queued cross-PR conflict blocks replacing an otherwise recoverable active slot");
assert.equal(planRecovery(
  [assignment], matchingControlWake, {
    ...sameRepoForeignQueued, pr_number: assignment.number,
  },
).state, "preserved_active_assignment",
"ordinary serialized same-repository same-PR queue remains compatible");
assert.equal(planRecovery(
  [assignment], null, {
    ...sameRepoForeignQueued, pr_number: assignment.number,
  },
).state, "recovered", "ordinary same-PR queued recovery remains compatible");


// The boolean dispatch receipt may be queued/suppressed, but only an
// already-observed terminal ACK can preserve the socket after rollover.
for (const terminal of ["ack_observed_completed", "ack_observed_rejected"]) {
  assert.equal(classifyUnmatchedRelayAck([], undefined, "android-worker-a",
    "old-terminal-delivery", terminal), "stale_terminal");
}
assert.equal(classifyUnmatchedRelayAck([], undefined, "android-worker-a",
  "old-terminal-delivery", true), "unknown",
  "plain accepted dispatch receipt is not a sent or completed ACK");
assert.equal(classifyUnmatchedRelayAck([], undefined, "android-worker-a",
  "old-terminal-delivery", "CORRUPT"), "invalid");
assert.equal(classifyUnmatchedRelayAck([], [
  {wake:{...priorWake,delivery_id:"old-terminal-delivery"},phase:"queued"},
], "android-worker-a", "old-terminal-delivery", "ack_observed_completed"), "unknown",
  "queued-only archive evidence defeats contradictory terminal receipt");
assert.equal(classifyUnmatchedRelayAck([], undefined, "android-worker-a",
  "never-issued", undefined), "unknown");


// A recovery attempt must not reconstruct a previously reserved prompt
// merely because its active wake slot later became empty. Keep the fence
// scoped to worker + repo + PR + exact head, not just PR number.
const targetWake = {
  protocol:1, type:"wake", worker_id:"android-worker-a",
  repo:"jan2xo/bke-worker", pr_number:82,
  expected_head_sha:"010ffef9ec62c8e663e6858938cb17b1cf26056d",
  reason:"github_pull_request_reconnect_recovery",
  delivery_id:"recovery-android-worker-a-82-010ffef9ec62c8e663e6858938cb17b1cf26056d",
};
const targetFence = recoverySendFenceKey(targetWake);
assert.equal(typeof targetFence,"string");
assert.equal(targetFence.startsWith("recovery_target_sent_v1:android-worker-a:"),true);
for(const changed of [
  {worker_id:"worker-b"}, {repo:"jan2xo/bke-demo-app"},
  {pr_number:83},{expected_head_sha:"f".repeat(40)},
]){
  assert.notEqual(recoverySendFenceKey({...targetWake,...changed}), targetFence,
    "distinct worker/repository/PR/head must have an independent send fence");
}
for(const invalid of [{...targetWake,repo:"attacker/other"},
                      {...targetWake,delivery_id:"unsafe id"},
                      {...targetWake,worker_id:"WRONG"}]){
  assert.equal(recoverySendFenceKey(invalid),null);
}
assert.equal(recoverySendFenceKey(null),null);


// Deterministic in-memory transactional DO-storage adapter exercising the
// very same send/recovery helpers used by WorkerSession. This is an executable
// isolated crash/commit-uncertainty test, NOT a live Workerd socket race.
function durableStorage(initial = []) {
  let persisted = new Map(initial);
  let chain = Promise.resolve();
  let throwAfterCommit = false;
  let throwBeforeCommit = false;
  return {
    snapshot: () => new Map(persisted),
    failAfterCommit: () => {throwAfterCommit = true;},
    failBeforeCommit: () => {throwBeforeCommit = true;},
    transaction(fn) {
      const result = chain.then(async () => {
        const next = new Map(persisted);
        const tx = {
          get: async key => next.get(key),
          put: async (key,value) => { next.set(key,value); },
          delete: async key => { next.delete(key); },
        };
        const value = await fn(tx);
        if (throwBeforeCommit) {
          throwBeforeCommit = false;
          throw new Error("STORAGE_PRECOMMIT_UNCERTAIN");
        }
        persisted = next;
        if (throwAfterCommit) {
          throwAfterCommit = false;
          throw new Error("STORAGE_POSTCOMMIT_UNCERTAIN");
        }
        return value;
      });
      chain = result.catch(()=>{});
      return result;
    },
  };
}
const crashWake = {...targetWake,reason:"github_pull_request_opened",
  delivery_id:"original-delivery-before-crash"};
const expectedRecoveryWake = {
  ...targetWake,
  reason:"github_pull_request_reconnect_recovery",
};
const sameTargetKey = recoverySendFenceKey(expectedRecoveryWake);
assert.equal(recoverySendFenceKey(crashWake),sameTargetKey,
  "send marker must bind to PR/head, NOT event reason or delivery ID");
const crashStore = durableStorage();
let secondSends = 0;
await crashStore.transaction(async tx => {
  await persistRecoverySendAttempt(tx,crashWake);
  await tx.put("active_wake",{wake:crashWake,phase:"sent"});
});
assert.equal(crashStore.snapshot().get(sameTargetKey),true,
  "commit to send reservation occurred before socket interruption");
await crashStore.transaction(tx => tx.delete("active_wake"));
assert.equal(crashStore.snapshot().has("active_wake"),false);
const absentSlotPlan=planRecovery([{
  workerId:"android-worker-a",number:82,headRef:"test/reconnect",
  headSha:crashWake.expected_head_sha,
}],null);
assert.equal(absentSlotPlan.state,"recovery_evidence_missing_requires_owner");
assert.equal(recoverySendFenceKey(absentSlotPlan.wake),sameTargetKey);
const recoveryAttempt = () => crashStore.transaction(async tx => {
  const candidate = absentSlotPlan.wake;
  const status = await inspectRecoverySendAttempt(tx,candidate,false);
  if(status !== "resume_persisted_wake") return status;
  secondSends++;
  return "UNSAFE_SEND";
});
const concurrent=await Promise.all(Array.from({length:12},recoveryAttempt));
assert.deepEqual(concurrent,Array(12).fill("previously_sent"),
  "12 concurrent reconnects must all deny on committed prior send marker");
assert.equal(secondSends,0,"no second WebSocket send was authorized");
const crossTargetStates=[
  {...expectedRecoveryWake,worker_id:"other-worker"},
  {...expectedRecoveryWake,repo:"jan2xo/bke-demo-app"},
  {...expectedRecoveryWake,pr_number:83},
  {...expectedRecoveryWake,expected_head_sha:"f".repeat(40)},
];
for(const changed of crossTargetStates) {
  assert.notEqual(recoverySendFenceKey(changed),sameTargetKey);
  assert.equal(await crashStore.transaction(tx =>
    inspectRecoverySendAttempt(tx,changed,false)), "missing_evidence",
    "a wrong-scope request without its own persisted state cannot synthesize");
}
assert.equal(await crashStore.transaction(tx =>
  inspectRecoverySendAttempt(tx,expectedRecoveryWake,true)),"previously_sent",
  "even a queued wake cannot override an existing send attempt");
const noMarker=durableStorage();
assert.equal(await noMarker.transaction(tx =>
  inspectRecoverySendAttempt(tx,expectedRecoveryWake,false)),
  "missing_evidence","missing pre-upgrade evidence cannot prove safe recovery");
const invalidMarker=durableStorage([[sameTargetKey,{unsafe:"corrupt"}]]);
assert.equal(await invalidMarker.transaction(tx =>
  inspectRecoverySendAttempt(tx,expectedRecoveryWake,false)),
  "previously_sent","corrupt present marker still denies rather than healing it");
const uncertain=durableStorage();
uncertain.failAfterCommit();
await assert.rejects(uncertain.transaction(async tx => {
  await persistRecoverySendAttempt(tx,crashWake);
  await tx.put("active_wake",{wake:crashWake,phase:"sent"});
}),/STORAGE_POSTCOMMIT_UNCERTAIN/);
assert.equal(await uncertain.transaction(tx =>
  inspectRecoverySendAttempt(tx,expectedRecoveryWake,false)),"previously_sent",
  "a committed send reservation survives post-commit transport uncertainty");
const rolledBack=durableStorage();
rolledBack.failBeforeCommit();
await assert.rejects(rolledBack.transaction(async tx => {
  await persistRecoverySendAttempt(tx,crashWake);
  await tx.put("active_wake",{wake:crashWake,phase:"sent"});
}),/STORAGE_PRECOMMIT_UNCERTAIN/);
assert.equal(await rolledBack.transaction(tx =>
  inspectRecoverySendAttempt(tx,expectedRecoveryWake,false)),"missing_evidence",
  "a failed/absent reservation still must not grant synthetic delivery authority");
await assert.rejects(inspectRecoverySendAttempt({
  get:async()=>{throw Error("STORAGE_READ_UNCERTAIN");},
},expectedRecoveryWake,false),/STORAGE_READ_UNCERTAIN/,
  "read outage must propagate to the outer 503 instead of meaning absence");
const persistedQueued = durableStorage([["active_wake",{
  wake:expectedRecoveryWake,phase:"queued",
}]]);
assert.equal(await persistedQueued.transaction(tx =>
  inspectRecoverySendAttempt(tx,expectedRecoveryWake,true)),
  "resume_persisted_wake",
  "a genuine queued wake with no prior send remains eligible for one reservation");
let queuedSends=0;
await Promise.all(Array.from({length:8},()=>persistedQueued.transaction(async tx=>{
  const current=await tx.get("active_wake");
  const s=await inspectRecoverySendAttempt(tx,expectedRecoveryWake,
    current?.phase==="queued");
  if(s!=="resume_persisted_wake") return s;
  await persistRecoverySendAttempt(tx,expectedRecoveryWake);
  await tx.put("active_wake",{wake:expectedRecoveryWake,phase:"sent"});
  queuedSends++;
  return "sent";
})));
assert.equal(queuedSends,1,
  "eight concurrently recovering a persisted queued wake reserve at most one send");
console.log("Reconnect crash / duplicate-prompt transaction harness: PASS");
