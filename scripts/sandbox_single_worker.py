#!/usr/bin/env python3
"""One personal sandbox worker. GitHub is task authority; this file only wakes ChatGPT.

Run with --once for read-only dry run, or --live for an owner-enabled poll loop.
No web server, no GitHub mutation, no credential issuance, no background install.
"""
from __future__ import annotations

import argparse
import fcntl
import json
import os
from pathlib import Path
import re
import subprocess
import sys
import time
from urllib.parse import urlparse

SANDBOX = "jan2xo/bke-worker-sandbox"
WORKER = "pilot-f1"
LABEL = "bke-worker:" + WORKER
POLL_SECONDS = 60
HEARTBEAT_SECONDS = 1800
MAX_PER_HOUR = 3
SHA = re.compile(r"[0-9a-f]{40}\Z")


class Blocked(Exception):
    pass


def github(path: str):
    # Fixed repo and fixed, read-only GitHub CLI operations. No PR labels,
    # comments or repository content are written by this process.
    if not path.startswith("repos/" + SANDBOX + "/"):
        raise Blocked("SANDBOX_ONLY")
    try:
        proc = subprocess.run(["gh", "api", "--method", "GET", path],
                              capture_output=True, text=True, timeout=20,
                              check=False)
    except (OSError, subprocess.TimeoutExpired):
        raise Blocked("GITHUB_READER_UNAVAILABLE") from None
    if proc.returncode:
        raise Blocked("SANDBOX_REPOSITORY_OR_GITHUB_AUTH_UNAVAILABLE")
    try:
        return json.loads(proc.stdout)
    except ValueError:
        raise Blocked("GITHUB_RESPONSE_INVALID") from None


def assignment():
    prs = github("repos/" + SANDBOX + "/pulls?state=open&per_page=100")
    if not isinstance(prs, list) or len(prs) >= 100:
        raise Blocked("SANDBOX_PR_INVENTORY_INCOMPLETE")
    matches = []
    for pr in prs:
        if not isinstance(pr, dict):
            raise Blocked("SANDBOX_PR_INVALID")
        names = [item.get("name") for item in pr.get("labels", [])
                 if isinstance(item, dict)]
        owners = [name for name in names
                  if isinstance(name, str) and name.startswith("bke-worker:")]
        if LABEL not in owners:
            continue
        if owners != [LABEL]:
            raise Blocked("AMBIGUOUS_WORKER_LABEL")
        head = pr.get("head") or {}
        number = pr.get("number")
        commit = head.get("sha")
        head_repo = (head.get("repo") or {}).get("full_name")
        if (pr.get("state") != "open" or type(number) is not int or
                number <= 0 or type(commit) is not str or
                not SHA.fullmatch(commit) or head_repo != SANDBOX):
            raise Blocked("SANDBOX_ASSIGNMENT_INVALID")
        matches.append((number, commit))
    if len(matches) > 1:
        raise Blocked("WORKER_ASSIGNED_MULTIPLE_PRS")
    return matches[0] if matches else None


def read_journal(path: Path):
    if not path.exists():
        return {"assignment": None, "pending": None, "sends": []}
    try:
        value = json.loads(path.read_text(encoding="utf-8"))
        if (not isinstance(value, dict) or
                set(value) != {"assignment", "pending", "sends"} or
                not isinstance(value["sends"], list)):
            raise ValueError()
        return value
    except (OSError, ValueError):
        raise Blocked("JOURNAL_UNREADABLE") from None


def save_journal(path: Path, value: dict):
    temporary = path.with_name(path.name + ".tmp")
    descriptor = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    try:
        with os.fdopen(descriptor, "w", encoding="utf-8") as handle:
            json.dump(value, handle, sort_keys=True)
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(temporary, path)
    finally:
        if temporary.exists():
            temporary.unlink()


def check_live_configuration():
    if os.environ.get("BKE_SANDBOX_LIVE_SEND_ENABLED") != "YES":
        raise Blocked("OWNER_LIVE_OPT_IN_REQUIRED")
    target = os.environ.get("BKE_WORKER_CHATGPT_OVERRIDE_URL", "")
    if not re.fullmatch(r"https://chatgpt\.com/c/[0-9a-f-]{36}/?", target):
        raise Blocked("DEDICATED_CHATGPT_CONVERSATION_REQUIRED")
    endpoint = urlparse(os.environ.get("BKE_WORKER_BROWSER_CDP_ENDPOINT", ""))
    if (endpoint.scheme != "http" or endpoint.hostname not in
            {"localhost", "127.0.0.1", "::1"} or endpoint.port is None):
        raise Blocked("LOOPBACK_CDP_REQUIRED")
    profile = os.environ.get("BKE_WORKER_CHATGPT_PROFILE", "")
    if not profile or ("sandbox" not in profile.lower() and "pilot" not in profile.lower()):
        raise Blocked("DEDICATED_SANDBOX_BROWSER_PROFILE_REQUIRED")


