#!/usr/bin/env bash
set -euo pipefail

# One-time owner-attested ACK of an ALREADY DELIVERED first Mac pilot turn.
# This does NOT send a prompt, change GitHub, clear a draft, or arm any worker.
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"
for dep in git gh python3; do
  command -v "$dep" >/dev/null 2>&1 || { echo "BLOCKED:MISSING_DEPENDENCY" >&2; exit 2; }
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
IMPLEMENTATION_BRANCH = "feat/sandbox-f1-single-worker-pilot"
PR = 148
PILOT_BRANCH = "pilot/one-worker-two-real-turns"
SEED = "3c7de7d9740948c294ea3bbd8bcc5a2d515c82ef"
TURN1 = "c06161e87320510787eff9a1ff2df03f51a31b73"
FIXTURE = "experiments/pilot-one-worker/turns.json"
LABEL = "bke-worker:pilot-f1"

def stop(code):
    print("BLOCKED:" + code, file=sys.stderr)
    raise SystemExit(2)

def run(*args):
    try:
        p = subprocess.run(args, capture_output=True, text=True, timeout=30, check=False)
    except (OSError, subprocess.TimeoutExpired):
        stop("LOCAL_OR_GITHUB_READ_UNAVAILABLE")
    if p.returncode:
        stop("LOCAL_OR_GITHUB_READ_FAILED")
    return p.stdout.strip()

def api(path):
    try:
        return json.loads(run("gh", "api", "--method", "GET", path))
    except (KeyError, TypeError, ValueError):
        stop("INVALID_GITHUB_RESPONSE")

def verify():
    impl = api("repos/" + REPO + "/pulls/147")
    local_sha = run("git", "rev-parse", "HEAD")
    if impl.get("state") != "open" or impl.get("head", {}).get("sha") != local_sha or \
       run("git", "branch", "--show-current") != IMPLEMENTATION_BRANCH:
        stop("IMPLEMENTATION_HEAD_OR_BRANCH_MISMATCH")
    if run("git", "status", "--porcelain"):
        stop("DIRTY_WORKTREE")

    pilot = api("repos/" + REPO + "/pulls/148")
    if pilot.get("state") != "open" or pilot.get("draft") is not True or \
       pilot.get("head", {}).get("sha") != TURN1 or \
       pilot.get("head", {}).get("ref") != PILOT_BRANCH or \
       pilot.get("head", {}).get("repo", {}).get("full_name") != REPO or \
       pilot.get("base", {}).get("ref") != "main":
        stop("PILOT_HEAD_OR_BRANCH_MISMATCH")
    issue = api("repos/" + REPO + "/issues/148")
    if [x.get("name") for x in issue.get("labels", [])] != [LABEL]:
        stop("PILOT_ASSIGNMENT_AMBIGUOUS")

    open_prs = api("repos/" + REPO + "/pulls?state=open&per_page=100")
    if not isinstance(open_prs, list) or len(open_prs) >= 100:
        stop("INCOMPLETE_ASSIGNMENT_INVENTORY")
    assigned = [x.get("number") for x in open_prs
                if LABEL in [y.get("name") for y in x.get("labels", [])]]
    if assigned != [PR]:
        stop("CONFLICTING_PILOT_ASSIGNMENT")

    commits = api("repos/" + REPO + "/pulls/148/commits?per_page=100")
    if [x.get("sha") for x in commits] != [SEED, TURN1]:
        stop("FIRST_TURN_COMMIT_HISTORY_MISMATCH")
    commit = api("repos/" + REPO + "/commits/" + TURN1)
    if [x.get("sha") for x in commit.get("parents", [])] != [SEED] or \
       [x.get("filename") for x in commit.get("files", [])] != [FIXTURE]:
        stop("FIRST_TURN_SCOPE_MISMATCH")

    blob = api("repos/" + REPO + "/contents/" + FIXTURE + "?ref=" + PILOT_BRANCH)
    if blob.get("encoding") != "base64":
        stop("FIXTURE_ENCODING_MISMATCH")
    try:
        fixture = json.loads(base64.b64decode(blob["content"], validate=False))
    except (KeyError, TypeError, ValueError):
        stop("FIXTURE_INVALID")
    if fixture.get("completed_turns") != 1 or \
       not isinstance(fixture.get("turns"), list) or len(fixture["turns"]) != 1 or \
       fixture["turns"][0].get("turn") != 1 or \
       fixture["turns"][0].get("starting_head_sha") != SEED:
        stop("FIXTURE_NOT_EXACTLY_TURN_ONE")

    checkpoints = api("repos/" + REPO + "/issues/148/comments?per_page=100")
    if len(checkpoints) >= 100:
        stop("CHECKPOINT_INVENTORY_INCOMPLETE")
    accepted = [x for x in checkpoints
                if "BKE EXECUTION CHECKPOINT" in x.get("body", "")
                and "IMPLEMENTED" in x.get("body", "")
                and TURN1 in x.get("body", "")
                and "Turn recorded: 1 of 2" in x.get("body", "")
                and x.get("author_association") in {"OWNER", "MEMBER", "COLLABORATOR"}]
    if len(accepted) != 1:
        stop("VERIFIED_FIRST_TURN_CHECKPOINT_MISSING_OR_AMBIGUOUS")
    return local_sha

