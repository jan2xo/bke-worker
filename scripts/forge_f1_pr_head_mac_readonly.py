#!/usr/bin/env python3
"""F1-03 exact-PR-head, owner-consented READ-ONLY macOS process diagnostic.

This is deliberately NOT the clean-main owner-policy provisioner. It cannot
provision pins, enroll workers, install native hosts, grant Chrome permissions,
read browser contents or authorize ChatGPT sends. Physical diagnostic use is
owner-only AFTER separate exact-head source review.
"""
from __future__ import annotations
import hashlib
import os
from pathlib import Path
import re
import subprocess
import sys

ROOT = Path(__file__).resolve().parents[1]
BRANCH = "feat/f1-03-owner-policy-provisioning-20261023"
PUBLIC_REPO = "https://github.com/jan2xo/bke-worker.git"
ORIGINS = {
    "https://github.com/jan2xo/bke-worker",
    PUBLIC_REPO,
    "git@github.com:jan2xo/bke-worker.git",
    "ssh://git@github.com/jan2xo/bke-worker.git",
}
PR_REF = "refs/pull/146/head"
MAIN_REF = "refs/heads/main"
SHA = re.compile(r"^[0-9a-f]{40}$")
PIN = re.compile(r"^[0-9a-f]{64}$")
APP_EXE = "Google Chrome.app/Contents/MacOS/Google Chrome"
CONSENT = "I APPROVE READ ONLY PR 146 MAC IDENTITY CHECK"
RUNTIME_FILES = (
    "scripts/forge_f1_pr_head_mac_readonly.py",
    "scripts/forge_f1_chrome_readiness.py",
    "scripts/forge_f1_chrome_publisher.py",
)


class Blocked(Exception):
    pass


def fail(reason: str):
    raise Blocked(reason)


def command(argv: list[str], timeout: int = 30, *, cwd: str | None = None) -> str:
    """No shell, no ambient user Git config or interactive credential prompts."""
    env = {
        "PATH": "/usr/bin:/bin",
        "HOME": os.path.expanduser("~"),
        "GIT_TERMINAL_PROMPT": "0",
        "GIT_OPTIONAL_LOCKS": "0",
        "GIT_CONFIG_NOSYSTEM": "1",
        "GIT_CONFIG_GLOBAL": "/dev/null",
        "GIT_ALLOW_PROTOCOL": "https",
        "GIT_NO_REPLACE_OBJECTS": "1",
        # Disable local fsmonitor at the highest Git config precedence.
        "GIT_CONFIG_COUNT": "1",
        "GIT_CONFIG_KEY_0": "core.fsmonitor",
        "GIT_CONFIG_VALUE_0": "false",
    }
    try:
        done = subprocess.run(argv, capture_output=True, text=True,
                              check=False, timeout=timeout, env=env, cwd=cwd)
    except (OSError, subprocess.SubprocessError):
        fail("COMMAND_UNAVAILABLE")
    if done.returncode != 0 or len(done.stdout) > 4096:
        fail("COMMAND_FAILED")
    return done.stdout.strip()


def git(*args: str) -> str:
    return command(["/usr/bin/git", "-C", str(ROOT), *args])


def git_config_fingerprint() -> str:
    """Reject URL rewrites and commands Git status could execute."""
    # Global and system Git config are suppressed by command(). Local config
    # is inspected here, but is NEVER consulted by the HTTPS ls-remote call.
    settings = git("config", "--list", "--includes", "--null")
    for entry in settings.split("\0"):
        key, separator, value = entry.partition("\n")
        key = key.casefold()
        if key == "core.fsmonitor" and (not separator or value.casefold() != "false"):
            fail("LOCAL_FSMONITOR_FORBIDDEN")
        if (key.startswith("filter.") and key.rsplit(".", 1)[-1] in
                {"clean", "smudge", "process"}) or (key.startswith("diff.") and
                key.endswith(".command")):
            fail("LOCAL_GIT_COMMAND_CONFIG_FORBIDDEN")
        if key.startswith("url.") and (
            key.endswith(".insteadof") or key.endswith(".pushinsteadof")
        ):
            fail("LOCAL_URL_REWRITE_FORBIDDEN")
    return hashlib.sha256(settings.encode("utf-8")).hexdigest()


def assert_clean_commit_graph() -> None:
    """Fail closed on repository-local commit-graph ancestry overrides.

    for-each-ref enumerates loose AND packed replacement refs. The Git-path
    resolution honors linked worktrees and the common Git directory. Merely
    setting GIT_NO_REPLACE_OBJECTS cannot disable legacy info/grafts, so both
    forms are refused before and after local ancestry evaluation.
    """
    if git("for-each-ref", "--format=%(refname)", "refs/replace"):
        fail("LOCAL_REPLACEMENT_REFS_FORBIDDEN")
    graft_path = Path(git("rev-parse", "--git-path", "info/grafts"))
    if not graft_path.is_absolute():
        graft_path = ROOT / graft_path
    if os.path.lexists(str(graft_path)):
        fail("LOCAL_GRAFTS_FORBIDDEN")


