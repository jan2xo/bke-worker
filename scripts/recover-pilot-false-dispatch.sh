#!/usr/bin/env bash
set -euo pipefail

# Owner-attested recovery of exactly one historical false-positive Mac pilot send.
# Reads GitHub; only rewrites the owner-local journal after exclusive lock and backup.
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"
for dep in git gh python3; do
  if ! command -v "$dep" >/dev/null 2>&1; then
    echo 'BLOCKED:MISSING_DEPENDENCY' >&2
    exit 2
  fi
done

python3 - <<'PY'
import base64
import fcntl
import hashlib
import json
import os
from pathlib import Path
import stat
import subprocess
import sys
from datetime import datetime, timezone

REPO = "jan2xo/bke-worker"
SEED = "3c7de7d9740948c294ea3bbd8bcc5a2d515c82ef"
BRANCH = "feat/sandbox-f1-single-worker-pilot"
PILOT_BRANCH = "pilot/one-worker-two-real-turns"
FIXTURE = "experiments/pilot-one-worker/turns.json"

def stop(reason):
    print("BLOCKED:" + reason, file=sys.stderr)
    raise SystemExit(2)

def command(args):
    try:
        p = subprocess.run(args, capture_output=True, text=True, timeout=30)
    except (OSError, subprocess.TimeoutExpired):
        stop("GITHUB_OR_GIT_UNAVAILABLE")
    if p.returncode:
        stop("GITHUB_OR_GIT_READ_FAILED")
    return p.stdout.strip()

def get(path):
    try:
        return json.loads(command(["gh", "api", "--method", "GET", path]))
    except (ValueError, TypeError):
        stop("GITHUB_INVALID_RESPONSE")

def verify_github():
    impl = get(f"repos/{REPO}/pulls/147")
    local_sha = command(["git", "rev-parse", "HEAD"])
    local_branch = command(["git", "branch", "--show-current"])
    if local_branch != BRANCH or impl["state"] != "open" or \
       impl["head"]["ref"] != BRANCH or impl["head"]["sha"] != local_sha:
        stop("IMPLEMENTATION_HEAD_NOT_EXACT")
    if command(["git", "status", "--porcelain"]):
        stop("DIRTY_WORKTREE")
    pilot = get(f"repos/{REPO}/pulls/148")
    labels = get(f"repos/{REPO}/issues/148")["labels"]
    if pilot["state"] != "open" or pilot["draft"] is not True or \
       pilot["head"]["sha"] != SEED or pilot["head"]["ref"] != PILOT_BRANCH or \
       pilot["head"]["repo"]["full_name"] != REPO or pilot["base"]["ref"] != "main":
        stop("PILOT_PR_CHANGED")
    if labels:
        stop("PILOT_LABEL_KILL_SWITCH_NOT_ACTIVE")
    commits = get(f"repos/{REPO}/pulls/148/commits?per_page=100")
    if len(commits) != 1 or commits[0]["sha"] != SEED:
        stop("PILOT_NOT_SEED_ONLY")
    content = get(f"repos/{REPO}/contents/{FIXTURE}?ref={PILOT_BRANCH}")
    if content.get("encoding") != "base64":
        stop("PILOT_FIXTURE_ENCODING_INVALID")
    try:
        fixture = json.loads(base64.b64decode(content["content"]))
    except (ValueError, KeyError):
        stop("PILOT_FIXTURE_INVALID")
    if fixture.get("completed_turns") != 0 or fixture.get("turns") != []:
        stop("PILOT_FIXTURE_ALREADY_ADVANCED")
    return local_sha

