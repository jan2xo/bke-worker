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


# P2-4: Linux CI simulates kernel process-generation ID and codesign CDHash.
# The real Darwin libproc/private-flavor and codesign PID are owner-Mac NOT_RUN.
def _darwin_fixture(pids, *, images=None, generations=None, signatures=True,
                    cdhashes=None, recheck=True):
    binary="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
    profile="/Users/operator/.bke-worker/f1/chrome-profile"
    rows="\n".join(
        f"{pid} {os.getuid()} {binary} --user-data-dir={profile}"
        for pid in pids
    )
    if images is None:
        images=[binary,binary]
    if generations is None:
        generations=[777,777,777]
    if cdhashes is None:
        cdhashes=["a"*40]*4
    from subprocess import CompletedProcess
    fake=lambda args,**kw: CompletedProcess(args,0,rows,"")
    with ExitStack() as st:
        st.enter_context(patch.object(module.subprocess,"run",side_effect=fake))
        image=st.enter_context(patch.object(module,"_darwin_pid_executable",side_effect=images))
        generation=st.enter_context(patch.object(module,"_darwin_pid_unique_generation",side_effect=generations))
        signature=st.enter_context(patch.object(module,"_darwin_pid_signature_valid",return_value=signatures))
        cdhash=st.enter_context(patch.object(module,"_darwin_signed_cdhash",side_effect=cdhashes))
        row=st.enter_context(patch.object(module,"_darwin_pid_row_unchanged",return_value=recheck))
        output=module.active_chrome_runtime_sha256("Darwin",binary,profile,"140.0.0.0")
    counts=(image.call_count,generation.call_count,signature.call_count,
            cdhash.call_count,row.call_count)
    return output,counts


def test_darwin_signed_process_unique_generation_and_codehash_pass():
    value,calls=_darwin_fixture([411])
    assert isinstance(value,str) and len(value)==64
    assert calls==(2,3,2,4,1)
    moved,_=_darwin_fixture([412])
    assert moved!=value


def test_darwin_same_pid_same_ps_second_but_different_unique_generation_changes_binding():
    # ps lstart is identical for both model runs. A reused PID is not.
    original,_=_darwin_fixture([411],generations=[1200,1200,1200])
    reused,_=_darwin_fixture([411],generations=[1201,1201,1201])
    assert original is not None and reused is not None and reused!=original
    within,_=_darwin_fixture([411],generations=[1200,1201])
    assert within is None  # Generation switch during signature check.


def test_darwin_running_image_different_from_disk_cdhash_refused():
    # Google-signed process may remain loaded while pathname was updated.
    # Distinct valid CodeDirectory identities must not be conflated.
    mismatch,calls=_darwin_fixture([411],cdhashes=["a"*40,"b"*40])
    assert mismatch is None and calls[2]==1 and calls[3]==2
    changed,calls2=_darwin_fixture([411],cdhashes=["a"*40,"a"*40,
                                                     "a"*40,"b"*40])
    assert changed is None and calls2[3]==4


def test_darwin_forged_same_uid_chrome_argv_cannot_replace_kernel_executable():
    value,calls=_darwin_fixture([411],images=["/tmp/evil"])
    assert value is None
    assert calls[2]==calls[3]==0


def test_darwin_two_matching_candidates_fail_before_trusting_any_one():
    value,calls=_darwin_fixture([411,412])
    assert value is None and calls==(0,0,0,0,0)


def test_darwin_wrong_process_signer_missing_unique_id_and_argv_change_block():
    binary="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
    for kwargs in (
        {"signatures":False},
        {"generations":[None]},
        {"generations":[0,0,0]},
        {"images":[binary,"/tmp/replaced-image"]},
        {"recheck":False},
        {"cdhashes":[None]},
    ):
        value,_=_darwin_fixture([411],**kwargs)
        assert value is None,kwargs


def test_darwin_dynamic_signature_pinned_to_pid_and_not_disk_path():
    from subprocess import CompletedProcess
    rule=module._DARWIN_GOOGLE_REQUIREMENT
    assert 'com.google.Chrome' in rule and 'EQHXZ8M8AV' in rule
    calls=[]
    def run(args,**kw):
        calls.append(args)
        return CompletedProcess(args,0,"","")
    with patch.object(module.subprocess,"run",side_effect=run):
        assert module._darwin_pid_signature_valid(411)
    assert calls==[["/usr/bin/codesign","--verify","--strict",
                    "-R","="+rule,"411"]]
    with patch.object(module.subprocess,"run",side_effect=lambda args,**kw:CompletedProcess(args,1,"","untrusted")):
        assert not module._darwin_pid_signature_valid(411)


