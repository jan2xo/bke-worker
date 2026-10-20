#!/usr/bin/env python3
"""Adversarial source-only arbiter fixtures; no GitHub ref or browser mutation."""
from __future__ import annotations

from copy import deepcopy
from pathlib import Path
import sys
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "scripts"))
from github_atomic_claim import (
    ARBITER_REF, ClaimDenied, fence_uncertain_delivery,
    prepare_reservation, publish_by_fast_forward, validated_manifest,
)

START = "a" * 40
HEAD = "b" * 40
NOW = 100_000


def manifest():
    return {"version": 1, "sequence": 0, "claims": []}


def preflight(worker="worker-a", repo="jan2xo/bke-worker", number=115, head=HEAD):
    return {
        "state": "PRECLAIM_CONSISTENT_ONLY",
        "worker_id": worker, "repository": repo, "number": number, "head_sha": head,
        "assignment_authority": "NONE", "dispatch_authority": "NONE",
        "wake_authority": "NONE", "atomicity": "NONE",
    }


def observed(p=None, labels=None):
    p = preflight() if p is None else p
    return {
        "repository": p["repository"], "number": p["number"],
        "head_sha": p["head_sha"], "labels": [] if labels is None else labels,
    }


def reserve(m=None, p=None, live=None, labels=None, now=NOW):
    m = manifest() if m is None else m
    p = preflight() if p is None else p
    live = observed(p) if live is None else live
    labels = live["labels"] if labels is None else labels
    return prepare_reservation(
        manifest=m, preflight=p, current_pr=live,
        expected_labels=labels, now_ms=now,
    )


class FakeGitRef:
    """One shared Git ref; a fast-forward rejects a sibling commit."""
    def __init__(self):
        self.head = START
        self.commits = {START: {"parents": [], "manifest": manifest()}}
        self.serial = 1
        self.fail = False
        self.lost_reply_after_write = False

    def read_ref(self):
        return self.head

    def child(self, parent, value):
        sha = f"{self.serial:040x}"
        self.serial += 1
        self.commits[sha] = {"parents": [parent], "manifest": deepcopy(value)}
        return sha

    def inspect(self, sha):
        return self.commits[sha]

    def update(self, sha):
        if self.fail:
            raise OSError("GitHub API unavailable: sensitive response")
        parent = self.commits[sha]["parents"][0]
        if self.head != parent:
            return False
        self.head = sha
        if self.lost_reply_after_write:
            raise OSError("Response lost after write")
        return True

    def publish(self, expected, value):
        return publish_by_fast_forward(
            expected_head=expected, proposed_manifest=value,
            create_child_commit=self.child,
            inspect_commit=self.inspect,
            update_ref_nonforce=self.update,
            read_ref=self.read_ref,
        )


