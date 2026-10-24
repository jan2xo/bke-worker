#!/usr/bin/env python3
"""Fail-closed, read-only checks for the F1-01 Chrome process/profile boundary."""
from __future__ import annotations

import hashlib
import ctypes
import os
import re
import shlex
import stat
import subprocess
import sys
from pathlib import Path
from typing import Iterable, Optional

_VERSION = re.compile(r"^Google Chrome\s+([0-9]+(?:\.[0-9]+){3})(?:\s|$)")
_SHA256 = re.compile(r"^[0-9a-f]{64}$")
_EXTENSION_COUNT = re.compile(r"^[0-9]+$")


def extract_user_data_dir(argv: Iterable[str]) -> Optional[str]:
    """Read exactly one Chrome user-data-dir switch from an already-tokenized argv."""
    if isinstance(argv, (str, bytes)):
        return None
    args = list(argv)
    if not all(isinstance(arg, str) for arg in args):
        return None
    values: list[str] = []
    i = 0
    while i < len(args):
        token = args[i]
        if token == "--user-data-dir":
            if i + 1 >= len(args):
                return None
            value = args[i + 1]
            if not value or value.startswith("--"):
                return None
            values.append(value)
            i += 2
            continue
        if token.startswith("--user-data-dir="):
            value = token[len("--user-data-dir="):]
            if not value:
                return None
            values.append(value)
        i += 1
    # A duplicate option is ambiguous even if the values appear equal.
    if len(values) != 1:
        return None
    return values[0]


def ps_line_argv(line: str, expected_executable: str) -> Optional[list[str]]:
    """Parse one ps command string without shell evaluation or substring identity checks.

    ps does not consistently quote argv[0] on macOS. Recognize the exact known
    Chrome executable prefix first (with a mandatory argument boundary), then
    parse only the remaining arguments with shlex. A quoted full command is
    also accepted, but its parsed argv[0] must be the exact expected path.
    """
    if not isinstance(line, str) or not isinstance(expected_executable, str):
        return None
    candidate = line.strip()
    if not candidate:
        return None
    if candidate[0] in {"'", '"'}:
        try:
            argv = shlex.split(candidate, posix=True)
        except ValueError:
            return None
        if argv and argv[0] == expected_executable:
            return argv
        return None

    if not candidate.startswith(expected_executable):
        return None
    tail = candidate[len(expected_executable):]
    if tail and not tail[0].isspace():
        return None
    try:
        arguments = shlex.split(tail, posix=True)
    except ValueError:
        return None
    return [expected_executable, *arguments]


def ps_line_matches_profile(line: str, expected_executable: str, profile: str) -> bool:
    argv = ps_line_argv(line, expected_executable)
    return argv is not None and extract_user_data_dir(argv) == profile


def _version_from_output(output: str) -> Optional[str]:
    match = _VERSION.match(output.strip())
    return match.group(1) if match else None


def linux_chrome_binary_for_launcher(launcher_path: str) -> Optional[str]:
    """Map supported official Google Linux launchers to their Chrome ELF executable."""
    launcher = os.path.realpath(launcher_path)
    known_wrappers = {
        "/opt/google/chrome/google-chrome": "/opt/google/chrome/chrome",
        "/opt/google/chrome-beta/google-chrome": "/opt/google/chrome-beta/chrome",
        "/opt/google/chrome-unstable/google-chrome": "/opt/google/chrome-unstable/chrome",
    }
    if launcher in known_wrappers:
        return known_wrappers[launcher]
    if launcher in known_wrappers.values():
        return launcher
    return None


def linux_argv_matches_profile(
    argv: Iterable[str],
    actual_executable: str,
    launcher_path: str,
    profile: str,
    expected_version: str,
    reported_version: str,
) -> bool:
    """Verify a Linux Chrome process while allowing a launcher wrapper to exec chrome.

    The process must have exactly one matching profile flag, the kernel-reported
    executable must be the canonical executable named 'chrome', argv[0] must be
    the exact launcher or actual executable path, and the actual executable's
    Google Chrome version must equal the trusted launcher's observed version.
    """
    args = list(argv)
    if not args or extract_user_data_dir(args) != profile:
        return False
    if not isinstance(actual_executable, str) or not actual_executable.startswith("/"):
        return False
    if actual_executable.endswith(" (deleted)") or os.path.basename(actual_executable) != "chrome":
        return False
    if os.path.realpath(actual_executable) != actual_executable:
        return False
    try:
        info = os.stat(actual_executable, follow_symlinks=False)
    except OSError:
        return False
    if not stat.S_ISREG(info.st_mode) or not os.access(actual_executable, os.X_OK):
        return False
    if args[0] not in {launcher_path, actual_executable}:
        return False
    actual_version = _version_from_output(reported_version)
    return actual_version is not None and actual_version == expected_version


