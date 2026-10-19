#!/usr/bin/env python3
from __future__ import annotations

from datetime import datetime, timedelta, timezone
from pathlib import Path
import importlib.util
import unittest

MODULE = Path(__file__).resolve().parents[1] / "scripts/github_multiworker_ownership.py"
spec = importlib.util.spec_from_file_location("multiworker_ownership", MODULE)
assert spec and spec.loader
audit = importlib.util.module_from_spec(spec)
spec.loader.exec_module(audit)

NOW = datetime(2026, 10, 19, 14, 0, tzinfo=timezone.utc)
REPOS = ["jan2xo/bke-worker", "jan2xo/bke-demo-app"]
FIELDS = (
    "identity_public_key_sha256", "chatgpt_target_sha256",
    "browser_profile_sha256", "bridge_identity_sha256",
    "session_binding_sha256",
)


def reg(worker: str, digit: str):
    return {"worker_id": worker, **{
        name: str(hex((int(digit, 16) + index) % 16))[2:] * 64
        for index, name in enumerate(FIELDS)
    }}


def pr(worker: str | None, num: int, repo="jan2xo/bke-worker", labels=None):
    return {
        "repository": repo,
        "number": num,
        "state": "open",
        "head_sha": "a" * 40,
        "labels": ([{"name": f"bke-worker:{worker}"}] if worker else [])
        if labels is None else labels,
    }


def snapshot(prs=None, repos=None):
    return {
        "complete": True,
        "observed_at": NOW.isoformat(),
        "repositories": list(REPOS if repos is None else repos),
        "pull_requests": list(prs or []),
    }


def run(prs=None, registrations=None, observed=None, repos=None):
    s = snapshot(prs, repos)
    if observed:
        s["observed_at"] = observed
    return audit.audit_multiworker_consistency(
        expected_repositories=REPOS, github_snapshot=s,
        verified_registrations=list(registrations or []), now=NOW,
    )


