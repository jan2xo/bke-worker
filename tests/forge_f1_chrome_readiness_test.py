#!/usr/bin/env python3
"""Regression tests for the F1-01 process argv, profile privacy and extension-count gates."""
import importlib.util
import os
import subprocess
import sys
import tempfile
from pathlib import Path

root = Path(__file__).resolve().parents[1]
module_path = root / "scripts/forge_f1_chrome_readiness.py"
spec = importlib.util.spec_from_file_location("forge_f1_chrome_readiness", module_path)
assert spec and spec.loader
module = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = module
spec.loader.exec_module(module)

extract = module.extract_user_data_dir
ps_matches = module.ps_line_matches_profile
linux_matches = module.linux_argv_matches_profile
linux_binary = module.linux_chrome_binary_for_launcher
chain_safe = module.private_profile_chain_is_safe
count_is_one = module.extension_match_count_is_one

def test_user_data_dir_argument_variants_and_trailing_flags():
    profile = "/Users/A User/.bke-worker/f1/chrome-profile"
    assert extract([
        "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
        "--user-data-dir=" + profile, "--profile-directory=Default",
        "--new-window", "https://chatgpt.com/",
    ]) == profile
    assert extract([
        "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
        "--user-data-dir", profile, "--profile-directory=Default",
        "--new-window", "https://chatgpt.com/",
    ]) == profile

def test_user_data_dir_rejects_wrong_near_prefix_missing_and_duplicate_flags():
    profile = "/home/operator/.bke-worker/f1/chrome-profile"
    assert extract(["chrome", "--user-data-dir=/home/operator/.bke-worker/f1/chrome-profile-extra"]) != profile
    assert extract(["chrome", "--user-data-directory=" + profile]) is None
    assert extract(["chrome", "--new-window", "https://chatgpt.com/"]) is None
    assert extract(["chrome", "--user-data-dir"]) is None
    assert extract(["chrome", "--user-data-dir="]) is None
    assert extract(["chrome", "--user-data-dir=/one", "--user-data-dir=/two"]) is None
    assert extract(["chrome", "--user-data-dir=/one", "--user-data-dir", "/one"]) is None

def test_macos_ps_parser_accepts_quoted_and_exact_unquoted_executable_with_spaces():
    executable = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
    profile = "/Users/A Person/.bke-worker/f1/chrome-profile"
    quoted = (
        '"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" '
        '--user-data-dir="/Users/A Person/.bke-worker/f1/chrome-profile" '
        '--profile-directory=Default --new-window https://chatgpt.com/'
    )
    assert ps_matches(quoted, executable, profile)
    unquoted_exe = (
        executable + ' --user-data-dir="/Users/A Person/.bke-worker/f1/chrome-profile" '
        '--profile-directory=Default --new-window https://chatgpt.com/'
    )
    assert ps_matches(unquoted_exe, executable, profile)

def test_macos_ps_parser_rejects_prefix_mismatch_wrong_profile_duplicates_and_bad_quotes():
    executable = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
    profile = "/Users/test/.bke-worker/f1/chrome-profile"
    assert not ps_matches(executable + "Helper --user-data-dir=" + profile, executable, profile)
    assert not ps_matches(executable + " --user-data-dir=" + profile + "-near", executable, profile)
    assert not ps_matches(executable + " --user-data-directory=" + profile, executable, profile)
    assert not ps_matches(executable + " --user-data-dir=" + profile + " --user-data-dir=/elsewhere", executable, profile)
    assert not ps_matches('"' + executable + ' --user-data-dir=' + profile, executable, profile)

def test_linux_actual_chrome_binary_can_differ_from_launcher_wrapper_but_identity_is_pinned():
    # Use a private temporary tree and an executable named exactly as the installed Chrome binary.
    with tempfile.TemporaryDirectory(prefix="bke-f1-process-") as td:
        base = Path(td)
        actual = base / "chrome"
        actual.write_text("#!/bin/sh\nexit 0\n", encoding="utf-8")
        actual.chmod(0o700)
        launcher = "/usr/bin/google-chrome-stable"
        profile = "/home/operator/.bke-worker/f1/chrome-profile"
        argv = [
            launcher, "--user-data-dir=" + profile, "--profile-directory=Default",
            "--new-window", "https://chatgpt.com/",
        ]
        assert linux_matches(argv, str(actual), launcher, profile,
                             "130.0.0.0", "Google Chrome 130.0.0.0")
        assert not linux_matches(argv, str(actual), launcher, profile,
                                 "130.0.0.0", "Chromium 130.0.0.0")
        assert not linux_matches(argv, str(actual), launcher, profile + "-near",
                                 "130.0.0.0", "Google Chrome 130.0.0.0")
        assert not linux_matches(argv + ["--user-data-dir=/elsewhere"], str(actual), launcher, profile,
                                 "130.0.0.0", "Google Chrome 130.0.0.0")
        assert not linux_matches(argv, str(base / "chromium"), launcher, profile,
                                 "130.0.0.0", "Google Chrome 130.0.0.0")
        assert not linux_matches(["/tmp/unrelated-wrapper", *argv[1:]], str(actual), launcher, profile,
                                 "130.0.0.0", "Google Chrome 130.0.0.0")