def private_profile_chain_is_safe(home: str, profile: str, owner_uid: Optional[int] = None) -> bool:
    """Check all F1 path components (including pre-existing ancestors) for private ownership."""
    uid = os.getuid() if owner_uid is None else owner_uid
    if not isinstance(home, str) or not isinstance(profile, str):
        return False
    if not os.path.isabs(home) or not os.path.isabs(profile):
        return False
    canonical_home = os.path.realpath(home)
    if canonical_home != home or profile != os.path.join(home, ".bke-worker", "f1", "chrome-profile"):
        return False
    for path in (
        os.path.join(home, ".bke-worker"),
        os.path.join(home, ".bke-worker", "f1"),
        profile,
    ):
        try:
            info = os.lstat(path)
        except OSError:
            return False
        if stat.S_ISLNK(info.st_mode) or not stat.S_ISDIR(info.st_mode):
            return False
        if info.st_uid != uid or (stat.S_IMODE(info.st_mode) & 0o077) != 0:
            return False
        if os.path.realpath(path) != path:
            return False
    return True


def extension_match_count_is_one(value: str) -> bool:
    return isinstance(value, str) and bool(_EXTENSION_COUNT.fullmatch(value)) and int(value) == 1


def _hash_open_binary(path: str) -> Optional[str]:
    try:
        digest = hashlib.sha256()
        with open(path, "rb") as stream:
            for block in iter(lambda: stream.read(1024 * 1024), b""):
                digest.update(block)
        return digest.hexdigest()
    except OSError:
        return None


def _linux_process_probe(launcher_path: str, profile: str, expected_version: str) -> Optional[str]:
    proc_root = Path("/proc")
    if not proc_root.is_dir():
        return None
    for proc in proc_root.iterdir():
        if not proc.name.isdecimal():
            continue
        try:
            info = proc.stat()
            if info.st_uid != os.getuid():
                continue
            raw = (proc / "cmdline").read_bytes()
            argv = [os.fsdecode(part) for part in raw.split(b"\0") if part]
            if not argv or extract_user_data_dir(argv) != profile:
                continue
            actual_executable = os.readlink(proc / "exe")
            expected_executable = linux_chrome_binary_for_launcher(launcher_path)
            if not expected_executable or actual_executable != expected_executable:
                continue
            try:
                version_run = subprocess.run(
                    [actual_executable, "--version"],
                    capture_output=True, text=True, timeout=8, check=False,
                    env={"PATH": "/usr/bin:/bin", "HOME": os.environ.get("HOME", "/")},
                )
            except (OSError, subprocess.TimeoutExpired):
                continue
            if version_run.returncode != 0:
                continue
            if not linux_argv_matches_profile(
                argv, actual_executable, launcher_path, profile,
                expected_version, version_run.stdout,
            ):
                continue
            digest = _hash_open_binary(str(proc / "exe"))
            if digest and _SHA256.fullmatch(digest):
                return digest
        except (OSError, PermissionError, ValueError):
            continue
    return None



# The exact Google signing requirement matches forge_f1_chrome_publisher.py.
# Kept local: the owner Mac invokes this file under /usr/bin/python3 -I.
_DARWIN_GOOGLE_REQUIREMENT = (
    'anchor apple generic and identifier "com.google.Chrome" '
    'and certificate leaf[subject.OU] = "EQHXZ8M8AV"'
)


def _darwin_pid_executable(pid: int) -> Optional[str]:
    """Read executable path from Darwin kernel libproc, NOT ps argv[0]."""
    if not isinstance(pid, int) or pid <= 1:
        return None
    try:
        proc = ctypes.CDLL("/usr/lib/libproc.dylib").proc_pidpath
        proc.argtypes = [ctypes.c_int, ctypes.c_void_p, ctypes.c_uint32]
        proc.restype = ctypes.c_int
        buffer = ctypes.create_string_buffer(4096)
        n = proc(pid, buffer, ctypes.sizeof(buffer))
        if n <= 0 or n >= len(buffer):
            return None
        image = os.fsdecode(buffer.value)
        return image if image.startswith("/") and "\0" not in image else None
    except (OSError, AttributeError, TypeError, ValueError):
        return None