def prompt(number: int, head: str):
    return (
        "BKE WORKER PERSONAL SANDBOX PILOT. Only act in "
        + SANDBOX + ", PR #" + str(number) + " at exact head " + head + ". "
        "First read bke.md and BKE-WORKER-CANONICAL-PROJECT-EXECUTION-INSTRUCTIONS.md "
        "from current main of jan2xo/bke-worker, and confirm current sandbox "
        "PR ownership is exactly " + LABEL + ". If ownership/head changed, stop. "
        "Continue ONE bounded engineering step through GitHub, commit only in "
        "the sandbox PR and post a causal PR checkpoint. Never merge, touch "
        "production, change credentials, authenticate ChatGPT, create an "
        "unrelated task, or edit a non-sandbox repository. If blocked, record "
        "the reason on the sandbox PR and stop."
    )


def dispatch(message: str):
    root = Path(__file__).resolve().parents[1]
    environment = os.environ.copy()
    environment["BKE_WORKER_ID"] = WORKER
    # Prevent a general worker env file from overriding the sandbox target.
    environment["BKE_WORKER_ENV_FILE"] = "/dev/null"
    command = ["bash", str(root / "scripts/send-chatgpt-live.sh"), message]
    try:
        result = subprocess.run(command, env=environment, timeout=150,
                                check=False, stdout=subprocess.DEVNULL,
                                stderr=subprocess.DEVNULL)
    except (OSError, subprocess.TimeoutExpired):
        raise Blocked("SEND_OUTCOME_UNCERTAIN") from None
    if result.returncode != 0:
        # The underlying smoke may have submitted before returning error.
        raise Blocked("SEND_OUTCOME_UNCERTAIN")


def tick(journal_path: Path, *, live: bool, now: int | None = None):
    now = int(time.time()) if now is None else now
    current = assignment()
    if current is None:  # Removing the PR label is the kill switch.
        return "WAITING_NO_SANDBOX_ASSIGNMENT"
    number, head = current
    journal = read_journal(journal_path)
    if journal["pending"] is not None:
        raise Blocked("OWNER_RECOVERY_REQUIRED_UNKNOWN_SEND")
    existing = journal["assignment"]
    if existing is not None and existing != number:
        raise Blocked("PREVIOUS_ASSIGNMENT_NOT_RELEASED")
    history = journal["sends"]
    if not isinstance(history, list) or len(history) > 10000:
        raise Blocked("JOURNAL_INVALID")
    if any(type(x) is not dict or type(x.get("time")) is not int
           or type(x.get("key")) is not str for x in history):
        raise Blocked("JOURNAL_INVALID")
    if sum(1 for x in history if now - 3600 < x["time"] <= now) >= MAX_PER_HOUR:
        return "RATE_CAP_STOP"
    last = history[-1] if history else None
    if last is not None and last["head"] == head and now - last["time"] < HEARTBEAT_SECONDS:
        return "WAITING_FOR_HEARTBEAT"
    reason = ("first" if last is None else
              "head-change" if last["head"] != head else
              "heartbeat-" + str(now // HEARTBEAT_SECONDS))
    key = str(number) + ":" + head + ":" + reason
    if any(x["key"] == key for x in history):
        return "DUPLICATE_WAKE_STOP"
    if not live:
        return "DRY_RUN_READY:" + reason + ":PR#" + str(number)
    check_live_configuration()
    if assignment() != current:  # Remove-label race before any side effect.
        raise Blocked("ASSIGNMENT_CHANGED_PRE_SEND")
    journal["assignment"] = number
    journal["pending"] = {"key": key, "time": now}  # durable before browser IO
    save_journal(journal_path, journal)
    dispatch(prompt(number, head))
    journal["sends"].append({"key": key, "time": now, "head": head})
    journal["pending"] = None
    save_journal(journal_path, journal)
    return "DISPATCHED:" + reason + ":PR#" + str(number)


def main():
    cli = argparse.ArgumentParser()
    cli.add_argument("--live", action="store_true",
                     help="Poll continuously and submit to an owner-authenticated isolated profile")
    cli.add_argument("--once", action="store_true",
                     help="One poll, dry-run unless --live was also supplied")
    args = cli.parse_args()
    if args.live:
        check_live_configuration()
    location = Path(os.environ.get("BKE_SANDBOX_JOURNAL", 
                    str(Path.home() / ".local/state/bke-worker/sandbox-f1.json")))
    location.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
    os.chmod(location.parent, 0o700)
    lock_fd = os.open(str(location) + ".lock", os.O_CREAT | os.O_RDWR, 0o600)
    try:
        fcntl.flock(lock_fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
    except BlockingIOError:
        raise Blocked("SECOND_SANDBOX_WORKER_DENIED")
    while True:
        try:
            print(tick(location, live=args.live), flush=True)
        except Blocked as error:
            print("BLOCKED:" + str(error), file=sys.stderr, flush=True)
            return 2
        if args.once:
            return 0
        time.sleep(POLL_SECONDS)


if __name__ == "__main__":
    try:
        sys.exit(main())
    except Blocked as failure:
        print("BLOCKED:" + str(failure), file=sys.stderr)
        sys.exit(2)
