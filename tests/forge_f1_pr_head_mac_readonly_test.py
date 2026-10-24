#!/usr/bin/env python3
"""F1-03 PR-head READ-ONLY Mac diagnostic contract: deterministic Linux mocks."""
from __future__ import annotations
from contextlib import redirect_stdout, redirect_stderr
import importlib.util
import io
import subprocess
import tempfile
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
               remote_main=None, ancestry="", head=None, remote_lines=None,
                config_before="core.bare\nfalse\0", config_after=None):
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
        configs = iter([config_before, config_before if config_after is None else config_after])
        def fake_git(*args):
            if args == ("for-each-ref", "--format=%(refname)", "refs/replace"):
                return ""
            if args == ("rev-parse", "--git-path", "info/grafts"):
                return str(mod.ROOT / ".git" / "info" / "grafts")
            if args == ("config", "--list", "--includes", "--null"):
                return next(configs)
            if args not in responses:
                raise AssertionError("unexpected Git operation: " + repr(args))
            return responses[args]
        remote = remote_lines if remote_lines is not None else (
            pr + "\t" + mod.PR_REF + "\n" +
            remote_main + "\t" + mod.MAIN_REF
        )
        def fake_command(args, timeout=30, *, cwd=None):
            self.assertEqual(cwd, "/")
            self.assertEqual(args, ["/usr/bin/git", "ls-remote",
                                    mod.PUBLIC_REPO, mod.PR_REF, mod.MAIN_REF])
            return remote
        with mock.patch.object(mod, "git", side_effect=fake_git), \
             mock.patch.object(mod, "command", side_effect=fake_command), \
             mock.patch.object(mod, "verify_tracked_source"), \
             mock.patch.object(mod.os.path, "lexists", return_value=False):
            return mod.snapshot_source()

    def test_live_pr_ref_and_current_main_ancestry_are_both_required(self):
        self.assertEqual(self.source()[:2], (HEAD, MAIN))

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

    def test_live_source_refuses_local_git_configuration_drift(self):
        with self.assertRaisesRegex(mod.Blocked, "LOCAL_GIT_CONFIG_CHANGED"):
            self.source(config_before="core.bare\\nfalse\\0",
                        config_after="core.bare\\ntrue\\0")

    def test_real_local_instead_of_rewrite_blocks_before_remote_and_chrome(self):
        # An actual .git/config is used: git status never reports these edits.
        with tempfile.TemporaryDirectory() as directory:
            subprocess.run(["/usr/bin/git", "init", "-q", directory],
                           check=True, capture_output=True)
            subprocess.run(["/usr/bin/git", "-C", directory, "config", "--local",
                            "url.file:///tmp/fake-bke-refs.insteadOf",
                            mod.PUBLIC_REPO], check=True, capture_output=True)
            output, errors = TTY(), io.StringIO()
            real_command = mod.command
            with mock.patch.object(mod, "ROOT", Path(directory)), \
                 mock.patch.object(mod.sys, "platform", "darwin"), \
                 mock.patch.object(mod.os, "geteuid", return_value=501), \
                 mock.patch.object(mod.sys, "stdin", TTY()), \
                 mock.patch.object(mod.sys, "stdout", output), \
                 mock.patch.object(mod.sys, "stderr", errors), \
                 mock.patch.object(mod, "command", wraps=real_command) as commands, \
                 mock.patch.object(mod, "probe_readonly_mac",
                                   side_effect=AssertionError("Chrome was probed")):
                self.assertEqual(mod.main([]), 2)
            self.assertIn("LOCAL_URL_REWRITE_FORBIDDEN", errors.getvalue())
            self.assertNotIn("READ_ONLY_PID_PROBE_PASS", output.getvalue())
            self.assertFalse(any("ls-remote" in call.args[0]
                                 for call in commands.call_args_list))

    def _unrelated_real_git_fixture(self, directory):
        """Two unrelated real commits, a clean PR branch, a canonical origin."""
        def run(*args, input=None, allow_fail=False):
            p = subprocess.run(
                ["/usr/bin/git", "-C", directory, *args],
                input=input, text=True, capture_output=True, check=False
            )
            if not allow_fail:
                self.assertEqual(p.returncode, 0, (args, p.stdout, p.stderr))
            return p
        run("init", "-q")
        run("config", "user.email", "forge-regression@example.invalid")
        run("config", "user.name", "FORGE Regression")
        run("commit", "-qm", "unrelated main baseline", "--allow-empty")
        main_commit = run("rev-parse", "HEAD").stdout.strip()
        tree = run("rev-parse", "HEAD^{tree}").stdout.strip()
        head = run("commit-tree", tree, input="unrelated PR commit\n").stdout.strip()
        run("update-ref", "refs/heads/" + mod.BRANCH, head)
        run("symbolic-ref", "HEAD", "refs/heads/" + mod.BRANCH)
        run("remote", "add", "origin", mod.PUBLIC_REPO)
        self.assertNotEqual(head, main_commit)
        self.assertEqual(run("status", "--porcelain").stdout.strip(), "")
        self.assertNotEqual(
            run("merge-base", "--is-ancestor", main_commit, "HEAD",
                allow_fail=True).returncode, 0
        )
        return run, head, main_commit, tree

    def _assert_real_graph_override_blocks(self, directory, head, main_commit,
                                           expected_reason):
        """Run the actual owner entrypoint; no remote or Chrome probe permitted."""
        output, errors = TTY(), io.StringIO()
        network_reads = []
        original_command = mod.command

        def offline_command(argv, timeout=30, *, cwd=None):
            if "ls-remote" in argv:
                network_reads.append(argv)
                return head + "\t" + mod.PR_REF + "\n" + (
                    main_commit + "\t" + mod.MAIN_REF
                )
            return original_command(argv, timeout=timeout, cwd=cwd)

        with mock.patch.object(mod, "ROOT", Path(directory)), \
             mock.patch.object(mod.sys, "platform", "darwin"), \
             mock.patch.object(mod.os, "geteuid", return_value=501), \
             mock.patch.object(mod.sys, "stdin", TTY()), \
             mock.patch.object(mod.sys, "stdout", output), \
             mock.patch.object(mod.sys, "stderr", errors), \
             mock.patch.object(mod, "command", side_effect=offline_command), \
             mock.patch.object(mod, "verify_tracked_source"), \
             mock.patch.object(mod, "probe_readonly_mac",
                               side_effect=AssertionError("Chrome probed")) as probe, \
             mock.patch("builtins.input", side_effect=[head, mod.CONSENT]) as consent:
            self.assertEqual(mod.main([]), 2)
        self.assertIn(expected_reason, errors.getvalue())
        self.assertNotIn("READ_ONLY_PID_PROBE_PASS", output.getvalue())
        self.assertEqual(network_reads, [], "Graph override reached GitHub lookup")
        probe.assert_not_called()
        consent.assert_not_called()

    def test_real_replace_ref_fake_ancestry_blocks_before_mac_probe(self):
        with tempfile.TemporaryDirectory() as directory:
            run, head, main_commit, tree = self._unrelated_real_git_fixture(directory)
            descendant = run("commit-tree", tree, "-p", main_commit,
                             input="forged descendant\n").stdout.strip()
            run("replace", head, descendant)
            # Demonstrate actual vulnerable ancestry is falsely positive.
            self.assertEqual(run("merge-base", "--is-ancestor",
                                 main_commit, "HEAD").returncode, 0)
            self._assert_real_graph_override_blocks(
                directory, head, main_commit, "LOCAL_REPLACEMENT_REFS_FORBIDDEN"
            )
            # A packed replace ref is also observable (no loose-ref-only check).
            run("pack-refs", "--all", "--prune")
            self._assert_real_graph_override_blocks(
                directory, head, main_commit, "LOCAL_REPLACEMENT_REFS_FORBIDDEN"
            )

    def test_real_graft_fake_ancestry_blocks_before_mac_probe(self):
        with tempfile.TemporaryDirectory() as directory:
            run, head, main_commit, _ = self._unrelated_real_git_fixture(directory)
            git_path = Path(run("rev-parse", "--git-path", "info/grafts").stdout.strip())
            if not git_path.is_absolute():
                git_path = Path(directory) / git_path
            git_path.parent.mkdir(parents=True, exist_ok=True)
            git_path.write_text(head + " " + main_commit + "\n", encoding="ascii")
            # Grafts spoof ancestry even when replacement objects are disabled.
            cmd = ["/usr/bin/git", "-C", directory,
                   "merge-base", "--is-ancestor", main_commit, "HEAD"]
            self.assertEqual(subprocess.run(cmd, check=False,
                                            capture_output=True).returncode, 0)
            env = dict(os.environ, GIT_NO_REPLACE_OBJECTS="1")
            self.assertEqual(subprocess.run(cmd, env=env, check=False,
                                            capture_output=True).returncode, 0)
            self._assert_real_graph_override_blocks(
                directory, head, main_commit, "LOCAL_GRAFTS_FORBIDDEN"
            )

    def _trusted_source_repo(self, directory, extra_tracked=0):
        """Real Git index, three tracked Python runtime files, clean F1 PR."""
        def run(*args):
            p = subprocess.run(["/usr/bin/git", "-C", directory, *args],
                               check=False, capture_output=True, text=True)
            self.assertEqual(p.returncode, 0, (args, p.stderr))
            return p.stdout.strip()
        run("init", "-q")
        run("config", "user.email", "regression@example.invalid")
        run("config", "user.name", "FORGE Regression")
        for name in mod.RUNTIME_FILES:
            path = Path(directory) / name
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text("# canonical source\n", encoding="utf-8")
        for n in range(extra_tracked):
            filler = Path(directory) / "fixtures" / ("tracked-" + str(n).zfill(4) + "-" + "x" * 46 + ".txt")
            filler.parent.mkdir(parents=True, exist_ok=True)
            filler.write_text("ordinary tracked index record\n", encoding="utf-8")
        run("add", ".")
        run("commit", "-qm", "committed source")
        run("branch", "-m", mod.BRANCH)
        run("remote", "add", "origin", mod.PUBLIC_REPO)
        self.assertEqual(run("status", "--porcelain"), "")
        return run

    def _run_local_provenance_denial(self, directory, expected):
        """Drive real pre-consent source verification without contacting GitHub."""
        out, err = TTY(), io.StringIO()
        observed_network = []
        real_command = mod.command
        def safe_command(argv, timeout=30, *, cwd=None, max_output_chars=4096):
            if "ls-remote" in argv:
                observed_network.append(tuple(argv))
                raise AssertionError("network lookup before local source denial")
            return real_command(argv, timeout=timeout, cwd=cwd,
                                max_output_chars=max_output_chars)
        with mock.patch.object(mod, "ROOT", Path(directory)), \
             mock.patch.object(mod.sys, "platform", "darwin"), \
             mock.patch.object(mod.os, "geteuid", return_value=501), \
             mock.patch.object(mod.sys, "stdin", TTY()), \
             mock.patch.object(mod.sys, "stdout", out), \
             mock.patch.object(mod.sys, "stderr", err), \
             mock.patch.object(mod, "command", side_effect=safe_command), \
             mock.patch.object(mod, "probe_readonly_mac",
                               side_effect=AssertionError("unexpected Mac probe")) as probe, \
             mock.patch("builtins.input",
                        side_effect=AssertionError("unexpected consent")) as consent:
            self.assertEqual(mod.main([]), 2)
        self.assertIn(expected, err.getvalue())
        self.assertNotIn("READ_ONLY_PID_PROBE_PASS", out.getvalue())
        self.assertEqual(observed_network, [])
        probe.assert_not_called()
        consent.assert_not_called()

    def test_real_core_fsmonitor_marker_never_runs_before_consent(self):
        with tempfile.TemporaryDirectory() as directory:
            run = self._trusted_source_repo(directory)
            hook = Path(directory) / ".git" / "fsmonitor-marker.sh"
            marker = Path(directory) / ".git" / "fsmonitor-executed"
            hook.write_text("#!/bin/sh\nprintf triggered > " + str(marker) + "\n",
                            encoding="utf-8")
            hook.chmod(0o700)
            run("config", "core.fsmonitor", str(hook))
            # Positive control: an ordinary vulnerable status invokes this.
            plain = subprocess.run(
                ["/usr/bin/git", "-C", directory, "status", "--porcelain"],
                capture_output=True, text=True, check=False
            )
            self.assertEqual(plain.returncode, 0, plain.stderr)
            self.assertTrue(marker.exists(), "fsmonitor control did not execute")
            marker.unlink()
            self._run_local_provenance_denial(directory, "LOCAL_FSMONITOR_FORBIDDEN")
            self.assertFalse(marker.exists(), "diagnostic executed fsmonitor")

    def test_real_assume_unchanged_modified_source_fails_before_probe(self):
        with tempfile.TemporaryDirectory() as directory:
            run = self._trusted_source_repo(directory)
            target = mod.RUNTIME_FILES[0]
            run("update-index", "--assume-unchanged", target)
            (Path(directory) / target).write_text("# attacker modified source\n",
                                                    encoding="utf-8")
            self.assertEqual(run("status", "--porcelain"), "")
            self._run_local_provenance_denial(directory, "UNSAFE_TRACKED_INDEX_FLAGS")

    def test_real_skip_worktree_modified_source_fails_before_probe(self):
        with tempfile.TemporaryDirectory() as directory:
            run = self._trusted_source_repo(directory)
            target = mod.RUNTIME_FILES[1]
            run("update-index", "--skip-worktree", target)
            (Path(directory) / target).write_text("# attacker modified helper\n",
                                                    encoding="utf-8")
            self.assertEqual(run("status", "--porcelain"), "")
            self._run_local_provenance_denial(directory, "UNSAFE_TRACKED_INDEX_FLAGS")

    def test_real_plain_modified_runtime_blob_is_rejected_independently(self):
        with tempfile.TemporaryDirectory() as directory:
            self._trusted_source_repo(directory)
            target = mod.RUNTIME_FILES[2]
            (Path(directory) / target).write_text("# altered helper\n",
                                                    encoding="utf-8")
            self._run_local_provenance_denial(directory, "RUNTIME_SOURCE_HASH_MISMATCH")

    def test_real_large_clean_tracked_index_matches_head_without_truncation(self):
        """Reproduces 4-KiB output failure on clean checkout, then verifies all."""
        with tempfile.TemporaryDirectory() as directory:
            run = self._trusted_source_repo(directory, extra_tracked=180)
            index_command = ["/usr/bin/git", "-C", directory,
                             "ls-files", "-v", "-z"]
            raw = subprocess.run(index_command, capture_output=True, text=True,
                                 check=True).stdout
            self.assertGreater(len(raw), 4096, "Regression fixture is too small")
            self.assertLess(len(raw), mod.MAX_INDEX_OUTPUT_CHARS)
            with self.assertRaisesRegex(mod.Blocked, "COMMAND_FAILED"):
                mod.command(index_command)  # historical 4-KiB limit
            with mock.patch.object(mod, "ROOT", Path(directory)):
                mod.verify_tracked_source(run("rev-parse", "HEAD"))
            self.assertEqual(run("status", "--porcelain"), "")

    def test_index_output_cap_is_finite_and_other_git_calls_remain_4k(self):
        """Index exception must not silently remove bounds on other commands."""
        from types import SimpleNamespace
        argv = ["/usr/bin/git", "--version"]
        with mock.patch.object(mod.subprocess, "run") as proc:
            proc.return_value = SimpleNamespace(returncode=0, stdout="x" * 4097)
            with self.assertRaisesRegex(mod.Blocked, "COMMAND_FAILED"):
                mod.command(argv)
            proc.return_value = SimpleNamespace(
                returncode=0, stdout="x" * (mod.MAX_INDEX_OUTPUT_CHARS + 1))
            with self.assertRaisesRegex(mod.Blocked, "COMMAND_FAILED"):
                mod.command(argv, max_output_chars=mod.MAX_INDEX_OUTPUT_CHARS)
            with self.assertRaisesRegex(mod.Blocked, "OUTPUT_LIMIT_INVALID"):
                mod.command(argv, max_output_chars=mod.MAX_INDEX_OUTPUT_CHARS + 1)
            proc.assert_called()

    def test_source_verification_is_exactly_repeated_after_probing(self):
        source = SOURCE.read_text()
        self.assertIn("before = snapshot_source()", source)
        self.assertIn("after = snapshot_source()", source)
        self.assertIn("if after != before:", source)
        self.assertIn("GIT_OPTIONAL_LOCKS", source)
        self.assertIn('"GIT_CONFIG_KEY_0": "core.fsmonitor"', source)
        self.assertIn('"GIT_CONFIG_VALUE_0": "false"', source)
        self.assertIn('git("ls-files", "-v", "-z",', source)
        self.assertIn("max_output_chars=MAX_INDEX_OUTPUT_CHARS", source)
        self.assertIn('git("ls-tree", "-r", "-z", head, "--", *RUNTIME_FILES)', source)
        self.assertIn('"GIT_NO_REPLACE_OBJECTS": "1"', source)
        self.assertIn('git("for-each-ref", "--format=%(refname)", "refs/replace")', source)
        self.assertIn('git("rev-parse", "--git-path", "info/grafts")', source)
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

    def test_git_config_change_after_probe_blocks_without_remote_head_change(self):
        output, errors = TTY(), io.StringIO()
        with mock.patch.object(mod.sys, "platform", "darwin"), \
             mock.patch.object(mod.os, "geteuid", return_value=501), \
             mock.patch.object(mod.sys, "stdin", TTY()), \
             mock.patch.object(mod.sys, "stdout", output), \
             mock.patch.object(mod.sys, "stderr", errors), \
             mock.patch.object(mod, "snapshot_source",
                               side_effect=[(HEAD, MAIN, "config-before"),
                                            (HEAD, MAIN, "config-after")]), \
             mock.patch.object(mod, "probe_readonly_mac", return_value=HASH), \
             mock.patch("builtins.input", side_effect=[HEAD, mod.CONSENT]):
            self.assertEqual(mod.main([]), 2)
        self.assertIn("REMOTE_OR_SOURCE_CHANGED_DURING_PROBE", errors.getvalue())
        self.assertNotIn("READ_ONLY_PID_PROBE_PASS", output.getvalue())

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
