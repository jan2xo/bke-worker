#!/usr/bin/env python3
"""Contract tests only: no GitHub login, browser, network or messages."""
import importlib.util
import json
import os
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

PATH = Path(__file__).resolve().parents[1] / "scripts/sandbox_single_worker.py"
spec = importlib.util.spec_from_file_location("sandbox_single_worker", PATH)
pilot = importlib.util.module_from_spec(spec)
spec.loader.exec_module(pilot)
HEAD = "a" * 40
NEXT = "b" * 40


def pr(number=1, head=HEAD, labels=None, repo=pilot.SANDBOX):
    return {"number": number, "state": "open", "head": {
        "sha": head, "repo": {"full_name": repo}},
        "labels": [{"name": x} for x in (labels if labels is not None else [pilot.LABEL])]}


class PilotTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.journal = Path(self.tmp.name) / "journal.json"

    def test_only_exactly_one_sandbox_label_and_pr(self):
        with patch.object(pilot, "github", return_value=[pr()]):
            self.assertEqual(pilot.assignment(), (1, HEAD))
        for bad in ([pr(labels=[pilot.LABEL, "bke-worker:another"])],
                    [pr(), pr(number=2)], [pr(repo="jan2xo/bke-worker")],
                    [pr(head="not-a-sha")]):
            with self.subTest(bad=bad), patch.object(pilot, "github", return_value=bad):
                with self.assertRaises(pilot.Blocked):
                    pilot.assignment()
        with patch.object(pilot, "github", return_value=[pr(labels=[])]):
            self.assertIsNone(pilot.assignment())

    def test_dry_run_does_not_write_journal_or_send(self):
        with patch.object(pilot, "assignment", return_value=(1, HEAD)), patch.object(pilot, "dispatch") as send:
            self.assertEqual(pilot.tick(self.journal, live=False, now=1000),
                             "DRY_RUN_READY:first:PR#1")
            send.assert_not_called()
        self.assertFalse(self.journal.exists())

    def test_live_first_turn_and_heartbeat_only_after_interval(self):
        with patch.object(pilot, "assignment", return_value=(1, HEAD)), patch.object(
                pilot, "check_live_configuration"), patch.object(pilot, "dispatch") as send:
            self.assertEqual(pilot.tick(self.journal, live=True, now=1000),
                             "DISPATCHED:first:PR#1")
            self.assertEqual(pilot.tick(self.journal, live=True, now=1020),
                             "WAITING_FOR_HEARTBEAT")
            self.assertEqual(pilot.tick(self.journal, live=True, now=2801),
                             "DISPATCHED:heartbeat-1:PR#1")
            self.assertEqual(send.call_count, 2)

    def test_head_change_wakes_on_next_poll(self):
        with patch.object(pilot, "check_live_configuration"), patch.object(pilot, "dispatch") as send:
            with patch.object(pilot, "assignment", return_value=(1, HEAD)):
                pilot.tick(self.journal, live=True, now=1000)
            with patch.object(pilot, "assignment", return_value=(1, NEXT)):
                # Still bounded by the heartbeat interval: no immediate
                # repeated prompt that could interrupt an in-flight turn.
                self.assertEqual(pilot.tick(self.journal, live=True, now=1020),
                                 "WAITING_FOR_HEARTBEAT")
                self.assertIn("DISPATCHED:head-change",
                              pilot.tick(self.journal, live=True, now=2801))
            self.assertEqual(send.call_count, 2)

    def test_removed_label_kills_wake(self):
        with patch.object(pilot, "assignment", return_value=None), patch.object(
                pilot, "dispatch") as send:
            self.assertEqual(pilot.tick(self.journal, live=True, now=2000),
                             "WAITING_NO_SANDBOX_ASSIGNMENT")
            send.assert_not_called()

    def test_uncertain_send_is_persistently_quarantined(self):
        with patch.object(pilot, "assignment", return_value=(1, HEAD)), patch.object(
                pilot, "check_live_configuration"), patch.object(pilot, "dispatch",
                side_effect=pilot.Blocked("SEND_OUTCOME_UNCERTAIN")):
            with self.assertRaises(pilot.Blocked):
                pilot.tick(self.journal, live=True, now=1000)
            self.assertIsNotNone(json.loads(self.journal.read_text())["pending"])
            with self.assertRaisesRegex(pilot.Blocked, "OWNER_RECOVERY_REQUIRED"):
                pilot.tick(self.journal, live=True, now=5000)

    def test_rate_cap_and_no_cross_pr_reassignment(self):
        state = {"assignment": 1, "pending": None, "sends": [
            {"time": i, "key": "old" + str(i), "head": HEAD}
            for i in (800, 900, 1000)]}
        self.journal.write_text(json.dumps(state))
        with patch.object(pilot, "assignment", return_value=(1, HEAD)):
            self.assertEqual(pilot.tick(self.journal, live=False, now=1200), "RATE_CAP_STOP")
        with patch.object(pilot, "assignment", return_value=(2, NEXT)):
            with self.assertRaisesRegex(pilot.Blocked, "PREVIOUS_ASSIGNMENT"):
                pilot.tick(self.journal, live=False, now=5000)

    def test_live_arming_requires_dedicated_session_and_loopback(self):
        valid = {"BKE_SANDBOX_LIVE_SEND_ENABLED": "YES",
                 "BKE_WORKER_CHATGPT_OVERRIDE_URL": "https://chatgpt.com/c/" + "a" * 8 + "-" + "b" * 4 + "-" + "c" * 4 + "-" + "d" * 4 + "-" + "e" * 12,
                 "BKE_WORKER_BROWSER_CDP_ENDPOINT": "http://127.0.0.1:9222",
                 "BKE_WORKER_CHATGPT_PROFILE": "/home/owner/sandbox-pilot-profile"}
        with patch.dict(os.environ, valid):
            pilot.check_live_configuration()
            with patch.dict(os.environ, {"BKE_WORKER_BROWSER_CDP_ENDPOINT": "http://0.0.0.0:9222"}):
                with self.assertRaisesRegex(pilot.Blocked, "LOOPBACK_CDP"):
                    pilot.check_live_configuration()
            with patch.dict(os.environ, {"BKE_SANDBOX_LIVE_SEND_ENABLED": "NO"}):
                with self.assertRaisesRegex(pilot.Blocked, "OWNER_LIVE_OPT_IN"):
                    pilot.check_live_configuration()


if __name__ == "__main__":
    unittest.main()
