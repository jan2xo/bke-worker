#!/usr/bin/env python3
from __future__ import annotations

from datetime import datetime, timedelta, timezone
from pathlib import Path
import sys
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "scripts"))
from github_multiworker_preclaim import PreclaimDenied, evaluate_read_only_preclaim

NOW = datetime(2026, 10, 19, 16, 0, tzinfo=timezone.utc)
MS = int(NOW.timestamp() * 1000)
REPOS = ["jan2xo/bke-worker", "jan2xo/another-repo"]
SHA = "a" * 40


def pr(num=15, worker=None, repo=REPOS[0], sha=SHA, labels=None):
    return {"number":num, "state":"open", "head":{"sha":sha},
            "base":{"repo":{"full_name":repo}},
            "labels": ([{"name":f"bke-worker:{worker}"}] if worker else [])
                if labels is None else labels}


def session(worker="worker-a", d="1"):
    value=int(d, 16)
    digits=[format((value+i) % 16,"x") for i in range(5)]
    return {"worker_id":worker,
            "identity_public_key_sha256":digits[0]*64,
            "chatgpt_target_sha256":digits[1]*64,
            "browser_profile_sha256":digits[2]*64,
            "bridge_identity_sha256":digits[3]*64,
            "session_binding_sha256":digits[4]*64,
            "attested_at_ms":MS-1000,
            "expires_at_ms":MS+20000}


def policy(pages=None, attested=None, target=None, worker="worker-a", clock=None):
    items=list(pages if pages is not None else [pr()])
    observations=attested if attested is not None else [session()]
    counts={"sessions":0,"pages":0}
    def fetch(repo,page):
        counts["pages"]+=1
        rows=[p for p in items if p["base"]["repo"]["full_name"].lower()==repo]
        return (rows,False) if page==1 else ([],False)
    def read_sessions():
        counts["sessions"]+=1
        return observations() if callable(observations) else observations
    def run():
        return evaluate_read_only_preclaim(
            expected_repositories=REPOS,fetch_page=fetch,
            read_attested_sessions=read_sessions,
            requested_worker_id=worker,
            requested_target=target if target is not None else
            {"repository":REPOS[0],"number":15,"head_sha":SHA},
            clock=clock or (lambda:NOW))
    return run,counts