def verify_tracked_source(head: str) -> None:
    """Refuse index hiding flags and independently match runtime blobs to HEAD.

    Git status is not authoritative for assume-unchanged or skip-worktree.
    Inspect every tracked index flag, then hash executed Python sources with
    Git's canonical blob hashing format. HEAD is checked against GitHub later.
    """
    index = git("ls-files", "-v", "-z")
    if not index:
        fail("TRACKED_INDEX_UNAVAILABLE")
    tracked = set()
    for record in index.split("\0"):
        if not record:
            continue
        if len(record) < 3 or record[1] != " ":
            fail("INDEX_FLAGS_UNCERTAIN")
        if record[0] != "H":
            fail("UNSAFE_TRACKED_INDEX_FLAGS")
        filename = record[2:]
        if filename in tracked:
            fail("INDEX_FLAGS_UNCERTAIN")
        tracked.add(filename)
    if not set(RUNTIME_FILES).issubset(tracked):
        fail("RUNTIME_SOURCE_NOT_TRACKED")

    rows = git("ls-tree", "-r", "-z", head, "--", *RUNTIME_FILES)
    expected = {}
    for row in rows.split("\0"):
        if not row:
            continue
        meta, tab, filename = row.partition("\t")
        parts = meta.split(" ")
        if not tab or len(parts) != 3 or parts[:2] != ["100644", "blob"] or \
                not SHA.fullmatch(parts[2]) or filename in expected:
            fail("RUNTIME_SOURCE_TREE_INVALID")
        expected[filename] = parts[2]
    if set(expected) != set(RUNTIME_FILES):
        fail("RUNTIME_SOURCE_TREE_INVALID")
    for filename, blob_id in expected.items():
        path = ROOT / filename
        if os.path.realpath(str(path)) != str(path) or not path.is_file():
            fail("RUNTIME_SOURCE_PATH_UNTRUSTED")
        content = path.read_bytes()
        git_blob = b"blob " + str(len(content)).encode("ascii") + b"\0" + content
        if hashlib.sha1(git_blob).hexdigest() != blob_id:
            fail("RUNTIME_SOURCE_HASH_MISMATCH")


def snapshot_source() -> tuple[str, str, str]:
    """Compare local HEAD with live remote PR ref, never with cached origin/PR."""
    if os.path.realpath(str(ROOT)) != str(ROOT):
        fail("ROOT_UNTRUSTED")
    if git("rev-parse", "--show-toplevel") != str(ROOT):
        fail("REPOSITORY_UNTRUSTED")
    config_fingerprint = git_config_fingerprint()
    assert_clean_commit_graph()
    if git("remote", "get-url", "origin") not in ORIGINS:
        fail("ORIGIN_UNTRUSTED")
    if git("branch", "--show-current") != BRANCH:
        fail("NOT_F1_PR_BRANCH")
    head = git("rev-parse", "HEAD")
    if not SHA.fullmatch(head):
        fail("HEAD_INVALID")
    verify_tracked_source(head)
    if git("status", "--porcelain", "--untracked-files=all"):
        fail("DIRTY_SOURCE")
    verify_tracked_source(head)
    # Run OUTSIDE the checkout: repository-local URL rewrites cannot redirect
    # this explicit canonical GitHub HTTPS ref query. No fetch or hooks.
    remote = command(["/usr/bin/git", "ls-remote", PUBLIC_REPO,
                      PR_REF, MAIN_REF], timeout=30, cwd="/")
    found = {}
    for line in remote.splitlines():
        columns = line.split()
        if len(columns) != 2 or columns[1] not in {PR_REF, MAIN_REF} or \
           not SHA.fullmatch(columns[0]) or columns[1] in found:
            fail("REMOTE_REFS_AMBIGUOUS")
        found[columns[1]] = columns[0]
    if set(found) != {PR_REF, MAIN_REF} or found[PR_REF] != head:
        fail("STALE_OR_DIFFERENT_PR_HEAD")
    # Refuse local ancestry overrides before and after Git graph evaluation.
    # GIT_NO_REPLACE_OBJECTS=1 is also enforced for every git subprocess.
    assert_clean_commit_graph()
    if git("merge-base", "--is-ancestor", found[MAIN_REF], "HEAD"):
        # The Git command prints nothing on success.
        fail("MAIN_ANCESTRY_UNCERTAIN")
    assert_clean_commit_graph()
    verify_tracked_source(head)
    if git_config_fingerprint() != config_fingerprint:
        fail("LOCAL_GIT_CONFIG_CHANGED")
    return head, found[MAIN_REF], config_fingerprint


