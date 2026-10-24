#!/usr/bin/env python3
"""F1-03 Chrome signing gate: Linux-safe mocks; NO real browser is launched."""
from pathlib import Path
import importlib.util
import tempfile
import subprocess
import unittest
from unittest.mock import Mock
import sys

ROOT = Path(__file__).resolve().parents[1]
SOURCE = ROOT / "scripts/forge_f1_chrome_publisher.py"
spec = importlib.util.spec_from_file_location("bke_chrome_signer", SOURCE)
mod = importlib.util.module_from_spec(spec)
spec.loader.exec_module(mod)

class ChromePublisherTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(prefix="bke-google-signature-test-")
        self.addCleanup(self.tmp.cleanup)
        app = Path(self.tmp.name) / "Google Chrome.app"
        (app / "Contents" / "MacOS").mkdir(parents=True)
        self.exe = app / "Contents" / "MacOS" / "Google Chrome"
        self.exe.write_bytes(b"FAKE TEST BINARY NEVER EXECUTED")
        self.args = []
        self.team = mod.TEAM_ID
        self.identifier = mod.IDENTIFIER
    def runner(self, args, **kwargs):
        self.args.append(args)
        self.assertEqual(args[0], "/usr/bin/codesign")
        self.assertEqual(kwargs, dict(check=False, capture_output=True,
                                     text=True, timeout=30))
        if "--display" in args:
            detail = ("Executable=" + str(self.exe) + "\nIdentifier=" +
                      self.identifier + "\nTeamIdentifier=" + self.team + "\n")
            return subprocess.CompletedProcess(args, 0, "", detail)
        self.assertIn("--verify", args)
        self.assertIn("--strict", args)
        self.assertIn("-R", args)
        rule = args[args.index("-R") + 1]
        self.assertEqual(rule, "=" + mod.REQUIREMENT)
        self.assertIn('anchor apple generic', rule)
        self.assertIn('certificate leaf[subject.OU] = "EQHXZ8M8AV"', rule)
        self.assertIn('identifier "com.google.Chrome"', rule)
        return subprocess.CompletedProcess(args, 0, "", "valid on disk\n")
    def test_pinned_codesign_requirement_for_bundle_and_executable(self):
        self.assertTrue(mod.verify_google_chrome_publisher(str(self.exe),
                                                           runner=self.runner))
        self.assertEqual(len(self.args), 3)
        self.assertEqual(self.args[0][-1], str(self.exe.parents[2]))
        self.assertEqual(self.args[1][-1], str(self.exe))
        self.assertIn("--deep", self.args[0])
        self.assertNotIn("--deep", self.args[1])
    def test_unsigned_rejected(self):
        def unsigned(args, **kwargs):
            return subprocess.CompletedProcess(args, 1, "", "code object not signed")
        with self.assertRaises(mod.SignerBlocked):
            mod.verify_google_chrome_publisher(str(self.exe), runner=unsigned)
    def test_wrong_publisher_signature_requirement_rejected(self):
        def wrong_signer(args, **kwargs):
            if "--verify" in args:
                return subprocess.CompletedProcess(
                    args, 1, "", "code failed to satisfy specified requirement")
            return self.runner(args, **kwargs)
        with self.assertRaises(mod.SignerBlocked):
            mod.verify_google_chrome_publisher(str(self.exe), runner=wrong_signer)
    def test_false_successful_signature_metadata_rejected(self):
        self.team = "EXAMPLEBAD"
        with self.assertRaises(mod.SignerBlocked):
            mod.verify_google_chrome_publisher(str(self.exe), runner=self.runner)
        self.team = mod.TEAM_ID
        self.identifier = "com.attacker.Chrome"
        with self.assertRaises(mod.SignerBlocked):
            mod.verify_google_chrome_publisher(str(self.exe), runner=self.runner)
    def test_tampered_bundle_signature_rejected(self):
        def tampered(args, **kwargs):
            if "--deep" in args:
                return subprocess.CompletedProcess(args, 1, "", "a sealed resource is missing")
            return self.runner(args, **kwargs)
        with self.assertRaises(mod.SignerBlocked):
            mod.verify_google_chrome_publisher(str(self.exe), runner=tampered)
    def test_executable_that_does_not_match_bundle_rejected(self):
        def wrong_exe(args, **kwargs):
            if "--display" in args:
                detail = ("Executable=/tmp/decoy\nIdentifier=com.google.Chrome\n"
                          "TeamIdentifier=EQHXZ8M8AV\n")
                return subprocess.CompletedProcess(args, 0, "", detail)
            return self.runner(args, **kwargs)
        with self.assertRaises(mod.SignerBlocked):
            mod.verify_google_chrome_publisher(str(self.exe), runner=wrong_exe)
    def test_symlink_and_noncanonical_executable_fail_before_codesign(self):
        link = self.exe.parent / "other"
        link.symlink_to(self.exe)
        cases = [str(link),str(self.exe) + "/../Google Chrome", "Google Chrome",
                 str(Path(self.tmp.name) / "Other Chrome.app" / "Contents" /
                     "MacOS" / "Google Chrome")]
        self.exe.unlink()
        self.exe.symlink_to(Path(self.tmp.name)/"victim")
        cases.append(str(self.exe))
        for path in cases:
            with self.subTest(path=path):
                with self.assertRaises(mod.SignerBlocked):
                    mod.verify_google_chrome_publisher(path, runner=self.runner)
        self.assertEqual(self.args, [])
    def test_fail_closed_when_codesign_unavailable_or_timeout(self):
        for exception in [FileNotFoundError("missing"), subprocess.TimeoutExpired("codesign",30)]:
            def bad(args, **kwargs):
                raise exception
            with self.assertRaises(mod.SignerBlocked):
                mod.verify_google_chrome_publisher(str(self.exe), runner=bad)
    def test_owner_script_signs_before_running_browser_version(self):
        source=(ROOT/"scripts/forge-f1-owner-policy.mjs").read_text()
        self.assertIn("forge_f1_chrome_publisher.py",source)
        self.assertIn("BKE_CHROME_GOOGLE_SIGNER_VERIFIED",source)
        self.assertLess(source.index("forge_f1_chrome_publisher.py"),
                        source.index('exec(binary,["--version"])'))
        self.assertIn('GOOGLE_CHROME_PUBLISHER_UNVERIFIED',source)
    def test_linux_cli_never_claims_mac_publisher_pass(self):
        if sys.platform == "darwin":
            self.skipTest("The CLI gate intentionally requires a Mac; use real owner certificate there")
        self.assertEqual(mod.main([str(self.exe)]),2)

if __name__ == "__main__":
    unittest.main()
