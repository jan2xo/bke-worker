#!/usr/bin/env python3
"""Regression tests for the F1-01 process argv, profile privacy and extension-count gates."""
import importlib.util
import os
import subprocess
import sys
import tempfile
from contextlib import ExitStack
from unittest.mock import patch
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


# P2-3: Linux CI models the Darwin kernel and dynamic-signature observations.
# ps command text is deliberately untrusted; mocking is not a Mac acceptance.
def _darwin_fixture(lines, *, images=None, starts=None, signed=True, recheck=True):
    binary = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
    profile = "/Users/operator/.bke-worker/f1/chrome-profile"
    rows = "\n".join(
        f"{pid} {os.getuid()} {binary} --user-data-dir={profile}"
        for pid in lines
    )
    if images is None:
        images = [binary,binary]
    if starts is None:
        starts = ["Sat Oct 24 08:00:00 2026"]*2
    from subprocess import CompletedProcess
    fake = lambda args, **kw: CompletedProcess(args,0,rows,"")
    with ExitStack() as st:
        st.enter_context(patch.object(module.subprocess,"run",side_effect=fake))
        image = st.enter_context(patch.object(module,"_darwin_pid_executable",side_effect=images))
        start = st.enter_context(patch.object(module,"_darwin_pid_start",side_effect=starts))
        signer = st.enter_context(patch.object(module,"_darwin_pid_signature_valid",return_value=signed))
        row = st.enter_context(patch.object(module,"_darwin_pid_row_unchanged",return_value=recheck))
        binaryhash = st.enter_context(patch.object(module,"_hash_open_binary",return_value="f"*64))
        result = module.active_chrome_runtime_sha256("Darwin",binary,profile,"140.0.0.0")
    return result, (image.call_count,start.call_count,signer.call_count,
                     row.call_count,binaryhash.call_count)


def test_darwin_valid_os_pid_signature_and_start_yields_lifetime_bound_digest():
    value,calls = _darwin_fixture([411])
    assert isinstance(value,str) and len(value)==64
    assert calls == (2,2,1,1,1)
    second,calls2 = _darwin_fixture([412])
    assert value != second  # Process relaunch cannot preserve local commitment.
    assert calls2 == (2,2,1,1,1)


def test_darwin_forged_same_uid_chrome_argv_with_decoy_kernel_image_blocked():
    value,calls = _darwin_fixture([411],images=["/tmp/evil-process"])
    assert value is None
    # No disk hash or signer based on a mere argv[0] string.
    assert calls[2] == calls[4] == 0


def test_darwin_one_valid_plus_one_decoy_matching_profile_is_ambiguous():
    value,calls = _darwin_fixture([411,412])
    assert value is None and calls == (0,0,0,0,0)


def test_darwin_running_pid_must_pass_dynamic_google_signature():
    value,calls = _darwin_fixture([411],signed=False)
    assert value is None and calls[2] == 1 and calls[4] == 0


def test_darwin_pid_relaunch_image_change_and_argv_transition_fail_closed():
    binary = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
    for kw in (
        {"starts":["Sat Oct 24 08:00:00 2026","Sat Oct 24 08:00:01 2026"]},
        {"images":[binary,"/tmp/changed-after-signer"]},
        {"recheck":False},
        {"images":[None]},
        {"starts":[None]},
    ):
        value,_ = _darwin_fixture([411],**kw)
        assert value is None,kw


def test_darwin_dynamic_codesign_checks_pid_not_file_path():
    from subprocess import CompletedProcess
    original=module._DARWIN_GOOGLE_REQUIREMENT
    assert 'com.google.Chrome' in original and 'EQHXZ8M8AV' in original
    commands=[]
    def verify(args, **kw):
        commands.append(args)
        return CompletedProcess(args,0,"","")
    with patch.object(module.subprocess,"run",side_effect=verify):
        assert module._darwin_pid_signature_valid(411)
    assert commands == [[
        "/usr/bin/codesign","--verify","--strict",
        "-R","="+original,"411"
    ]]
    with patch.object(module.subprocess,"run",side_effect=lambda *x,**y: CompletedProcess(x,1,"","bad signer")):
        assert not module._darwin_pid_signature_valid(411)
    with patch.object(module.subprocess,"run",side_effect=FileNotFoundError):
        assert not module._darwin_pid_signature_valid(411)


def test_darwin_kernel_libproc_unavailable_fails_closed_without_fallback():
    with patch.object(module.ctypes,"CDLL",side_effect=OSError("libproc absent")):
        assert module._darwin_pid_executable(411) is None
    assert module._darwin_pid_executable(0) is None


def test_owner_preflight_pins_system_python_and_rechecks_running_pid_identity():
    from pathlib import Path
    owner=(root/"scripts/forge-f1-owner-policy.mjs").read_text()
    assert 'exec("/usr/bin/python3",["-I",python,"--check-profile-chain"' in owner
    assert 'exec("/usr/bin/python3",[\n  "-I",python,"--check-process"' in owner
    assert "fresh.digest!==verified.digest" in owner
    assert "last.digest!==verified.digest" in owner
    # This suite ensures duplicate requirement constants cannot silently drift.
    pub=(root/"scripts/forge_f1_chrome_publisher.py").read_text()
    assert module._DARWIN_GOOGLE_REQUIREMENT in pub

print("BKE F1 Chrome process/profile regression tests: PASS")