def test_linux_wrapper_maps_only_supported_official_google_chrome_installations():
    assert linux_binary("/opt/google/chrome/google-chrome") == "/opt/google/chrome/chrome"
    assert linux_binary("/opt/google/chrome-beta/google-chrome") == "/opt/google/chrome-beta/chrome"
    assert linux_binary("/opt/google/chrome-unstable/google-chrome") == "/opt/google/chrome-unstable/chrome"
    assert linux_binary("/opt/google/chrome/chrome") == "/opt/google/chrome/chrome"
    assert linux_binary("/tmp/fake-google-chrome-wrapper") is None
    assert linux_binary("/usr/bin/chromium") is None

def test_existing_profile_chain_requires_private_owned_ancestors_and_leaf():
    with tempfile.TemporaryDirectory(prefix="bke-f1-profile-") as td:
        home = str(Path(td).resolve())
        worker = Path(home) / ".bke-worker"
        f1 = worker / "f1"
        profile = f1 / "chrome-profile"
        worker.mkdir(mode=0o700); f1.mkdir(mode=0o700); profile.mkdir(mode=0o700)
        for p in (worker, f1, profile):
            p.chmod(0o700)
        assert chain_safe(home, str(profile), os.getuid())
        cli = subprocess.run([sys.executable, str(module_path), "--check-profile-chain", home, str(profile)],
                             text=True, capture_output=True, check=False)
        assert cli.returncode == 0 and "PROFILE_CHAIN_PRIVATE_OWNER_VERIFIED" in cli.stdout
        worker.chmod(0o755)
        assert not chain_safe(home, str(profile), os.getuid())
        cli = subprocess.run([sys.executable, str(module_path), "--check-profile-chain", home, str(profile)],
                             text=True, capture_output=True, check=False)
        assert cli.returncode != 0 and "PROFILE_CHAIN_UNSAFE" in cli.stderr
        worker.chmod(0o700)
        f1.chmod(0o750)
        assert not chain_safe(home, str(profile), os.getuid())
        f1.chmod(0o700)
        profile.chmod(0o755)
        assert not chain_safe(home, str(profile), os.getuid())

def test_existing_profile_chain_rejects_symlinked_ancestor():
    with tempfile.TemporaryDirectory(prefix="bke-f1-symlink-") as td:
        home = str(Path(td).resolve())
        real_worker = Path(home) / "private-worker"
        real_worker.mkdir(mode=0o700); real_worker.chmod(0o700)
        link = Path(home) / ".bke-worker"
        link.symlink_to(real_worker, target_is_directory=True)
        f1 = link / "f1"; profile = f1 / "chrome-profile"
        f1.mkdir(mode=0o700); profile.mkdir(mode=0o700)
        assert not chain_safe(home, str(profile), os.getuid())

def test_extension_match_count_requires_exactly_one():
    assert count_is_one("1")
    for invalid in ("0", "2", "10", "", "one", "-1", "1.0", " 1", "1 "):
        assert not count_is_one(invalid), repr(invalid)
    helper = str(module_path)
    ok = subprocess.run([sys.executable, helper, "--validate-extension-count", "1"],
                        text=True, capture_output=True, check=False)
    assert ok.returncode == 0 and ok.stdout.strip() == "1"
    for value in ("0", "2"):
        blocked = subprocess.run([sys.executable, helper, "--validate-extension-count", value],
                                 text=True, capture_output=True, check=False)
        assert blocked.returncode != 0
        assert "EXTENSION_MISSING_OR_DUPLICATE" in blocked.stderr

# Source-only macOS fixtures exercise the real readiness receiver. A successful
# signed-PID check remains owner-attested profile evidence, not remote trust.
from contextlib import redirect_stdout
from io import StringIO
from unittest.mock import patch


