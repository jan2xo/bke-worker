#!/usr/bin/env python3
"""P2-5: prove the F1 process regression harness executes and fails on failure.

The process suite contains 20+ plain assert-based test_* functions, not
unittest.TestCase definitions. Running the file must execute all of them.
This test independently checks the production CI invocation in a subprocess.
No actual Chrome, native host, authenticated profile or macOS API is used.
"""
import os
from pathlib import Path
import re
import subprocess
import sys
import unittest

ROOT = Path(__file__).resolve().parents[1]
SUITE = ROOT / "tests" / "forge_f1_chrome_readiness_test.py"
SENTINEL = "BKE_F1_INTENTIONAL_FAILURE_SENTINEL"


def run_process_suite(*, intentional_failure: bool):
    env = os.environ.copy()
    env.pop("BKE_F1_TEST_INJECT_FAILURE", None)
    if intentional_failure:
        env["BKE_F1_TEST_INJECT_FAILURE"] = "1"
    return subprocess.run(
        [sys.executable, "-I", str(SUITE)],
        cwd=ROOT, capture_output=True, text=True,
        env=env, timeout=90, check=False,
    )


class ProcessHarnessContract(unittest.TestCase):
    def test_all_twenty_cases_run_with_named_darwin_cases(self):
        result = run_process_suite(intentional_failure=False)
        output = result.stdout + "\n" + result.stderr
        self.assertEqual(result.returncode, 0, output)
        self.assertRegex(output, r"Ran (20|[2-9][0-9]+) tests in ")
        self.assertRegex(result.stdout, r"regression tests: PASS executed=(20|[2-9][0-9]+)")
        self.assertIn(
            "test_darwin_same_pid_same_ps_second_but_different_unique_generation_changes_binding",
            output,
        )
        self.assertIn("test_darwin_running_image_different_from_disk_cdhash_refused", output)
        self.assertIn("test_darwin_forged_same_uid_chrome_argv_cannot_replace_kernel_executable", output)
        self.assertNotIn(SENTINEL, output)

    def test_injected_assertion_must_fail_ci_and_never_print_pass(self):
        result = run_process_suite(intentional_failure=True)
        output = result.stdout + "\n" + result.stderr
        self.assertNotEqual(result.returncode, 0, output)
        self.assertIn(SENTINEL, output)
        self.assertIn("FAILED", output)
        self.assertRegex(output, r"Ran (20|[2-9][0-9]+) tests in ")
        self.assertNotIn("regression tests: PASS", output)


if __name__ == "__main__":
    unittest.main(verbosity=2)