class MultiworkerOwnershipTests(unittest.TestCase):
    def denied(self, code, *, prs=None, registrations=None, snap=None, scope=None):
        payload = snapshot(prs) if snap is None else snap
        with self.assertRaisesRegex(audit.OwnershipAuditError, "^" + code + "$"):
            audit.audit_multiworker_consistency(
                expected_repositories=REPOS if scope is None else scope,
                github_snapshot=payload,
                verified_registrations=list(registrations or []), now=NOW,
            )

    def test_parallel_distinct_worker_pr_and_resource_evidence_are_consistent_only(self):
        out = run(
            [pr("android-worker-a", 24), pr("desktop-worker-b", 31, REPOS[1]), pr(None, 55)],
            [reg("android-worker-a", "1"), reg("desktop-worker-b", "8")],
        )
        self.assertEqual(out["state"], "OWNERSHIP_CONSISTENT")
        self.assertEqual(out["assigned_workers"], 2)
        self.assertEqual(out["open_pull_requests"], 3)
        self.assertEqual(out["scanned_repositories"], 2)
        self.assertEqual(out["dispatch_authority"], "NONE")
        self.assertEqual(out["wake_authority"], "NONE")
        self.assertEqual(out["worker_liveness"], "UNKNOWN")
        self.assertEqual(out["assignments"]["desktop-worker-b"]["number"], 31)
        self.assertNotIn("chatgpt_target_sha256", str(out))

    def test_zero_assignments_do_not_invent_a_task(self):
        out = run([pr(None, 21)])
        self.assertEqual(out["assigned_workers"], 0)
        self.assertEqual(out["assignments"], {})

    def test_duplicate_worker_across_two_repositories_rejected(self):
        self.denied("WORKER_MULTIPLE_ACTIVE_PRS",
                    prs=[pr("worker-a", 1), pr("worker-a", 2, REPOS[1])],
                    registrations=[reg("worker-a", "1")])

    def test_two_labels_on_one_pr_rejected(self):
        both = [{"name": "bke-worker:worker-a"}, {"name": "bke-worker:worker-b"}]
        self.denied("PR_MULTIPLE_WORKER_LABELS",
                    prs=[pr(None, 4, labels=both)],
                    registrations=[reg("worker-a", "1"), reg("worker-b", "8")])

    def test_duplicate_labels_even_case_changes_are_rejected(self):
        labels = [{"name": "bke-worker:worker-a"}, {"name": "BKE-WORKER:worker-a"}]
        self.denied("PR_LABELS_DUPLICATE_OR_INVALID", prs=[pr(None, 2, labels=labels)])
        self.denied("PR_WORKER_ID_INVALID",
                    prs=[pr(None, 2, labels=[{"name": "bke-worker:UPPER"}])])
        self.denied("PR_WORKER_ID_INVALID",
                    prs=[pr(None, 2, labels=[{"name": "bke-worker:"}])])

    def test_shared_chatgpt_target_profile_bridge_device_key_session_all_fail(self):
        a, b = reg("worker-a", "1"), reg("worker-b", "8")
        for field in FIELDS:
            changed = dict(b)
            changed[field] = a[field]
            self.denied("CROSS_WORKER_RESOURCE_COLLISION",
                        prs=[pr("worker-a", 1), pr("worker-b", 2, REPOS[1])],
                        registrations=[a, changed])

    def test_missing_unverified_worker_fails_closed(self):
        self.denied("ASSIGNED_WORKER_UNVERIFIED",
                    prs=[pr("worker-a", 1)], registrations=[])
        self.denied("REGISTRATION_DUPLICATE_WORKER",
                    registrations=[reg("worker-a", "1"), reg("worker-a", "8")])
        malformed = dict(reg("worker-a", "1"))
        malformed["approved"] = True
        self.denied("REGISTRATION_SCHEMA_INVALID", registrations=[malformed])
        malformed = dict(reg("worker-a", "1"))
        malformed["browser_profile_sha256"] = "BAD"
        self.denied("REGISTRATION_RESOURCE_INVALID", registrations=[malformed])

    def test_incomplete_and_scoped_inventory_never_elevate(self):
        incomplete = snapshot([pr("worker-a", 1)])
        incomplete["complete"] = False
        self.denied("GITHUB_INVENTORY_INCOMPLETE", snap=incomplete)
        incomplete = snapshot()
        incomplete.pop("complete")
        self.denied("GITHUB_INVENTORY_INCOMPLETE", snap=incomplete)
        incomplete = snapshot(repos=[REPOS[0]])
        self.denied("GITHUB_REPOSITORY_SCOPE_MISMATCH", snap=incomplete)
        duplicate = snapshot(repos=[REPOS[0], REPOS[0].upper()])
        self.denied("REPOSITORY_SCOPE_DUPLICATE", snap=duplicate)

    def test_stale_future_or_unzoned_snapshot_never_claims_consistency(self):
        for stamp in [(NOW-timedelta(seconds=61)).isoformat(),
                      (NOW+timedelta(seconds=6)).isoformat()]:
            s = snapshot()
            s["observed_at"] = stamp
            self.denied("GITHUB_SNAPSHOT_STALE_OR_FUTURE", snap=s)
        s = snapshot()
        s["observed_at"] = "2026-10-19T14:00:00"
        self.denied("GITHUB_SNAPSHOT_TIME_INVALID", snap=s)

    def test_duplicate_or_nonopen_pr_snapshot_is_ambiguous(self):
        self.denied("GITHUB_PR_DUPLICATE", prs=[pr(None, 2), pr(None, 2)])
        closed = pr(None, 3)
        closed["state"] = "closed"
        self.denied("GITHUB_SNAPSHOT_NONOPEN_PR", prs=[closed])
        bad = pr("worker-a", 3)
        bad["head_sha"] = "b" * 39
        self.denied("GITHUB_PR_HEAD_INVALID", prs=[bad])
        bad = pr(None, 4)
        bad["number"] = True
        self.denied("GITHUB_PR_NUMBER_INVALID", prs=[bad])

    def test_unexpected_repository_or_label_schema_is_denied(self):
        self.denied("GITHUB_PR_OUTSIDE_SCOPE", prs=[pr(None, 1, "different/project")])
        bad = pr(None, 1, labels=["bke-worker:worker-a"])
        self.denied("PR_LABELS_INVALID", prs=[bad])
        bad = pr(None, 1, labels=[{"name": "a"}, {"name": "a"}])
        self.denied("PR_LABELS_DUPLICATE_OR_INVALID", prs=[bad])
        bad = pr(None, 1)
        bad["trusted"] = True
        self.denied("GITHUB_PR_SCHEMA_INVALID", prs=[bad])

    def test_registration_collision_blocked_even_before_any_pr_is_assigned(self):
        a, b = reg("worker-a", "1"), reg("worker-b", "8")
        b["session_binding_sha256"] = a["session_binding_sha256"]
        self.denied("CROSS_WORKER_RESOURCE_COLLISION", registrations=[a,b])


if __name__ == "__main__":
    unittest.main()
