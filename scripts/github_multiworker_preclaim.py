#!/usr/bin/env python3
"""SOURCE ONLY. Audit prospective worker/PR claim without making any mutation.

read_attested_sessions MUST be supplied by separately certified, private,
server-side live session attestation. Browser JSON, PR metadata, and inactive
Command Center pairing rows are NOT trusted sources of session evidence.
"""
from __future__ import annotations

from copy import deepcopy
from datetime import datetime, timezone
import re
from typing import Any, Callable

from github_complete_worker_inventory import collect_complete_open_pr_inventory
from github_multiworker_ownership import audit_multiworker_consistency

_WORKER = re.compile(r"[a-z0-9][a-z0-9-]{0,62}\Z")
_SHA = re.compile(r"[a-f0-9]{40}\Z")
_HASH = re.compile(r"[a-f0-9]{64}\Z")
_REPO = re.compile(r"[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+\Z")
_RESOURCES = (
    "identity_public_key_sha256", "chatgpt_target_sha256",
    "browser_profile_sha256", "bridge_identity_sha256", "session_binding_sha256",
)
_SESSION_FIELDS = frozenset(("worker_id", "attested_at_ms", "expires_at_ms", *_RESOURCES))
_TARGET_FIELDS = frozenset(("repository", "number", "head_sha"))


class PreclaimDenied(ValueError):
    """Bounded error; no private device/session fingerprint or GitHub token."""


def _deny(code: str) -> None:
    raise PreclaimDenied(code)


def _epoch_ms(value: Any) -> int:
    if not isinstance(value, datetime) or value.tzinfo is None or value.utcoffset() is None:
        _deny("PRECLAIM_CLOCK_INVALID")
    return int(value.astimezone(timezone.utc).timestamp() * 1000)


def _sessions(raw: Any, now_ms: int) -> list[dict[str, Any]]:
    if type(raw) is not list or len(raw) > 100:
        _deny("PRECLAIM_SESSIONS_UNAVAILABLE")
    try:
        items = deepcopy(raw)
    except Exception:
        _deny("PRECLAIM_SESSIONS_UNAVAILABLE")
    seen = set()
    normalized = []
    for row in items:
        if type(row) is not dict or row.keys() != _SESSION_FIELDS:
            _deny("PRECLAIM_SESSION_SCHEMA_INVALID")
        worker = row["worker_id"]
        if type(worker) is not str or not _WORKER.fullmatch(worker) or worker in seen:
            _deny("PRECLAIM_SESSION_WORKER_INVALID")
        seen.add(worker)
        if any(type(row[f]) is not str or not _HASH.fullmatch(row[f]) for f in _RESOURCES):
            _deny("PRECLAIM_SESSION_RESOURCE_INVALID")
        start, end = row["attested_at_ms"], row["expires_at_ms"]
        if (type(start) is not int or type(end) is not int or
                start < now_ms - 15_000 or start > now_ms + 2_000 or
                end <= now_ms or end <= start or end > start + 30_000 or
                end > now_ms + 30_000):
            _deny("PRECLAIM_SESSION_STALE_OR_FUTURE")
        normalized.append(row)
    return sorted(normalized, key=lambda row: row["worker_id"])


def _target(raw: Any, expected_repositories: list[str]) -> dict[str, Any]:
    if type(raw) is not dict or raw.keys() != _TARGET_FIELDS:
        _deny("PRECLAIM_TARGET_INVALID")
    repo, num, sha = raw["repository"], raw["number"], raw["head_sha"]
    if (type(repo) is not str or not _REPO.fullmatch(repo) or
            any(p in (".", "..") for p in repo.split("/")) or
            repo.lower() not in {r.lower() for r in expected_repositories} or
            type(num) is not int or num < 1 or
            type(sha) is not str or not _SHA.fullmatch(sha)):
        _deny("PRECLAIM_TARGET_INVALID")
    return {"repository": repo.lower(), "number": num, "head_sha": sha}


def evaluate_read_only_preclaim(
    *,
    expected_repositories: list[str],
    fetch_page: Callable,
    read_attested_sessions: Callable,
    requested_worker_id: str,
    requested_target: dict[str, Any],
    clock: Callable[[], datetime] = lambda: datetime.now(timezone.utc),
) -> dict[str, Any]:
    """Source-only consistency result; NEVER a PR/worker claim or dispatch.

    The caller MUST separately attest the real private reader, GitHub App token,
    complete repo scope and actual OS/browser session provenance. A callback
    being supplied is not proof of that trust boundary.
    """
    if (type(requested_worker_id) is not str or
            not _WORKER.fullmatch(requested_worker_id) or
            not callable(read_attested_sessions) or not callable(fetch_page) or
            not callable(clock)):
        _deny("PRECLAIM_INPUT_INVALID")
    target = _target(requested_target, expected_repositories)
    try:
        started_at = clock()
        started_ms = _epoch_ms(started_at)
        first = _sessions(read_attested_sessions(), started_ms)
    except PreclaimDenied:
        raise
    except Exception:
        _deny("PRECLAIM_SESSION_READER_UNAVAILABLE")
    try:
        inventory = collect_complete_open_pr_inventory(
            expected_repositories=expected_repositories,
            fetch_page=fetch_page,
            clock=clock,
        )
        ending_at = clock()
        ending_ms = _epoch_ms(ending_at)
        if ending_ms < started_ms or ending_ms - started_ms > 15_000:
            _deny("PRECLAIM_WINDOW_CHANGED")
        second = _sessions(read_attested_sessions(), ending_ms)
    except PreclaimDenied:
        raise
    except Exception:
        _deny("PRECLAIM_EVIDENCE_UNAVAILABLE")
    if first != second:
        _deny("PRECLAIM_SESSION_REBOUND")
    candidates = [row for row in second if row["worker_id"] == requested_worker_id]
    if len(candidates) != 1:
        _deny("PRECLAIM_WORKER_NOT_ATTESTED")
    try:
        check = audit_multiworker_consistency(
            expected_repositories=expected_repositories,
            github_snapshot=inventory,
            verified_registrations=[
                {key: row[key] for key in ("worker_id", *_RESOURCES)} for row in second
            ],
            now=ending_at,
        )
    except Exception:
        _deny("PRECLAIM_GLOBAL_OWNERSHIP_AMBIGUOUS")
    if check["state"] != "OWNERSHIP_CONSISTENT" or check["dispatch_authority"] != "NONE":
        _deny("PRECLAIM_GLOBAL_OWNERSHIP_AMBIGUOUS")
    if requested_worker_id in check["assignments"]:
        _deny("PRECLAIM_WORKER_ALREADY_ASSIGNED")
    targets = [p for p in inventory["pull_requests"] if
               p["repository"] == target["repository"] and p["number"] == target["number"]]
    if len(targets) != 1 or targets[0]["head_sha"] != target["head_sha"]:
        _deny("PRECLAIM_TARGET_CHANGED")
    if any(label["name"].lower().startswith("bke-worker:") for label in targets[0]["labels"]):
        _deny("PRECLAIM_TARGET_ALREADY_ASSIGNED")
    return {
        "state": "PRECLAIM_CONSISTENT_ONLY",
        "worker_id": requested_worker_id,
        "repository": target["repository"],
        "number": target["number"],
        "head_sha": target["head_sha"],
        "assignment_authority": "NONE",
        "dispatch_authority": "NONE",
        "wake_authority": "NONE",
        "atomicity": "NONE",
    }
