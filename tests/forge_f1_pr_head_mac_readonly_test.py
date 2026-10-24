#!/usr/bin/env python3
"""F1-03 PR-head READ-ONLY Mac diagnostic contract: deterministic Linux mocks."""
from __future__ import annotations
from contextlib import redirect_stdout, redirect_stderr
import importlib.util
import io
import os
from pathlib import Path
from unittest import TestCase, main, mock

SOURCE = Path(__file__).resolve().parents[1] / "scripts/forge_f1_pr_head_mac_readonly.py"
SPEC = importlib.util.spec_from_file_location("f1_pr_head_readonly", SOURCE)
mod = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(mod)
HEAD = "a" * 40
MAIN = "b" * 40
HASH = "1234567890abcdef" * 4


class TTY(io.StringIO):
    def isatty(self):
        return True


class MacReadOnlyContract(TestCase):
    def source(self, *, branch=None, origin=None, dirty="", pr=None,
               remote_main=None, ancestry="", head=None, remote_lines=None):
        branch = mod.BRANCH if branch is None else branch
        origin = mod.PUBLIC_REPO if origin is None else origin
        pr = HEAD if pr is None else pr
        remote_main = MAIN if remote_main is None else remote_main
        head = HEAD if head is None else head
        responses = {
            ("rev-parse", "--show-toplevel"): str(mod.ROOT),
            ("remote", "get-url", "origin"): origin,
            ("branch", "--show-current"): branch,
            ("status", "--porcelain", "--untracked-files=all"): dirty,
            ("rev-parse", "HEAD"): head,
            ("merge-base", "--is-ancestor", remote_main, "HEAD"): ancestry,
        }
        def fake_git(*args):
            if args not in responses:
                raise AssertionError("unexpected Git operation: " + repr(args))
            return responses[args]
        remote = remote_lines if remote_lines is not None else (
            pr + "\t" + mod.PR_REF + "\n" +
            remote_main + "\t" + mod.MAIN_REF
        )
        def fake_command(args, timeout=30):
            self.assertEqual(args, ["/usr/bin/git", "ls-remote",
                                    mod.PUBLIC_REPO, mod.PR_REF, mod.MAIN_REF])
            return remote
        with mock.patch.object(mod, "git", side_effect=fake_git), \
             mock.patch.object(mod, "command", side_effect=fake_command):
            return mod.snapshot_source()

    def test_live_pr_ref_and_current_main_ancestry_are_both_required(self):
        self.assertEqual(self.source(), (HEAD, MAIN))

    def test_fail_closed_branch_origin_dirty_pr_and_git_anomalies(self):
        for kwargs in [
            {"branch": "main"},
            {"branch": "feat/some-other-intent"},
            {"origin": "https://github.com/attacker/bke-worker.git"},
            {"dirty": " M tests/unsafe.py"},
            {"dirty": "?? secret.tmp"},
            {"pr": "c" * 40},
            {"head": "not-a-sha"},
            {"remote_lines": HEAD + "\t" + mod.PR_REF},
            {"remote_lines": HEAD+"\t"+mod.PR_REF+"\n"+MAIN+"\t"+mod.MAIN_REF+
                             "\n"+MAIN+"\t"+mod.MAIN_REF},
            {"remote_lines": HEAD+"\trefs/heads/rogue\n"+MAIN+"\t"+mod.MAIN_REF},
            {"ancestry": "unexpected output"},
        ]:
            with self.subTest(kwargs=kwargs):
                with self.assertRaises(mod.Blocked):
                    self.source(**kwargs)

    def test_source_verification_is_exactly_repeated_after_probing(self):
        source = SOURCE.read_text()
        self.assertIn("before = snapshot_source()", source)
        self.assertIn("after = snapshot_source()", source)
        self.assertIn("if after != before:", source)
        self.assertIn("GIT_OPTIONAL_LOCKS", source)
        self.assertIn("refs/pull/146/head", source)

    def mac_probe(self, *, selected=1, statuses=None, expected_error=None):
        home = "/Users/operator"
        binary = "/Applications/" + mod.APP_EXE
        chain = "PROFILE_CHAIN_PRIVATE_OWNER_VERIFIED"
        signature = "BKE_CHROME_GOOGLE_SIGNER_VERIFIED"
        profile_runs = [chain, chain]
        signer_runs = [signature,signature]
        process_runs = [HASH,HASH]
        if statuses:
            profile_runs = statuses.get("profile", profile_runs)
            signer_runs = statuses.get("signer", signer_runs)
            process_runs = statuses.get("process", process_runs)
        observed = []
        def run(args, timeout=30):
            observed.append(tuple(args))
            if "--check-profile-chain" in args:
                return profile_runs.pop(0)
            if "forge_f1_chrome_publisher.py" in " ".join(args):
                return signer_runs.pop(0)
            if "--check-process" in args:
                return process_runs.pop(0)
            raise AssertionError("Unexpected command: " + repr(args))
        def installed(path):
            return path == binary if selected == 1 else selected == 2
        with mock.patch.object(mod.sys,"platform","darwin"), \
             mock.patch.object(mod.os.path,"expanduser",return_value=home), \
             mock.patch.object(mod.os.path,"realpath",side_effect=lambda x:x), \
             mock.patch.object(mod.os.path,"exists",side_effect=installed), \
             mock.patch.object(mod,"command",side_effect=run):
            if expected_error:
                with self.assertRaises(mod.Blocked):
                    mod.probe_readonly_mac()
                return observed
            value=mod.probe_readonly_mac()
            self.assertEqual(value,HASH)
            return observed

    def test_owner_only_probe_checks_signature_process_twice_and_never_launches_chrome(self):
        argv=self.mac_probe()
        self.assertEqual(len(argv),6)
        self.assertTrue(all(x[0]=="/usr/bin/python3" and x[1]=="-I" for x in argv))
        self.assertEqual(sum("--check-process" in x for x in argv),2)
        self.assertFalse(any("--version" in x for x in argv))
        self.assertTrue(all("Google Chrome" not in x[0] for x in argv))

    def test_mac_preflight_refuses_absent_duplicate_or_changed_identity(self):
        cases=[
            {"selected":0},
            {"selected":2},
            {"statuses":{"profile":["PROFILE_CHAIN_UNSAFE"]}},
            {"statuses":{"profile":["PROFILE_CHAIN_PRIVATE_OWNER_VERIFIED",
                                    "PROFILE_CHAIN_UNSAFE"]}},
            {"statuses":{"signer":["BAD_SIGNATURE"]}},
            {"statuses":{"signer":["BKE_CHROME_GOOGLE_SIGNER_VERIFIED",
                                   "BAD_SIGNATURE"]}},
            {"statuses":{"process":["0"*64]}},
            {"statuses":{"process":[HASH,"fedcba0987654321"*4]}},
        ]
        for kwargs in cases:
            with self.subTest(kwargs=kwargs):
                self.mac_probe(expected_error=True, **kwargs)

    def test_noninteractive_root_or_not_mac_rejected_before_looking_at_git(self):
        cases=[
            dict(platform="linux", euid=501, tty=True),
            dict(platform="darwin", euid=0, tty=True),
            dict(platform="darwin", euid=501, tty=False),
        ]
        for v in cases:
            with self.subTest(v=v), \
                 mock.patch.object(mod.sys,"platform",v["platform"]), \
                 mock.patch.object(mod.os,"geteuid",return_value=v["euid"]), \
                 mock.patch.object(mod.sys,"stdin",TTY() if v["tty"] else io.StringIO()), \
                 mock.patch.object(mod.sys,"stdout",TTY() if v["tty"] else io.StringIO()), \
                 mock.patch.object(mod,"snapshot_source",side_effect=AssertionError("must not access repo")):
                self.assertEqual(mod.main([]),2)

    def test_owner_consent_and_reviewed_sha_are_both_required(self):
        for answer in [[HEAD,"NO"],["0"*40,mod.CONSENT]]:
            with mock.patch.object(mod.sys,"platform","darwin"), \
                 mock.patch.object(mod.os,"geteuid",return_value=501), \
                 mock.patch.object(mod.sys,"stdin",TTY()), \
                 mock.patch.object(mod.sys,"stdout",TTY()), \
                 mock.patch.object(mod,"snapshot_source",return_value=(HEAD,MAIN)), \
                 mock.patch.object(mod,"probe_readonly_mac",side_effect=AssertionError("probe before consent")), \
                 mock.patch("builtins.input",side_effect=answer):
                self.assertEqual(mod.main([]),2)

    def test_changed_remote_commit_after_probe_blocks_and_never_claims_ready(self):
        output = TTY()
        stderr = io.StringIO()
        with mock.patch.object(mod.sys,"platform","darwin"), \
             mock.patch.object(mod.os,"geteuid",return_value=501), \
             mock.patch.object(mod.sys,"stdin",TTY()), \
             mock.patch.object(mod.sys,"stdout",output), \
             mock.patch.object(mod.sys,"stderr",stderr), \
             mock.patch.object(mod,"snapshot_source",side_effect=[(HEAD,MAIN),("c"*40,MAIN)]), \
             mock.patch.object(mod,"probe_readonly_mac",return_value=HASH), \
             mock.patch("builtins.input",side_effect=[HEAD,mod.CONSENT]):
            self.assertEqual(mod.main([]),2)
        self.assertIn("REMOTE_OR_SOURCE_CHANGED_DURING_PROBE",stderr.getvalue())
        self.assertNotIn("READ_ONLY_PID_PROBE_PASS",output.getvalue())

    def test_positive_result_never_means_native_host_or_controller_admission(self):
        output=TTY()
        with mock.patch.object(mod.sys,"platform","darwin"), \
             mock.patch.object(mod.os,"geteuid",return_value=501), \
             mock.patch.object(mod.sys,"stdin",TTY()), \
             mock.patch.object(mod.sys,"stdout",output), \
             mock.patch.object(mod,"snapshot_source",return_value=(HEAD,MAIN)), \
             mock.patch.object(mod,"probe_readonly_mac",return_value=HASH), \
             mock.patch("builtins.input",side_effect=[HEAD,mod.CONSENT]):
            self.assertEqual(mod.main([]),0)
        text=output.getvalue()
        self.assertIn("READ_ONLY_PID_PROBE_PASS",text)
        self.assertIn("REAL_CHROME_READY=NOT_PROVEN",text)
        self.assertIn("NATIVE_HOST_HANDSHAKE=NOT_RUN",text)
        self.assertIn("CONTROLLER_AUTH=NOT_ESTABLISHED",text)
        self.assertIn("DISPATCH_AUTHORITY=NONE",text)

    def test_source_never_launches_browser_installs_host_or_writes_browser_profile(self):
        src = SOURCE.read_text()
        for forbidden in ["exec(binary", "subprocess.Popen(", "os.system(",
                          "permissions.request(", "persistOwnerPolicy(",
                          "chrome.runtime.sendMessage(", "shutil.copyfile("]:
            self.assertNotIn(forbidden,src)
        self.assertIn('PR_REF = "refs/pull/146/head"',src)
        self.assertNotIn("BKE_F1_REAL_CHROME_READY=PASS",src)


if __name__ == "__main__":
    main(verbosity=2)