def probe_readonly_mac() -> str:
    if sys.platform != "darwin":
        fail("MAC_ONLY")
    home = os.path.expanduser("~")
    if not os.path.isabs(home) or os.path.realpath(home) != home:
        fail("HOME_UNTRUSTED")
    profile = os.path.join(home, ".bke-worker", "f1", "chrome-profile")
    verify = str(ROOT / "scripts" / "forge_f1_chrome_readiness.py")
    signer = str(ROOT / "scripts" / "forge_f1_chrome_publisher.py")
    python = "/usr/bin/python3"
    if command([python, "-I", verify, "--check-profile-chain", home, profile]) != \
       "PROFILE_CHAIN_PRIVATE_OWNER_VERIFIED":
        fail("PRIVATE_PROFILE_NOT_PROVEN")
    choices = [os.path.join("/Applications", APP_EXE),
               os.path.join(home, "Applications", APP_EXE)]
    selected = [path for path in choices if os.path.exists(path)]
    if len(selected) != 1:
        fail("CHROME_INSTALL_AMBIGUOUS")
    binary = selected[0]
    if command([python, "-I", signer, binary], timeout=95) != \
       "BKE_CHROME_GOOGLE_SIGNER_VERIFIED":
        fail("GOOGLE_SIGNATURE_NOT_PROVEN")
    if os.path.realpath(binary) != binary:
        fail("CHROME_PATH_UNTRUSTED")
    # Intentionally NEVER execute Google Chrome, not even with --version.
    # Darwin's existing source checker ignores the version argument; this is
    # a PID-signature/CodeDirectory/private-profile diagnostic ONLY.
    process = command([python, "-I", verify, "--check-process",
                       "Darwin", binary, profile, "0.0.0.0"], timeout=95)
    if not PIN.fullmatch(process) or len(set(process)) == 1:
        fail("RUNNING_SIGNED_PID_NOT_PROVEN")
    # Detect changed process generation, disk signature or profile during work.
    if command([python, "-I", signer, binary], timeout=95) != \
       "BKE_CHROME_GOOGLE_SIGNER_VERIFIED":
        fail("CHROME_SIGNATURE_CHANGED")
    again = command([python, "-I", verify, "--check-process",
                     "Darwin", binary, profile, "0.0.0.0"], timeout=95)
    if process != again:
        fail("PROCESS_OR_CODE_IDENTITY_CHANGED")
    if command([python, "-I", verify, "--check-profile-chain", home, profile]) != \
       "PROFILE_CHAIN_PRIVATE_OWNER_VERIFIED":
        fail("PROFILE_CHANGED")
    return process


def main(argv: list[str]) -> int:
    try:
        if argv or sys.platform != "darwin" or os.geteuid() == 0 or \
           not sys.stdin.isatty() or not sys.stdout.isatty():
            fail("OWNER_TTY_MAC_REQUIRED")
        if Path(__file__).is_symlink():
            fail("SYMLINK_ENTRYPOINT_REFUSED")
        before = snapshot_source()
        print("BKE F1-03 read-only PR-head source verified:", before[0])
        print("No Chrome launch, policy creation, profile content read, or permission grant.")
        if input("Type the exact reviewed PR HEAD SHA: ").strip() != before[0]:
            fail("OWNER_REVIEWED_SHA_MISMATCH")
        if input("Type exactly '" + CONSENT + "': ") != CONSENT:
            fail("OWNER_CONSENT_MISSING")
        probe_readonly_mac()
        after = snapshot_source()
        if after != before:
            fail("REMOTE_OR_SOURCE_CHANGED_DURING_PROBE")
    except (Blocked, EOFError, KeyboardInterrupt) as error:
        reason = str(error) if isinstance(error, Blocked) else "OWNER_ABORTED"
        print("BKE_F1_PR_HEAD_DIAGNOSTIC=BLOCKED reason=" + reason, file=sys.stderr)
        return 2
    except Exception:
        # No secrets, paths or stack traces in the owner-visible status.
        print("BKE_F1_PR_HEAD_DIAGNOSTIC=BLOCKED reason=UNCERTAIN", file=sys.stderr)
        return 2
    print("BKE_F1_PR_HEAD_DIAGNOSTIC=READ_ONLY_PID_PROBE_PASS")
    print("BKE_F1_REAL_CHROME_READY=NOT_PROVEN")
    print("BKE_F1_NATIVE_HOST_HANDSHAKE=NOT_RUN")
    print("BKE_F1_CONTROLLER_AUTH=NOT_ESTABLISHED")
    print("BKE_F1_DISPATCH_AUTHORITY=NONE")
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