def reconcile():
    head = verify()
    path = Path(os.environ.get(
        "BKE_SANDBOX_JOURNAL",
        str(Path.home() / ".local/state/bke-worker/pilot-pr148.json"))).expanduser()
    if not path.is_absolute() or path.is_symlink():
        stop("JOURNAL_PATH_UNSAFE")
    try:
        st = path.stat()
    except OSError:
        stop("JOURNAL_NOT_FOUND")
    if not stat.S_ISREG(st.st_mode) or st.st_uid != os.getuid() or st.st_mode & 0o077:
        stop("JOURNAL_PERMISSIONS_UNSAFE")
    try:
        fd = os.open(str(path) + ".lock", os.O_CREAT | os.O_RDWR |
                     getattr(os, "O_NOFOLLOW", 0), 0o600)
        fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
    except (OSError, BlockingIOError):
        stop("PILOT_RUNTIME_LOCK_HELD")
    try:
        original = path.read_bytes()
        try:
            j = json.loads(original)
        except ValueError:
            stop("JOURNAL_INVALID")
        if not isinstance(j, dict) or set(j) != {"assignment", "pending", "sends"} or \
           j["assignment"] != PR or j["sends"] != [] or \
           not isinstance(j["pending"], dict):
            stop("JOURNAL_NOT_ONE_UNCONFIRMED_FIRST_SEND")
        pending = j["pending"]
        if set(pending) != {"key", "time"} or \
           pending["key"] != "148:" + SEED + ":first" or \
           type(pending["time"]) is not int or pending["time"] <= 0:
            stop("PENDING_SEND_DOES_NOT_MATCH_FIRST_TURN")

        print("GITHUB_PROOF:PR148_TURN1_COMMIT_CHECKPOINT_VERIFIED")
        print("PILOT_JOURNAL:EXACTLY_ONE_PENDING_FIRST_SEND")
        print("LOCAL_IMPLEMENTATION_HEAD:" + head)
        print("The original ChatGPT message must be visible as a SENT user turn")
        print("in the exact dedicated pilot chat, not merely a composer draft.")
        print("Keep the Mac worker STOPPED; this ACK will not restart it.")
        try:
            with open("/dev/tty", "r", encoding="utf-8") as tty:
                print("Type ACKNOWLEDGE VERIFIED TURN 1 to attest: ", end="", flush=True)
                attested = tty.readline()
        except (OSError, UnicodeError):
            stop("OWNER_TTY_REQUIRED")
        if attested.strip() != "ACKNOWLEDGE VERIFIED TURN 1":
            stop("OWNER_ATTESTATION_REQUIRED")

        verify()
        if path.read_bytes() != original:
            stop("JOURNAL_CHANGED_DURING_RECONCILIATION")
        digest = hashlib.sha256(original).hexdigest()
        stamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
        backup = path.with_name(path.name + ".turn1-unconfirmed-" +
                                stamp + "-" + digest[:12] + ".bak")
        try:
            backup_fd = os.open(backup, os.O_WRONLY | os.O_CREAT | os.O_EXCL |
                                getattr(os, "O_NOFOLLOW", 0), 0o600)
            with os.fdopen(backup_fd, "wb") as out:
                out.write(original)
                out.flush()
                os.fsync(out.fileno())
        except OSError:
            stop("BACKUP_FAILED")
        if backup.read_bytes() != original:
            stop("BACKUP_READBACK_MISMATCH")
        updated = {"assignment": PR, "pending": None, "sends": [
            {"key": pending["key"], "time": pending["time"], "head": SEED}
        ]}
        tmp = path.with_name(path.name + ".turn1-ack.tmp")
        try:
            temporary_fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_EXCL |
                                   getattr(os, "O_NOFOLLOW", 0), 0o600)
            with os.fdopen(temporary_fd, "w", encoding="utf-8") as out:
                json.dump(updated, out, sort_keys=True)
                out.write("\n")
                out.flush()
                os.fsync(out.fileno())
            os.replace(tmp, path)
        except OSError:
            stop("RECOVERY_WRITE_FAILED_BACKUP_PRESERVED")
        if json.loads(path.read_text(encoding="utf-8")) != updated:
            stop("RECOVERY_READBACK_FAILED_BACKUP_PRESERVED")
        print("TURN1_ACK_RECOVERED:PENDING_FALSE:SENDS_1")
        print("ORIGINAL_SEND_TIMESTAMP_PRESERVED")
        print("BACKUP_SAVED:" + backup.name)
        print("BACKUP_SHA256:" + digest)
        print("NO_LIVE_RESTART:TURN2_NOT_CERTIFIED")
    finally:
        os.close(fd)

reconcile()
PY