def recover():
    head = verify_github()
    path = Path(os.environ.get(
        "BKE_SANDBOX_JOURNAL",
        str(Path.home() / ".local/state/bke-worker/pilot-pr148.json")
    )).expanduser()
    if not path.is_absolute() or path.is_symlink():
        stop("JOURNAL_PATH_UNSAFE")
    try:
        info = path.stat()
    except OSError:
        stop("JOURNAL_NOT_FOUND")
    if not stat.S_ISREG(info.st_mode) or info.st_uid != os.getuid() or (info.st_mode & 0o077):
        stop("JOURNAL_PERMISSIONS_UNSAFE")
    try:
        lock = os.open(str(path) + ".lock",
                       os.O_CREAT | os.O_RDWR | getattr(os, "O_NOFOLLOW", 0), 0o600)
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
    except (OSError, BlockingIOError):
        stop("WORKER_RUNNING_OR_UNSAFE_LOCK")
    try:
        original = path.read_bytes()
        try:
            state = json.loads(original)
        except ValueError:
            stop("JOURNAL_INVALID")
        if not isinstance(state, dict) or set(state) != {"assignment", "pending", "sends"}:
            stop("JOURNAL_SHAPE_UNEXPECTED")
        if state["assignment"] != 148 or state["pending"] is not None or \
           not isinstance(state["sends"], list) or len(state["sends"]) != 1:
            stop("NOT_ONE_HISTORICAL_FALSE_DISPATCH")
        old = state["sends"][0]
        if not isinstance(old, dict) or old.get("head") != SEED or \
           old.get("key") != f"148:{SEED}:first" or type(old.get("time")) is not int:
            stop("HISTORICAL_SEND_RECORD_MISMATCH")
        print("REMOTE_SAFE: PR #148 unassigned; one seed commit; turns 0/2")
        print("LOCAL_SAFE: PR #147 exact head " + head)
        print("HISTORICAL_SEND: one old unverified first dispatch")
        print("CONFIRM: original pilot instruction absent from BOTH sent messages")
        print("and composer, in the EXACT dedicated human-authenticated ChatGPT chat.")
        try:
            answer = input("Type RECOVER FALSE SEND to confirm: ").strip()
        except EOFError:
            stop("OWNER_CONFIRMATION_REQUIRED")
        if answer != "RECOVER FALSE SEND":
            stop("OWNER_DECLINED")
        verify_github()
        if path.read_bytes() != original:
            stop("JOURNAL_CHANGED")
        stamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
        digest = hashlib.sha256(original).hexdigest()
        backup = path.with_name(path.name + f".false-positive-{stamp}-{digest[:12]}.bak")
        try:
            fd = os.open(backup,
                         os.O_WRONLY | os.O_CREAT | os.O_EXCL | getattr(os, "O_NOFOLLOW", 0),
                         0o600)
            with os.fdopen(fd, "wb") as file:
                file.write(original)
                file.flush()
                os.fsync(file.fileno())
        except OSError:
            stop("BACKUP_FAILED")
        if backup.read_bytes() != original:
            stop("BACKUP_MISMATCH")
        corrected = {"assignment": 148, "pending": None, "sends": []}
        temporary = path.with_name(path.name + ".false-positive-recover.tmp")
        try:
            fd = os.open(temporary,
                         os.O_WRONLY | os.O_CREAT | os.O_EXCL | getattr(os, "O_NOFOLLOW", 0),
                         0o600)
            with os.fdopen(fd, "w", encoding="utf-8") as file:
                json.dump(corrected, file, sort_keys=True)
                file.write("\n")
                file.flush()
                os.fsync(file.fileno())
            os.replace(temporary, path)
        except OSError:
            stop("RECOVERY_WRITE_FAILED_BACKUP_SAVED")
        if json.loads(path.read_text(encoding="utf-8")) != corrected:
            stop("RECOVERY_READBACK_FAILED_BACKUP_SAVED")
        print("RECOVERY_COMPLETE:PENDING_FALSE:SENDS_0")
        print("BACKUP_SAVED:" + backup.name)
        print("BACKUP_SHA256:" + digest)
        print("PR148_STILL_UNASSIGNED: DO_NOT_RUN_LIVE")
    finally:
        os.close(lock)

recover()
PY