# Apple XNU proc_info.h, PRIVATE flavor 17:
# struct proc_uniqidentifierinfo { uint8_t uuid[16]; uint64_t uniqueid; ... };
# Availability/permission vary with macOS version. NEVER fall back to a ps
# lstart timestamp, which is rounded to seconds and PID-reuse unsafe.
_PROC_PIDUNIQIDENTIFIERINFO = 17


class _DarwinUniqueProcessInfo(ctypes.Structure):
    _fields_ = [
        ("executable_uuid", ctypes.c_ubyte * 16),
        ("process_unique_id", ctypes.c_uint64),
        ("parent_unique_id", ctypes.c_uint64),
        ("pid_version", ctypes.c_int32),
        ("reserved2", ctypes.c_uint32),
        ("reserved3", ctypes.c_uint64),
        ("reserved4", ctypes.c_uint64),
    ]


def _darwin_pid_unique_generation(pid: int) -> Optional[int]:
    """A kernel-assigned generation ID for this PID, not ps second text."""
    if not isinstance(pid, int) or pid <= 1:
        return None
    try:
        info = _DarwinUniqueProcessInfo()
        proc = ctypes.CDLL("/usr/lib/libproc.dylib").proc_pidinfo
        proc.argtypes = [ctypes.c_int, ctypes.c_int, ctypes.c_uint64,
                         ctypes.c_void_p, ctypes.c_int]
        proc.restype = ctypes.c_int
        size = ctypes.sizeof(info)
        received = proc(pid, _PROC_PIDUNIQIDENTIFIERINFO, 0,
                        ctypes.byref(info), size)
        if received != size or info.process_unique_id == 0:
            return None
        return int(info.process_unique_id)
    except (OSError, AttributeError, TypeError, ValueError):
        return None


def _darwin_signed_cdhash(target: str | int) -> Optional[str]:
    """Read code-directory identity from signed RUNNING PID or disk image.

    A CDHash identifies the signed CodeDirectory (not a raw file's bytes).
    It is not a secret, process credential or account identity. Caller MUST
    also have verified the Google signing requirement against the target.
    """
    if (not isinstance(target, (str, int)) or
        (isinstance(target, int) and target <= 1) or
        (isinstance(target, str) and
         (not target.startswith("/") or "\0" in target))):
        return None
    try:
        run = subprocess.run(
            ["/usr/bin/codesign", "--display", "--verbose=4", str(target)],
            capture_output=True, text=True, check=False, timeout=30,
            env={"PATH": "/usr/bin:/bin", "HOME": os.environ.get("HOME", "/")},
        )
    except (OSError, subprocess.SubprocessError):
        return None
    if run.returncode != 0:
        return None
    # Codesign output includes unrelated key/value lines; only a singular
    # canonical CDHash with 20 or 32 bytes of hex is usable.
    matches = re.findall(r"^CDHash=([0-9a-fA-F]{40}|[0-9a-fA-F]{64})$",
                         run.stdout + "\n" + run.stderr, re.MULTILINE)
    return matches[0].lower() if len(matches) == 1 else None


def _darwin_pid_signature_valid(pid: int) -> bool:
    """Verify the RUNNING process PID with Apple's dynamic codesign feature."""
    try:
        run = subprocess.run(
            ["/usr/bin/codesign", "--verify", "--strict",
             "-R", "=" + _DARWIN_GOOGLE_REQUIREMENT, str(pid)],
            capture_output=True, text=True, check=False, timeout=30,
            env={"PATH": "/usr/bin:/bin", "HOME": os.environ.get("HOME", "/")},
        )
    except (OSError, subprocess.SubprocessError):
        return False
    return run.returncode == 0