class AtomicClaimTests(unittest.TestCase):
    def denied(self, code, fn):
        with self.assertRaisesRegex(ClaimDenied, "^" + code + "$"):
            fn()

    def assert_no_authority(self, receipt):
        self.assertEqual(receipt["state"], "UNVERIFIED_CALLBACK_MODEL_ONLY")
        for field in ("evidence_authority", "assignment_authority",
                      "dispatch_authority", "wake_authority"):
            self.assertEqual(receipt[field], "NONE")
        self.assertNotIn("authorized", receipt)
        self.assertNotIn("delivery_token", receipt)

    def publish_with(self, git, pending, **changes):
        callbacks = dict(
            expected_head=START, proposed_manifest=pending,
            create_child_commit=git.child, inspect_commit=git.inspect,
            update_ref_nonforce=git.update, read_ref=git.read_ref,
        )
        callbacks.update(changes)
        return publish_by_fast_forward(**callbacks)

    def test_reservation_is_source_only_and_blocks_same_worker_or_pr(self):
        m, key = reserve()
        self.assertEqual(len(m["claims"]), 1)
        self.assertEqual(m["claims"][0]["claim_id"], key)
        self.assertEqual(m["claims"][0]["state"], "RESERVED")
        self.assertEqual(m["claims"][0]["lease_deadline_ms"], NOW + 30_000)
        self.denied("CLAIM_BUSY_OR_RECOVERY_REQUIRED", lambda: reserve(m))
        other_worker = preflight("worker-b")
        self.denied("CLAIM_BUSY_OR_RECOVERY_REQUIRED", lambda: reserve(m, other_worker))
        other_pr = preflight("worker-a", number=116)
        self.denied("CLAIM_BUSY_OR_RECOVERY_REQUIRED", lambda: reserve(m, other_pr))
        self.assertEqual(manifest()["claims"], [])

    def test_two_distinct_workers_and_prs_can_reserve_serially(self):
        first, _ = reserve()
        second, _ = reserve(first, preflight("worker-b", number=116))
        self.assertEqual(len(second["claims"]), 2)
        self.assertEqual(second["sequence"], 2)
        self.assertEqual(first["sequence"], 1)
        self.assertNotIn("browser_profile_sha256", str(second))
        self.assertNotIn("session_binding_sha256", str(second))

    def test_same_pr_race_exactly_one_sibling_fast_forward_wins(self):
        git = FakeGitRef()
        p1, _ = reserve()
        p2, _ = reserve(p=preflight("worker-b"))
        # Both contenders read START. Their sibling commits cannot both FF.
        a = git.child(START, p1)
        b = git.child(START, p2)
        self.assertTrue(git.update(a))
        self.assertFalse(git.update(b))
        self.assertEqual(git.head, a)
        # After ref reread the loser must revalidate global conflict.
        self.denied("CLAIM_BUSY_OR_RECOVERY_REQUIRED",
                    lambda: reserve(git.inspect(a)["manifest"], preflight("worker-b")))

    def test_same_worker_two_pr_race_serialization_blocks_reclaim(self):
        git = FakeGitRef()
        m1, _ = reserve()
        m2, _ = reserve(p=preflight(number=116))
        a, b = git.child(START, m1), git.child(START, m2)
        self.assertTrue(git.update(b))
        self.assertFalse(git.update(a))
        self.denied("CLAIM_BUSY_OR_RECOVERY_REQUIRED",
                    lambda: reserve(git.inspect(b)["manifest"]))

    def test_parallel_distinct_workers_retry_on_new_parent_works(self):
        git = FakeGitRef()
        a, _ = reserve()
        b, _ = reserve(p=preflight("worker-b", number=116))
        first = git.child(START, a)
        stale = git.child(START, b)
        self.assertTrue(git.update(first))
        self.assertFalse(git.update(stale))
        current = git.inspect(git.head)["manifest"]
        combined, _ = reserve(current, preflight("worker-b", number=116))
        receipt = git.publish(git.head, combined)
        self.assertEqual(receipt["state"], "UNVERIFIED_CALLBACK_MODEL_ONLY")
        self.assertEqual(receipt["assignment_authority"], "NONE")
        self.assertEqual(receipt["dispatch_authority"], "NONE")
        self.assertEqual(receipt["wake_authority"], "NONE")
        self.assertEqual(len(git.inspect(git.head)["manifest"]["claims"]), 2)

    def test_changed_pr_head_and_labels_fail(self):
        p = preflight()
        changed = observed(p)
        changed["head_sha"] = "c" * 40
        self.denied("CLAIM_PR_CHANGED", lambda: reserve(p=p, live=changed))
        changed = observed(p, ["bke-worker:worker-b"])
        self.denied("CLAIM_PR_ALREADY_ASSIGNED", lambda: reserve(p=p, live=changed))
        changed = observed(p, ["bke-task:blocked"])
        self.denied("CLAIM_PR_LABELS_CHANGED",
                    lambda: reserve(p=p, live=changed, labels=[]))
        self.denied("CLAIM_PR_LABELS_INVALID",
                    lambda: reserve(p=p, live=observed(p, ["a", "a"])))

    def test_stale_or_forged_preclaim_shape_never_grants_dispatch(self):
        p = preflight()
        p["dispatch_authority"] = "GRANTED"
        self.denied("CLAIM_PREFLIGHT_INVALID", lambda: reserve(p=p))
        p = preflight()
        p["verified"] = True
        self.denied("CLAIM_PREFLIGHT_INVALID", lambda: reserve(p=p))
        p = preflight()
        p["state"] = "PAIRED_INACTIVE_OBSERVED"
        self.denied("CLAIM_PREFLIGHT_INVALID", lambda: reserve(p=p))
        # A structurally valid forged callback is NOT authenticated here,
        # which is why receipt must never grant assignment or dispatch.

    def test_expiration_does_not_release_and_fence_after_expiry_fails(self):
        m, key = reserve()
        self.denied("CLAIM_BUSY_OR_RECOVERY_REQUIRED",
                    lambda: reserve(m, preflight("worker-b"), now=NOW + 1_000_000))
        self.denied("CLAIM_RECOVERY_REQUIRED",
                    lambda: fence_uncertain_delivery(
                        manifest=m, claim_id=key, now_ms=NOW + 30_000))

    def test_fence_before_delivery_stays_reserved_even_on_retry(self):
        m, key = reserve()
        marked = fence_uncertain_delivery(manifest=m, claim_id=key, now_ms=NOW+1)
        self.assertEqual(marked["claims"][0]["state"], "DELIVERY_UNCERTAIN")
        self.assertEqual(m["claims"][0]["state"], "RESERVED")
        self.denied("CLAIM_RECOVERY_REQUIRED",
                    lambda: fence_uncertain_delivery(
                        manifest=marked, claim_id=key, now_ms=NOW+2))
        self.denied("CLAIM_BUSY_OR_RECOVERY_REQUIRED",
                    lambda: reserve(marked, preflight("worker-b")))

    def test_before_commit_crash_has_no_published_reservation(self):
        git = FakeGitRef()
        pending, _ = reserve()
        self.assertEqual(git.head, START)
        self.assertEqual(len(pending["claims"]), 1)
        self.assertEqual(git.commits, {START: {"parents": [], "manifest": manifest()}})

    def test_after_commit_uncertain_reply_requires_reconciliation(self):
        git = FakeGitRef()
        git.lost_reply_after_write = True
        pending, _ = reserve()
        self.denied("CLAIM_REF_UPDATE_UNCERTAIN", lambda: git.publish(START, pending))
        published = git.inspect(git.head)["manifest"]
        self.assertEqual(len(published["claims"]), 1)
        self.denied("CLAIM_BUSY_OR_RECOVERY_REQUIRED", lambda: reserve(published))
        self.denied("CLAIM_ARBITER_MOVED", lambda: git.publish(START, pending))

    def test_api_outage_and_stale_ref_never_report_success(self):
        git = FakeGitRef()
        pending, _ = reserve()
        git.fail = True
        self.denied("CLAIM_REF_UPDATE_UNCERTAIN", lambda: git.publish(START, pending))
        self.assertEqual(git.head, START)
        git.fail = False
        git.head = "d" * 40
        self.denied("CLAIM_ARBITER_MOVED", lambda: git.publish(START, pending))

    def test_invalid_child_parent_or_manifest_is_rejected(self):
        git = FakeGitRef()
        pending, _ = reserve()
        def wrong_commit(sha, m):
            child = git.child(sha, m)
            git.commits[child]["parents"] = ["f" * 40]
            return child
        self.denied("CLAIM_CHILD_INVALID", lambda: publish_by_fast_forward(
            expected_head=START, proposed_manifest=pending,
            create_child_commit=wrong_commit, inspect_commit=git.inspect,
            update_ref_nonforce=git.update, read_ref=git.read_ref))

    def test_manifest_conflicts_and_bad_rows_are_fail_closed(self):
        m, _ = reserve()
        m["claims"].append(deepcopy(m["claims"][0]))
        self.denied("CLAIM_GLOBAL_CONFLICT", lambda: validated_manifest(m))
        m, _ = reserve()
        m["claims"][0]["state"] = ["not-hashable"]
        self.denied("CLAIM_ROW_INVALID", lambda: validated_manifest(m))
        m, _ = reserve()
        m["claims"][0]["head_sha"] = "BAD"
        self.denied("CLAIM_TARGET_INVALID", lambda: validated_manifest(m))

    def test_valid_reservation_then_durable_uncertainty_fence(self):
        git = FakeGitRef()
        initial, claim_id = reserve()
        first = git.publish(START, initial)
        self.assertEqual(first["state"], "UNVERIFIED_CALLBACK_MODEL_ONLY")
        fenced = fence_uncertain_delivery(
            manifest=initial, claim_id=claim_id, now_ms=NOW + 1)
        second = git.publish(git.head, fenced)
        self.assertEqual(second["state"], "UNVERIFIED_CALLBACK_MODEL_ONLY")
        self.assertEqual(
            git.inspect(git.head)["manifest"]["claims"][0]["state"],
            "DELIVERY_UNCERTAIN")

    def test_fast_forward_does_not_allow_noop_or_arbitrary_sequence(self):
        git = FakeGitRef()
        self.denied("CLAIM_TRANSITION_INVALID",
                    lambda: git.publish(START, manifest()))
        candidate = manifest()
        candidate["sequence"] = 1
        self.denied("CLAIM_TRANSITION_INVALID",
                    lambda: git.publish(START, candidate))
        self.assertEqual(git.head, START)

    def test_fast_forward_cannot_drop_or_modify_live_reservations(self):
        git = FakeGitRef()
        first, _ = reserve()
        git.publish(START, first)
        parent = git.head

        wiped = manifest()
        wiped["sequence"] = 2
        self.denied("CLAIM_TRANSITION_INVALID",
                    lambda: git.publish(parent, wiped))

        other, _ = reserve(first, preflight("worker-b", number=116))
        other["claims"][0]["head_sha"] = "c" * 40
        self.denied("CLAIM_TRANSITION_INVALID",
                    lambda: git.publish(parent, other))
        self.assertEqual(git.head, parent)

    def test_uncertainty_fence_cannot_be_reversed_or_repeated(self):
        git = FakeGitRef()
        first, key = reserve()
        git.publish(START, first)
        fenced = fence_uncertain_delivery(
            manifest=first, claim_id=key, now_ms=NOW + 1)
        git.publish(git.head, fenced)
        parent = git.head

        replay = deepcopy(fenced)
        replay["sequence"] += 1
        self.denied("CLAIM_TRANSITION_INVALID",
                    lambda: git.publish(parent, replay))
        reopened = deepcopy(replay)
        reopened["claims"][0]["state"] = "RESERVED"
        self.denied("CLAIM_TRANSITION_INVALID",
                    lambda: git.publish(parent, reopened))
        self.assertEqual(git.head, parent)

    def test_missing_or_malformed_parent_manifest_is_rejected(self):
        git = FakeGitRef()
        planned, _ = reserve()
        git.commits[START]["manifest"] = {"bad": "shape"}
        self.denied("CLAIM_MANIFEST_INVALID",
                    lambda: git.publish(START, planned))
        git.commits[START] = {"bad": "commit"}
        self.denied("CLAIM_PARENT_INVALID",
                    lambda: git.publish(START, planned))

    def test_forged_coherent_callbacks_cannot_grant_authority(self):
        # Every callback lies consistently and there is NO actual remote ref.
        # No pure function can cryptographically detect this. Its result must
        # never be interpreted as a verified GitHub write or worker lease.
        proposed, _ = reserve()
        child = "f" * 40
        observed_head = [START, child]
        fake_writes = []
        def read_ref():
            return observed_head.pop(0)
        def inspect(sha):
            if sha == START:
                return {"parents": [], "manifest": manifest()}
            if sha == child:
                return {"parents": [START], "manifest": deepcopy(proposed)}
            raise AssertionError("Unexpected commit")
        def create(parent, value):
            self.assertEqual(parent, START)
            self.assertEqual(value, proposed)
            return child
        def claim_success_without_remote_write(sha):
            fake_writes.append(sha)
            return True
        receipt = publish_by_fast_forward(
            expected_head=START, proposed_manifest=proposed,
            create_child_commit=create, inspect_commit=inspect,
            update_ref_nonforce=claim_success_without_remote_write,
            read_ref=read_ref,
        )
        self.assertEqual(fake_writes, [child])
        self.assert_no_authority(receipt)
        self.assertEqual(receipt["arbiter_head"], child)
        # The fake 'success' above is deliberately not evidence of GitHub.

    def test_untrusted_initial_ref_read_rejected_when_stale(self):
        git = FakeGitRef()
        pending, _ = reserve()
        self.denied("CLAIM_ARBITER_MOVED", lambda: self.publish_with(
            git, pending, read_ref=lambda: "f" * 40))
        self.assertEqual(git.head, START)

    def test_untrusted_child_create_and_inspect_lies_rejected(self):
        git = FakeGitRef()
        pending, _ = reserve()
        self.denied("CLAIM_CHILD_INVALID", lambda: self.publish_with(
            git, pending, create_child_commit=lambda _head, _value: START))
        def forged_child(_head, _value):
            return "f" * 40
        def forged_inspect(sha):
            if sha == START:
                return git.inspect(START)
            return {"parents": ["e" * 40], "manifest": pending}
        self.denied("CLAIM_CHILD_INVALID", lambda: self.publish_with(
            git, pending, create_child_commit=forged_child,
            inspect_commit=forged_inspect))
        self.assertEqual(git.head, START)

    def test_untrusted_parent_inspection_cannot_authorize_bad_shape(self):
        git = FakeGitRef()
        pending, _ = reserve()
        def fraudulent_parent(sha):
            if sha == START:
                return {"parents": [], "manifest": {"version": 1, "sequence": 2,
                    "claims": []}}
            return git.inspect(sha)
        self.denied("CLAIM_TRANSITION_INVALID", lambda: self.publish_with(
            git, pending, inspect_commit=fraudulent_parent))
        self.assertEqual(git.head, START)

    def test_untrusted_update_claims_success_without_ref_move(self):
        git = FakeGitRef()
        pending, _ = reserve()
        self.denied("CLAIM_REF_UPDATE_UNCERTAIN", lambda: self.publish_with(
            git, pending, update_ref_nonforce=lambda _head: True))
        self.assertEqual(git.head, START)

    def test_untrusted_update_false_or_exception_fails_closed(self):
        git = FakeGitRef()
        pending, _ = reserve()
        self.denied("CLAIM_REF_UPDATE_UNCERTAIN", lambda: self.publish_with(
            git, pending, update_ref_nonforce=lambda _head: False))
        def unavailable(_head):
            raise OSError("private provider error")
        self.denied("CLAIM_REF_UPDATE_UNCERTAIN", lambda: self.publish_with(
            git, pending, update_ref_nonforce=unavailable))
        self.assertEqual(git.head, START)

    def test_untrusted_post_update_ref_read_cannot_verify_commit(self):
        git = FakeGitRef()
        pending, _ = reserve()
        # The fake ref *does* advance; a lying stale reread cannot verify it.
        self.denied("CLAIM_REF_UPDATE_UNCERTAIN", lambda: self.publish_with(
            git, pending, read_ref=lambda: START))
        self.assertNotEqual(git.head, START)

    def test_replays_do_not_create_second_claim_or_prompt(self):
        git = FakeGitRef()
        candidate, _ = reserve()
        receipt = git.publish(START, candidate)
        self.assertEqual(receipt["arbiter_ref"], ARBITER_REF)
        self.denied("CLAIM_BUSY_OR_RECOVERY_REQUIRED",
                    lambda: reserve(git.inspect(git.head)["manifest"]))
        self.assertNotIn("delivery_token", str(receipt))


# F1-02 separate GitHub REST transport regressions are intentionally loaded
# by the existing cheap PR Guard atomic-claim test entrypoint.
from github_f1_private_arbiter_writer_contract import F1PrivateWriterTests

if __name__ == "__main__":
    unittest.main()