class PreclaimTests(unittest.TestCase):
    def denied(self,code,run):
        with self.assertRaisesRegex(PreclaimDenied,"^"+code+"$"):
            run()

    def test_positive_candidate_returns_no_dispatch_or_assignment_authority(self):
        run,counts=policy(pages=[pr(),pr(16,"worker-b",REPOS[1])],attested=[
            session(),session("worker-b","8")])
        value=run()
        self.assertEqual(value,{"state":"PRECLAIM_CONSISTENT_ONLY",
            "worker_id":"worker-a","repository":REPOS[0],"number":15,"head_sha":SHA,
            "assignment_authority":"NONE","dispatch_authority":"NONE",
            "wake_authority":"NONE","atomicity":"NONE"})
        self.assertEqual(counts["sessions"],2)
        self.assertEqual(counts["pages"],4)
        self.assertNotIn("session_binding_sha256",str(value))
        self.assertNotIn("browser_profile_sha256",str(value))

    def test_missing_or_inactive_vault_only_session_never_passes(self):
        run,_=policy(attested=[])
        self.denied("PRECLAIM_WORKER_NOT_ATTESTED",run)
        raw=session();del raw["session_binding_sha256"]
        run,_=policy(attested=[raw])
        self.denied("PRECLAIM_SESSION_SCHEMA_INVALID",run)
        raw=session();raw["state"]="PAIRED_INACTIVE_OBSERVED"
        run,_=policy(attested=[raw])
        self.denied("PRECLAIM_SESSION_SCHEMA_INVALID",run)

    def test_wrong_session_hash_expiration_future_and_client_asserted_flag(self):
        cases=[
            ({"session_binding_sha256":"bad"},"PRECLAIM_SESSION_RESOURCE_INVALID"),
            ({"expires_at_ms":MS},"PRECLAIM_SESSION_STALE_OR_FUTURE"),
            ({"expires_at_ms":MS+30001},"PRECLAIM_SESSION_STALE_OR_FUTURE"),
            ({"attested_at_ms":MS-15001},"PRECLAIM_SESSION_STALE_OR_FUTURE"),
            ({"attested_at_ms":MS+2001},"PRECLAIM_SESSION_STALE_OR_FUTURE"),
            ({"expires_at_ms":True},"PRECLAIM_SESSION_STALE_OR_FUTURE"),
            ({"verified":True},"PRECLAIM_SESSION_SCHEMA_INVALID"),
        ]
        for change,code in cases:
            with self.subTest(change=change):
                run,_=policy(attested=[{**session(),**change}])
                self.denied(code,run)

    def test_shared_target_profile_bridge_key_or_session_fails_closed(self):
        a=session();b=session("worker-b","8")
        for f in ("identity_public_key_sha256","chatgpt_target_sha256",
                  "browser_profile_sha256","bridge_identity_sha256",
                  "session_binding_sha256"):
            with self.subTest(field=f):
                run,_=policy(attested=[a,{**b,f:a[f]}])
                self.denied("PRECLAIM_GLOBAL_OWNERSHIP_AMBIGUOUS",run)

    def test_session_rebound_or_revocation_between_reads_fails(self):
        calls=0
        def changed():
            nonlocal calls
            calls+=1
            return [session()] if calls==1 else [session("worker-a","8")]
        run,_=policy(attested=changed)
        self.denied("PRECLAIM_SESSION_REBOUND",run)
        calls=0
        def removed():
            nonlocal calls
            calls+=1
            return [session()] if calls==1 else []
        run,_=policy(attested=removed)
        self.denied("PRECLAIM_SESSION_REBOUND",run)

    def test_assigned_worker_or_claimed_target_fails_without_side_effect(self):
        run,_=policy(pages=[pr(15),pr(99,"worker-a",REPOS[1])],attested=[])
        self.denied("PRECLAIM_GLOBAL_OWNERSHIP_AMBIGUOUS",run)
        run,_=policy(pages=[pr(15),pr(99,"worker-a",REPOS[1])],attested=[session()])
        self.denied("PRECLAIM_WORKER_ALREADY_ASSIGNED",run)
        run,_=policy(pages=[pr(15,"worker-b")],attested=[session(),session("worker-b","8")])
        self.denied("PRECLAIM_TARGET_ALREADY_ASSIGNED",run)

    def test_requested_pr_missing_or_changed_sha_fails_closed(self):
        run,_=policy(pages=[])
        self.denied("PRECLAIM_TARGET_CHANGED",run)
        run,_=policy(pages=[pr(15,sha="b"*40)])
        self.denied("PRECLAIM_TARGET_CHANGED",run)
        run,_=policy(target={"repository":REPOS[0],"number":15,"head_sha":"bad"})
        self.denied("PRECLAIM_TARGET_INVALID",run)

    def test_duplicate_worker_labels_and_session_inventory_change_rejected(self):
        run,_=policy(pages=[pr(labels=[{"name":"bke-worker:worker-a"},
                                    {"name":"bke-worker:worker-b"}])],
                     attested=[session(),session("worker-b","8")])
        self.denied("PRECLAIM_GLOBAL_OWNERSHIP_AMBIGUOUS",run)
        calls=0
        def alternating():
            nonlocal calls
            calls+=1
            return [session()] if calls==1 else [session("worker-b","8")]
        run,_=policy(attested=alternating)
        self.denied("PRECLAIM_SESSION_REBOUND",run)

    def test_invalid_or_exceptional_private_session_reader_never_passes(self):
        for data in (None,{"worker_id":"worker-a"},"verified",[None]):
            run,_=policy(attested=lambda d=data:d)
            self.denied("PRECLAIM_SESSIONS_UNAVAILABLE" if type(data) is not list
                        else "PRECLAIM_SESSION_SCHEMA_INVALID",run)
        def throws():
            raise RuntimeError("private token never leak")
        run,_=policy(attested=throws)
        self.denied("PRECLAIM_SESSION_READER_UNAVAILABLE",run)

    def test_non_monotonic_or_lengthy_preflight_window_rejects(self):
        for times in ((NOW,NOW,NOW-timedelta(seconds=1)),
                      (NOW,NOW,NOW+timedelta(seconds=16))):
            reads=iter(times)
            run,_=policy(clock=lambda:next(reads))
            self.denied("PRECLAIM_WINDOW_CHANGED",run)

    def test_candidate_id_and_target_shape_must_be_exact(self):
        run,_=policy(worker="WORKER-A")
        self.denied("PRECLAIM_INPUT_INVALID",run)
        run,_=policy(target={"repository":REPOS[0],"number":15,"head_sha":SHA,
                             "grant":True})
        self.denied("PRECLAIM_TARGET_INVALID",run)

    def test_no_runtime_dispatch_integration_or_network_change(self):
        root=Path(__file__).resolve().parents[1]
        dispatcher=(root/"scripts/github_serial_dispatcher.py").read_text()
        workflow=(root/".github/workflows/serial-dispatcher.yml").read_text()
        self.assertNotIn("evaluate_read_only_preclaim",dispatcher)
        self.assertNotIn("github_multiworker_preclaim",workflow)


if __name__=="__main__":
    unittest.main()
