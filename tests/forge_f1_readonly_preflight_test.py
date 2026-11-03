#!/usr/bin/env python3
"""Source-only adversarial checks for F1-01's read-only operator entrypoint.

All external Git/Node/OS/browser signals are simulated in private fixtures.
No real Chrome, user profile, native host, credential helper or GitHub login runs.
"""
import os
from pathlib import Path
import shutil
import subprocess
import tempfile

SOURCE = Path(__file__).resolve().parents[1] / "scripts/forge-f1-desktop-readiness.sh"
SHA = "a" * 40


def stub(directory, name, code):
    target = directory / name
    target.write_text("#!/bin/sh\n" + code, encoding="utf-8")
    target.chmod(0o700)


with tempfile.TemporaryDirectory(prefix="bke-f1-readonly-fixture-") as temporary:
    base = Path(temporary)
    root = base / "repo"
    script = root / "scripts/forge-f1-desktop-readiness.sh"
    script.parent.mkdir(parents=True)
    shutil.copyfile(SOURCE, script)
    bin_dir = base / "bin"
    bin_dir.mkdir()
    home = base / "home"
    home.mkdir()
    calls = base / "calls"
    chrome = home / "Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
    chrome.parent.mkdir(parents=True)
    chrome.write_text("#!/bin/sh\necho CHROME_INVOKED >> \"$BKE_TEST_CALLS\"\nexit 98\n")
    chrome.chmod(0o700)
    policy = home / ".config/bke-worker/native-host/owner-policy.json"
    policy.parent.mkdir(parents=True)
    policy.write_text("PRIVATE_POLICY_CONTENT_NOT_FOR_OUTPUT", encoding="utf-8")

    stub(bin_dir, "git", r'''
echo "git:$*" >> "$BKE_TEST_CALLS"
case " $* " in
  *" rev-parse --show-toplevel "*) printf '%s\n' "$BKE_TEST_ROOT" ;;
  *" remote get-url origin "*) printf '%s\n' "$BKE_TEST_ORIGIN" ;;
  *" branch --show-current "*) printf '%s\n' "$BKE_TEST_BRANCH" ;;
  *" status --porcelain --untracked-files=all "*) printf '%s' "$BKE_TEST_DIRTY" ;;
  *" rev-parse --verify HEAD "*) printf '%s\n' "$BKE_TEST_HEAD" ;;
  *" ls-remote https://github.com/jan2xo/bke-worker.git refs/heads/main "*)
    [ "$BKE_TEST_REMOTE_FAIL" != "1" ] || exit 2
    printf '%s\trefs/heads/main\n' "$BKE_TEST_REMOTE" ;;
  *) exit 91 ;;
esac
''')
    stub(bin_dir, "node", r'''
echo "node:$*" >> "$BKE_TEST_CALLS"
[ "$1" = "--version" ] || exit 98
printf '%s\n' "$BKE_TEST_NODE"
''')
    stub(bin_dir, "uname", r'''
echo "uname:$*" >> "$BKE_TEST_CALLS"
[ "$1" = "-s" ] || exit 98
printf '%s\n' "$BKE_TEST_OS"
''')
    stub(bin_dir, "id", r'''
echo "id:$*" >> "$BKE_TEST_CALLS"
[ "$1" = "-u" ] || exit 98
echo 501
''')
    for forbidden in ("npm", "python3"):
        stub(bin_dir, forbidden, 'echo FORBIDDEN_TOOL_INVOKED >> "$BKE_TEST_CALLS"\nexit 98\n')

    defaults = {
        "HOME": str(home), "PATH": f"{bin_dir}:/usr/bin:/bin",
        "BKE_TEST_ROOT": str(root), "BKE_TEST_CALLS": str(calls),
        "BKE_TEST_ORIGIN": "https://github.com/jan2xo/bke-worker.git",
        "BKE_TEST_BRANCH": "main", "BKE_TEST_DIRTY": "",
        "BKE_TEST_HEAD": SHA, "BKE_TEST_REMOTE": SHA,
        "BKE_TEST_REMOTE_FAIL": "0", "BKE_TEST_NODE": "v22.3.0",
        "BKE_TEST_OS": "Darwin",
        # Must not cause preflight to inspect arbitrary locations or profile files.
        "BKE_NATIVE_HOST_POLICY_PATH": str(home / ".bke-worker/f1/chrome-profile/Preferences"),
    }

    def verify(expected, **overrides):
        calls.write_text("", encoding="utf-8")
        env = os.environ.copy()
        env.update(defaults)
        env.update(overrides)
        result = subprocess.run(
            ["/bin/bash", str(script), "--preflight-readonly"],
            env=env, text=True, capture_output=True, timeout=10,
        )
        output = result.stdout + result.stderr
        trace = calls.read_text(encoding="utf-8")
        if expected == "READ_ONLY_PASS":
            assert result.returncode == 0, (result.returncode, output)
            assert "BKE_F1_PREFLIGHT=READ_ONLY_PASS" in output
            assert f"BKE_F1_HEAD_SHA={SHA}" in output
            assert "BKE_F1_OWNER_POLICY=EXISTS_UNVERIFIED" in output
            assert "BKE_F1_CHROME_APP_PATH=FOUND_UNVERIFIED" in output
        else:
            assert result.returncode == 2, (expected, result.returncode, output)
            assert f"reason={expected}" in output, (expected, output)
        assert "BKE_F1_SOURCE_SMOKE=NOT_RUN" in output
        assert "BKE_F1_REAL_CHROME=NOT_TESTED" in output
        assert "BKE_F1_NATIVE_HANDSHAKE=NOT_RUN" in output
        assert "PRIVATE_POLICY_CONTENT_NOT_FOR_OUTPUT" not in output
        assert str(home) not in output and str(root) not in output
        assert "FORBIDDEN_TOOL_INVOKED" not in trace
        assert "CHROME_INVOKED" not in trace
        assert "git:" in trace
        assert "fetch " not in trace and " clone " not in trace
        assert " push " not in trace and " checkout " not in trace
        return trace

    trace = verify("READ_ONLY_PASS")
    assert " -C / ls-remote https://github.com/jan2xo/bke-worker.git " in trace
    assert "core.fsmonitor=false" in trace, "local Git fsmonitor must stay disabled"
    assert "-c credential.helper=" in trace, "anonymous remote must disable helpers"
    verify("CHECKOUT_NOT_MAIN", BKE_TEST_BRANCH="feature")
    verify("CHECKOUT_DIRTY", BKE_TEST_DIRTY=" M important-file")
    trace = verify("ORIGIN_REPOSITORY_UNTRUSTED", BKE_TEST_ORIGIN="https://example.com/fake.git")
    assert "ls-remote" not in trace
    verify("NODE_22_OR_NEWER_REQUIRED", BKE_TEST_NODE="v20.0.0")
    verify("MACOS_REQUIRED", BKE_TEST_OS="Linux")
    verify("STALE_CHECKOUT", BKE_TEST_REMOTE="b" * 40)
    verify("REMOTE_MAIN_QUERY_FAILED", BKE_TEST_REMOTE_FAIL="1")
    verify("REMOTE_MAIN_SHA_INVALID", BKE_TEST_REMOTE="not-a-sha")
    verify("HEAD_SHA_INVALID", BKE_TEST_HEAD="not-a-sha")

    chrome.unlink()
    verify("GOOGLE_CHROME_APP_PATH_NOT_FOUND")
    chrome.write_text("#!/bin/sh\necho CHROME_INVOKED >> \"$BKE_TEST_CALLS\"\n")
    chrome.chmod(0o700)
    policy.unlink()
    verify("OWNER_POLICY_FILE_MISSING")
    policy.symlink_to(base / "elsewhere-policy")
    verify("OWNER_POLICY_PATH_SYMLINK")
    policy.unlink()
    policy.write_text("PRIVATE_POLICY_CONTENT_NOT_FOR_OUTPUT")

    calls.write_text("", encoding="utf-8")
    result = subprocess.run(
        ["/bin/bash", str(script), "--preflight-readonly", "--unexpected"],
        env={**os.environ, **defaults}, text=True, capture_output=True, timeout=10,
    )
    assert result.returncode == 2 and "UNKNOWN_ARGUMENT" in result.stderr
    assert calls.read_text(encoding="utf-8") == "", "extra arguments reached discovery"

print("BKE F1 read-only Mac preflight: 13 adversarial fixture cases PASS")