def _mac_fixture(*, candidates=None, image=None, signed=True,
                 live="a" * 40, disk="a" * 40, digest="b" * 64,
                 after=None):
    executable = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
    profile = "/Users/operator/.bke-worker/f1/chrome-profile"
    if candidates is None:
        candidates = [411]
    if image is None:
        image = executable
    if after is None:
        after = candidates
    observed = [candidates, after]
    def pids(*_):
        return observed.pop(0)
    def codesign(target, *, verify):
        if verify:
            return "VERIFIED" if signed else None
        return disk if isinstance(target, str) else live
    with patch.object(module, "private_profile_chain_is_safe", return_value=True), \
         patch.object(module, "_darwin_matching_pids", side_effect=pids), \
         patch.object(module, "_darwin_pid_executable", return_value=image), \
         patch.object(module, "_darwin_codesign", side_effect=codesign), \
         patch.object(module, "_hash_open_binary", return_value=digest):
        result = module.active_chrome_runtime_sha256("Darwin", executable, profile, "130.0.0.0")
    return result


def test_darwin_signed_process_passes_readiness_receiver_without_profile_authority():
    assert _mac_fixture() == "b" * 64
    # The existing receiving CLI calls active_chrome_runtime_sha256; no
    # policy, GitHub claim or controller session is issued.
    with patch.object(module, "_darwin_process_probe", return_value="b" * 64):
        out = StringIO()
        with redirect_stdout(out):
            assert module._main(["--check-process", "Darwin", "/signed/chrome",
                                 "/private/profile", "130.0.0.0"]) == 0
        assert out.getvalue().strip() == "b" * 64


def test_darwin_multiple_candidates_replacement_and_wrong_process_fail_closed():
    assert _mac_fixture(candidates=[411, 412]) is None
    assert _mac_fixture(after=[412]) is None
    assert _mac_fixture(image="/tmp/forged") is None
    assert _mac_fixture(signed=False) is None
    assert _mac_fixture(live="a" * 40, disk="c" * 40) is None
    assert _mac_fixture(live="") is None
    assert _mac_fixture(digest=None) is None


def test_darwin_disconnected_process_and_unsafe_profile_do_not_fallback():
    executable = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
    profile = "/Users/operator/.bke-worker/f1/chrome-profile"
    with patch.object(module, "private_profile_chain_is_safe", return_value=False), \
         patch.object(module, "_darwin_matching_pids") as pids:
        assert module._darwin_process_probe(executable, profile) is None
        pids.assert_not_called()
    with patch.object(module, "private_profile_chain_is_safe", return_value=True), \
         patch.object(module, "_darwin_matching_pids", return_value=None):
        assert module._darwin_process_probe(executable, profile) is None
    with patch.object(module, "_darwin_process_probe", return_value=None):
        assert module._main(["--check-process", "Darwin", executable,
                             profile, "130.0.0.0"]) == 1


def test_darwin_ps_candidates_are_unique_and_exact():
    from subprocess import CompletedProcess
    executable = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
    profile = "/Users/operator/.bke-worker/f1/chrome-profile"
    command = executable + ' --user-data-dir="' + profile + '" --profile-directory=Default'
    uid = os.getuid()
    result = CompletedProcess([], 0,
        f"411 {uid} {command}\n412 {uid} {command}\n"
        f"413 {uid} {executable} --user-data-dir=/tmp/other\n", "")
    with patch.object(module.subprocess, "run", return_value=result) as run:
        assert module._darwin_matching_pids(executable, profile) == [411, 412]
        assert run.call_args.args[0] == ["/bin/ps", "-axo", "pid=,uid=,command="]
    result.returncode = 1
    with patch.object(module.subprocess, "run", return_value=result):
        assert module._darwin_matching_pids(executable, profile) is None


def test_darwin_codesign_pins_google_team_and_running_pid_not_only_disk_path():
    from subprocess import CompletedProcess
    recorded = []
    def call(args, **_):
        recorded.append(args)
        if "--verify" in args:
            return CompletedProcess(args, 0, "", "")
        return CompletedProcess(args, 0, "", "CDHash=" + "a" * 40 + "\n")
    with patch.object(module.subprocess, "run", side_effect=call):
        assert module._darwin_codesign(411, verify=True) == "VERIFIED"
        assert module._darwin_codesign(411, verify=False) == "a" * 40
    assert recorded[0][0] == "/usr/bin/codesign"
    assert recorded[0][-1] == "411"
    assert 'identifier "com.google.Chrome"' in recorded[0][-2]
    assert "EQHXZ8M8AV" in recorded[0][-2]
    with patch.object(module.subprocess, "run", return_value=CompletedProcess([], 1, "", "")):
        assert module._darwin_codesign(411, verify=True) is None
    with patch.object(module.subprocess, "run", side_effect=OSError):
        assert module._darwin_codesign(411, verify=False) is None


if __name__ == "__main__":
    # The PR Guard runs this file as a script, not via unittest discovery.
    # Actually call every regression test; never print unconditional PASS.
    for name, fn in sorted(globals().copy().items()):
        if name.startswith("test_") and callable(fn):
            fn()
    print("BKE F1 Chrome process/profile regression tests: PASS")