def _darwin_pid_row_unchanged(pid: int, uid: int, executable: str, profile: str) -> bool:
    try:
        run = subprocess.run(
            ["/bin/ps", "-p", str(pid), "-o", "pid=,uid=,command="],
            capture_output=True, text=True, check=False, timeout=8,
            env={"PATH": "/usr/bin:/bin", "HOME": os.environ.get("HOME", "/")},
        )
    except (OSError, subprocess.SubprocessError):
        return False
    rows = [line.split(maxsplit=2) for line in run.stdout.splitlines() if line.strip()]
    return (run.returncode == 0 and len(rows) == 1 and len(rows[0]) == 3
            and rows[0][0] == str(pid) and rows[0][1] == str(uid)
            and ps_line_matches_profile(rows[0][2], executable, profile))


def _darwin_process_probe(executable: str, profile: str) -> Optional[str]:
    """Reject ambiguous/forged rows; bind kernel unique generation and signed code."""
    try:
        listing = subprocess.run(
            ["/bin/ps", "-axo", "pid=,uid=,command="],
            capture_output=True, text=True, check=False, timeout=8,
            env={"PATH": "/usr/bin:/bin", "HOME": os.environ.get("HOME", "/")},
        )
    except (OSError, subprocess.SubprocessError):
        return None
    if listing.returncode != 0:
        return None
    uid = os.getuid()
    candidates = []
    for line in listing.stdout.splitlines():
        row = line.strip().split(maxsplit=2)
        if (len(row) == 3 and row[0].isdecimal() and row[1].isdecimal()
            and int(row[1]) == uid
            and ps_line_matches_profile(row[2], executable, profile)):
            candidates.append(int(row[0]))
    # Never select an arbitrary matching process when assignment is ambiguous.
    if len(candidates) != 1:
        return None
    pid = candidates[0]
    image = _darwin_pid_executable(pid)
    generation = _darwin_pid_unique_generation(pid)
    if (image != executable or generation is None or generation <= 0 or
        os.path.realpath(image) != executable):
        return None
    # Signature of the *running* process and its CodeDirectory must agree
    # with the publisher-checked on-disk executable. This is not a path hash.
    if not _darwin_pid_signature_valid(pid):
        return None
    live_cdhash = _darwin_signed_cdhash(pid)
    # A missing live CodeDirectory is an immediate hard DENY. Do not perform
    # later disk checks or continue after an uncertain PID proof.
    if not live_cdhash:
        return None
    disk_cdhash = _darwin_signed_cdhash(image)
    if disk_cdhash != live_cdhash:
        return None
    if (_darwin_pid_executable(pid) != image or
        _darwin_pid_unique_generation(pid) != generation or
        not _darwin_pid_row_unchanged(pid, uid, executable, profile) or
        not _darwin_pid_signature_valid(pid) or
        _darwin_signed_cdhash(pid) != live_cdhash or
        _darwin_signed_cdhash(image) != live_cdhash or
        _darwin_pid_unique_generation(pid) != generation):
        return None
    return hashlib.sha256(
        ("bke-f1/darwin/signed-generation-code-directory/v2\0" +
         str(pid) + "\0" + str(generation) + "\0" + image +
         "\0" + live_cdhash).encode("utf-8")
    ).hexdigest()


def active_chrome_runtime_sha256(platform: str, launcher_path: str, profile: str, version: str) -> Optional[str]:
    if platform == "Linux":
        return _linux_process_probe(launcher_path, profile, version)
    if platform == "Darwin":
        return _darwin_process_probe(launcher_path, profile)
    return None


def _main(argv: list[str]) -> int:
    if len(argv) == 3 and argv[0] == "--check-profile-chain":
        if private_profile_chain_is_safe(argv[1], argv[2]):
            print("PROFILE_CHAIN_PRIVATE_OWNER_VERIFIED")
            return 0
        print("PROFILE_CHAIN_UNSAFE", file=sys.stderr)
        return 2
    if len(argv) == 2 and argv[0] == "--validate-extension-count":
        if extension_match_count_is_one(argv[1]):
            print("1")
            return 0
        print("EXTENSION_MISSING_OR_DUPLICATE", file=sys.stderr)
        return 2
    if len(argv) == 5 and argv[0] == "--check-process":
        digest = active_chrome_runtime_sha256(argv[1], argv[2], argv[3], argv[4])
        if digest:
            print(digest)
            return 0
        return 1
    print("usage: forge_f1_chrome_readiness.py --check-profile-chain HOME PROFILE"
          " | --validate-extension-count COUNT"
          " | --check-process OS LAUNCHER PROFILE VERSION", file=sys.stderr)
    return 2


if __name__ == "__main__":
    raise SystemExit(_main(sys.argv[1:]))
