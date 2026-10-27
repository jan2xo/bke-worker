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


def pr(number=pilot.PR_NUMBER, head=HEAD, labels=None, repo=pilot.SANDBOX,
       branch=pilot.PR_BRANCH, base="main"):
    return {"number": number, "state": "open", "head": {
        "sha": head, "ref": branch, "repo": {"full_name": repo}},
        "base": {"ref": base},
        "labels": [{"name": x} for x in (labels if labels is not None else [pilot.LABEL])]}


class PilotTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.journal = Path(self.tmp.name) / "journal.json"

    def test_only_exactly_one_sandbox_label_and_pr(self):
        with patch.object(pilot, "github", return_value=[pr()]):
            self.assertEqual(pilot.assignment(), (pilot.PR_NUMBER, HEAD))
        for bad in ([pr(labels=[pilot.LABEL, "bke-worker:another"])],
                    [pr(), pr(number=149)], [pr(repo="jan2xo/other")],
                    [pr(head="not-a-sha")]):
            with self.subTest(bad=bad), patch.object(pilot, "github", return_value=bad):
                with self.assertRaises(pilot.Blocked):
                    pilot.assignment()
        with patch.object(pilot, "github", return_value=[pr(labels=[])]):
            self.assertIsNone(pilot.assignment())

    def test_strict_same_repo_pr_branch_and_prompt(self):
        self.assertEqual(pilot.SANDBOX, "jan2xo/bke-worker")
        self.assertEqual(pilot.PR_NUMBER, 148)
        self.assertEqual(pilot.PR_BRANCH, "pilot/one-worker-two-real-turns")
        for bad in ([pr(number=149)], [pr(branch="wrong-branch")],
                    [pr(base="wrong-base")]):
            with patch.object(pilot, "github", return_value=bad):
                with self.assertRaises(pilot.Blocked):
                    pilot.assignment()
        message = pilot.prompt(148, HEAD)
        self.assertIn(pilot.PILOT_FILE, message)
        self.assertIn("Do not merge", message)

    def test_two_send_limit_stops_third_wake(self):
        with patch.object(pilot, "assignment", return_value=(pilot.PR_NUMBER, HEAD)), patch.object(
                pilot, "check_live_configuration"), patch.object(pilot, "dispatch") as send:
            pilot.tick(self.journal, live=True, now=1000)
            pilot.tick(self.journal, live=True, now=2801)
            self.assertEqual(pilot.tick(self.journal, live=True, now=9999),
                             "PILOT_TWO_SEND_LIMIT_REACHED")
            self.assertEqual(send.call_count, 2)

    def test_dry_run_does_not_write_journal_or_send(self):
        with patch.object(pilot, "assignment", return_value=(pilot.PR_NUMBER, HEAD)), patch.object(pilot, "dispatch") as send:
            self.assertEqual(pilot.tick(self.journal, live=False, now=1000),
                             "DRY_RUN_READY:first:PR#148")
            send.assert_not_called()
        self.assertFalse(self.journal.exists())

    def test_live_first_turn_and_heartbeat_only_after_interval(self):
        with patch.object(pilot, "assignment", return_value=(pilot.PR_NUMBER, HEAD)), patch.object(
                pilot, "check_live_configuration"), patch.object(pilot, "dispatch") as send:
            self.assertEqual(pilot.tick(self.journal, live=True, now=1000),
                             "DISPATCHED:first:PR#148")
            self.assertEqual(pilot.tick(self.journal, live=True, now=1020),
                             "WAITING_FOR_HEARTBEAT")
            self.assertEqual(pilot.tick(self.journal, live=True, now=2801),
                             "DISPATCHED:heartbeat-1:PR#148")
            self.assertEqual(send.call_count, 2)

    def test_head_change_wakes_on_next_poll(self):
        with patch.object(pilot, "check_live_configuration"), patch.object(pilot, "dispatch") as send:
            with patch.object(pilot, "assignment", return_value=(pilot.PR_NUMBER, HEAD)):
                pilot.tick(self.journal, live=True, now=1000)
            with patch.object(pilot, "assignment", return_value=(pilot.PR_NUMBER, NEXT)):
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
        with patch.object(pilot, "assignment", return_value=(pilot.PR_NUMBER, HEAD)), patch.object(
                pilot, "check_live_configuration"), patch.object(pilot, "dispatch",
                side_effect=pilot.Blocked("SEND_OUTCOME_UNCERTAIN")):
            with self.assertRaises(pilot.Blocked):
                pilot.tick(self.journal, live=True, now=1000)
            self.assertIsNotNone(json.loads(self.journal.read_text())["pending"])
            with self.assertRaisesRegex(pilot.Blocked, "OWNER_RECOVERY_REQUIRED"):
                pilot.tick(self.journal, live=True, now=5000)

    def test_sender_failure_is_local_log_only_and_unknown_send_quarantined(self):
        fake = type("Exit", (), {"returncode": 1})()
        with patch.dict(os.environ, {"BKE_SANDBOX_JOURNAL": str(self.journal)}), patch.object(
                pilot.subprocess, "run", return_value=fake) as command:
            with self.assertRaisesRegex(pilot.Blocked, "SEND_OUTCOME_UNCERTAIN"):
                pilot.dispatch("bounded test message")
        args, kwargs = command.call_args
        self.assertEqual(args[0][0], "bash")
        self.assertEqual(kwargs["stderr"], pilot.subprocess.STDOUT)
        self.assertNotEqual(kwargs["stdout"], pilot.subprocess.DEVNULL)
        local_log = self.journal.with_suffix(".send.log")
        self.assertTrue(local_log.is_file())
        self.assertEqual(local_log.stat().st_mode & 0o777, 0o600)
        self.assertNotIn("bounded test message", local_log.read_text())
        self.assertEqual(kwargs["env"]["BKE_WORKER_ENV_FILE"], "/dev/null")

    def test_confirmed_first_turn_recovery_is_parseable_and_backup_first(self):
        import subprocess
        script = PATH.parents[1] / "scripts/reconcile-pilot-confirmed-turn-one.sh"
        self.assertTrue(script.exists())
        result = subprocess.run(["bash", "-n", str(script)], capture_output=True, text=True)
        self.assertEqual(result.returncode, 0, result.stderr)
        text = script.read_text(encoding="utf-8")
        body = text.split("python3 - <<'PY'\n", 1)[1].rsplit("\nPY\n", 1)[0]
        compile(body, str(script), "exec")
        for guard in (
                "PILOT_HEAD_OR_BRANCH_MISMATCH",
                "PILOT_ASSIGNMENT_AMBIGUOUS",
                "CONFLICTING_PILOT_ASSIGNMENT",
                "FIRST_TURN_COMMIT_HISTORY_MISMATCH",
                "FIRST_TURN_SCOPE_MISMATCH",
                "FIXTURE_NOT_EXACTLY_TURN_ONE",
                "VERIFIED_FIRST_TURN_CHECKPOINT_MISSING_OR_AMBIGUOUS",
                "JOURNAL_NOT_ONE_UNCONFIRMED_FIRST_SEND",
                "PENDING_SEND_DOES_NOT_MATCH_FIRST_TURN",
                "PILOT_RUNTIME_LOCK_HELD",
                "OWNER_ATTESTATION_REQUIRED",
                "BACKUP_READBACK_MISMATCH",
                "NO_LIVE_RESTART:TURN2_NOT_CERTIFIED",
        ):
            self.assertIn(guard, text)
        self.assertLess(text.index("BACKUP_READBACK_MISMATCH"),
                        text.index("os.replace(tmp, path)"))
        self.assertIn('"time": pending["time"]', text)
        self.assertNotIn("scripts/send-chatgpt-live.sh", text)

    def test_rate_cap_and_no_cross_pr_reassignment(self):
        state = {"assignment": pilot.PR_NUMBER, "pending": None, "sends": [
            {"time": i, "key": "old" + str(i), "head": HEAD}
            for i in (800, 900, 1000)]}
        self.journal.write_text(json.dumps(state))
        with patch.object(pilot, "assignment", return_value=(pilot.PR_NUMBER, HEAD)):
            self.assertEqual(pilot.tick(self.journal, live=False, now=1200), "RATE_CAP_STOP")
        with patch.object(pilot, "assignment", return_value=(149, NEXT)):
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

    def test_send_ack_probe_is_non_sending_and_private(self):
        root = Path(__file__).resolve().parents[1]
        tool = (root / "tools/BKE.Worker.ChatGPT.AckProbe/Program.cs").read_text(encoding="utf-8")
        script = (root / "scripts/probe-pilot-send-ack.sh").read_text(encoding="utf-8")
        # The probe may only observe: no send, click, fill, typing or key presses.
        for forbidden in (".Send(", "ClickAsync", "FillAsync", "TypeAsync", "PressAsync",
                          "Keyboard", "pilot-macos", "send-chatgpt-live"):
            self.assertNotIn(forbidden, tool)
            self.assertNotIn(forbidden, script)
        for forbidden in ("tick(", "dispatch(", "save_journal", "BKE_SANDBOX_LIVE_SEND_ENABLED"):
            self.assertNotIn(forbidden, script)
        # The instruction travels on stdin and is never echoed; output is codes only.
        self.assertIn("Console.In.ReadToEndAsync", tool)
        self.assertNotIn("Console.WriteLine(instruction", tool)
        self.assertIn("InspectDeliveredTurn", tool)
        self.assertIn("NOTHING_SENT", tool)
        self.assertIn("CDP_PORT_ALREADY_ACTIVE", script)
        self.assertIn("IMPLEMENTATION_HEAD_NOT_EXACT", script)
        self.assertIn("BKE_WORKER_CHATGPT_OVERRIDE_URL=\"$CHAT_URL\"", script)
        self.assertIn('read -r -p "Paste the dedicated chat URL', script)
        self.assertIn('open -n -a "$APP" --args', script)
        self.assertIn("--remote-debugging-address=127.0.0.1", script)
        # The script must be a single syntactically valid non-sending operator entrypoint.
        import subprocess
        result = subprocess.run(["bash", "-n", str(root / "scripts/probe-pilot-send-ack.sh")],
                                capture_output=True, text=True)
        self.assertEqual(result.returncode, 0, result.stderr)
        # The reconstructed instruction is exactly the turn-1 prompt for the turn-1 head.
        self.assertIn('TURN1_HEAD="3c7de7d9740948c294ea3bbd8bcc5a2d515c82ef"', script)
        self.assertIn("p.prompt(p.PR_NUMBER, sys.argv[1])", script)


if __name__ == "__main__":
    unittest.main()