def test_darwin_signed_code_directory_hash_pid_and_disk_parsing():
    from subprocess import CompletedProcess
    cmd=[]
    def run(args,**kw):
        cmd.append(args)
        return CompletedProcess(args,0,"","CDHash="+"A"*40+"\n")
    with patch.object(module.subprocess,"run",side_effect=run):
        assert module._darwin_signed_cdhash(411)=="a"*40
        assert module._darwin_signed_cdhash("/Applications/Google Chrome.app/Contents/MacOS/Google Chrome")=="a"*40
    assert cmd[0]==["/usr/bin/codesign","--display","--verbose=4","411"]
    assert cmd[1][-1].endswith("Google Chrome")
    def duplicate(args,**kw):
        return CompletedProcess(args,0,"","CDHash="+"a"*40+"\nCDHash="+"b"*40)
    with patch.object(module.subprocess,"run",side_effect=duplicate):
        assert module._darwin_signed_cdhash(411) is None
    with patch.object(module.subprocess,"run",side_effect=FileNotFoundError):
        assert module._darwin_signed_cdhash(411) is None


def test_darwin_process_uniqueid_kernel_flavor_and_access_denial():
    import ctypes
    assert ctypes.sizeof(module._DarwinUniqueProcessInfo)==56
    class FakeCallable:
        def __call__(self,pid,flavor,arg,out,size):
            assert pid==411 and flavor==17 and arg==0 and size==56
            info=ctypes.cast(out,ctypes.POINTER(module._DarwinUniqueProcessInfo)).contents
            info.process_unique_id=5001
            return size
    class FakeLibProc:
        proc_pidinfo=FakeCallable()
    with patch.object(module.ctypes,"CDLL",return_value=FakeLibProc()):
        assert module._darwin_pid_unique_generation(411)==5001
    with patch.object(module.ctypes,"CDLL",side_effect=OSError("API restricted")):
        assert module._darwin_pid_unique_generation(411) is None
    assert module._darwin_pid_unique_generation(0) is None


def test_darwin_os_kernel_pidpath_denial_has_no_argv_fallback():
    with patch.object(module.ctypes,"CDLL",side_effect=OSError("libproc unavailable")):
        assert module._darwin_pid_executable(411) is None
    assert module._darwin_pid_executable(0) is None


def test_owner_preflight_pins_interpreter_and_rechecks_unique_generation():
    owner=(root/"scripts/forge-f1-owner-policy.mjs").read_text()
    assert 'exec("/usr/bin/python3",["-I",python,"--check-profile-chain"' in owner
    assert 'exec("/usr/bin/python3",[\n  "-I",python,"--check-process"' in owner
    assert "fresh.digest!==verified.digest" in owner
    assert "last.digest!==verified.digest" in owner
    pub=(root/"scripts/forge_f1_chrome_publisher.py").read_text()
    assert module._DARWIN_GOOGLE_REQUIREMENT in pub
    checker=(root/"scripts/forge_f1_chrome_readiness.py").read_text()
    assert "_darwin_pid_start(pid)" not in checker
    assert "_hash_open_binary(image)" not in checker
    assert "_darwin_signed_cdhash(pid)" in checker


def _run_all_process_regression_tests():
    """Execute EVERY top-level test_ function, not merely import definitions."""
    import inspect
    import unittest

    if not __debug__:
        raise SystemExit("BKE_F1_PROCESS_TEST_ASSERTIONS_DISABLED")

    discovered = sorted((name, obj) for name, obj in globals().items()
                        if name.startswith("test_"))
    mandatory = {
        "test_darwin_same_pid_same_ps_second_but_different_unique_generation_changes_binding",
        "test_darwin_running_image_different_from_disk_cdhash_refused",
        "test_darwin_forged_same_uid_chrome_argv_cannot_replace_kernel_executable",
        "test_darwin_process_uniqueid_kernel_flavor_and_access_denial",
    }
    names = {name for name, _ in discovered}
    if (len(discovered) < 20 or not mandatory.issubset(names)
        or any(not inspect.isfunction(fn) or fn.__module__ != __name__
               for _, fn in discovered)):
        raise SystemExit("BKE_F1_PROCESS_TEST_DISCOVERY_INCOMPLETE")

    class ExecutableProcessRegressions(unittest.TestCase):
        pass

    for name, fn in discovered:
        def create_case(fn):
            def case(self):
                # Test-only negative sentinel: must fail BEFORE its real body.
                # The separate harness-contract subprocess verifies that the
                # intended test was invoked and its failure propagates to CI.
                if (os.environ.get("BKE_F1_TEST_INJECT_FAILURE") == "1"
                    and fn.__name__ ==
                    "test_darwin_same_pid_same_ps_second_but_different_unique_generation_changes_binding"):
                    raise AssertionError("BKE_F1_INTENTIONAL_FAILURE_SENTINEL")
                fn()
            return case
        setattr(ExecutableProcessRegressions, name, create_case(fn))

    suite = unittest.defaultTestLoader.loadTestsFromTestCase(ExecutableProcessRegressions)
    result = unittest.TextTestRunner(verbosity=2).run(suite)
    if result.testsRun != len(discovered) or not result.wasSuccessful():
        raise SystemExit(1)
    print("BKE F1 Chrome process/profile regression tests: PASS "
          f"executed={result.testsRun}")


if __name__ == "__main__":
    _run_all_process_regression_tests()

