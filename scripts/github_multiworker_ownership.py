#!/usr/bin/env python3
"""Pure, SOURCE-ONLY global worker ownership collision audit.

This module does NOT fetch GitHub or attest registration provenance. Its caller
must independently authenticate a complete GitHub App installation inventory
and separately verified Command Center resource registrations. Positive output
is ONLY internal consistency, never worker availability/dispatch authority.
"""
from __future__ import annotations

from datetime import datetime, timedelta, timezone
import re
from typing import Any

_SHA = re.compile(r"[0-9a-f]{40}\Z")
_HEX = re.compile(r"[0-9a-f]{64}\Z")
_WORKER = re.compile(r"[a-z0-9][a-z0-9-]{0,62}\Z")
_REPOSITORY = re.compile(r"[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+\Z")
_RESOURCES = (
    "identity_public_key_sha256",
    "chatgpt_target_sha256",
    "browser_profile_sha256",
    "bridge_identity_sha256",
    "session_binding_sha256",
)
_REG_FIELDS = frozenset(("worker_id", *_RESOURCES))
_PR_FIELDS = frozenset(("repository", "number", "state", "head_sha", "labels"))
_SCAN_FIELDS = frozenset(("complete", "observed_at", "repositories", "pull_requests"))
MAX_SNAPSHOT_AGE = timedelta(seconds=60)
MAX_CLOCK_SKEW = timedelta(seconds=5)


class OwnershipAuditError(ValueError):
    """Sanitized fail-closed signal: no browser/resource fingerprint output."""


def _deny(code: str) -> None:
    raise OwnershipAuditError(code)


def _exact(value: Any, fields: frozenset[str]) -> bool:
    return type(value) is dict and value.keys() == fields


def _hex(value: Any) -> bool:
    return type(value) is str and _HEX.fullmatch(value) is not None


def _repo_names(value: Any) -> tuple[str, ...]:
    if type(value) is not list or not value:
        _deny("REPOSITORY_SCOPE_INVALID")
    names = []
    for name in value:
        if type(name) is not str or not _REPOSITORY.fullmatch(name):
            _deny("REPOSITORY_SCOPE_INVALID")
        names.append(name.lower())
    if len(set(names)) != len(names):
        _deny("REPOSITORY_SCOPE_DUPLICATE")
    return tuple(sorted(names))


def _fresh_snapshot_time(value: Any, now: datetime) -> None:
    if type(value) is not str:
        _deny("GITHUB_SNAPSHOT_TIME_INVALID")
    try:
        seen = datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError:
        _deny("GITHUB_SNAPSHOT_TIME_INVALID")
    if seen.tzinfo is None or seen.utcoffset() is None:
        _deny("GITHUB_SNAPSHOT_TIME_INVALID")
    seen = seen.astimezone(timezone.utc)
    if seen < now - MAX_SNAPSHOT_AGE or seen > now + MAX_CLOCK_SKEW:
        _deny("GITHUB_SNAPSHOT_STALE_OR_FUTURE")


def _worker_label(labels: Any) -> str | None:
    if type(labels) is not list:
        _deny("PR_LABELS_INVALID")
    ownership = []
    seen = set()
    for label in labels:
        if type(label) is not dict or set(label) != {"name"} or type(label["name"]) is not str:
            _deny("PR_LABELS_INVALID")
        name = label["name"]
        if not name or name.lower() in seen:
            _deny("PR_LABELS_DUPLICATE_OR_INVALID")
        seen.add(name.lower())
        if name.lower().startswith("bke-worker:"):
            worker = name.removeprefix("bke-worker:")
            if not _WORKER.fullmatch(worker) or name != f"bke-worker:{worker}":
                _deny("PR_WORKER_ID_INVALID")
            ownership.append(worker)
    if len(ownership) > 1:
        _deny("PR_MULTIPLE_WORKER_LABELS")
    return ownership[0] if ownership else None


def audit_multiworker_consistency(
    *,
    expected_repositories: list[str],
    github_snapshot: dict[str, Any],
    verified_registrations: list[dict[str, Any]],
    now: datetime | None = None,
) -> dict[str, Any]:
    """Inspect a trusted caller's complete observation without changing state.

    This function cannot prove that its caller actually trusted GitHub or the
    device enrollment gateway. Do not feed browser assertions or PR body claims
    as verified_registrations, and do not interpret output as liveness.
    """
    moment = datetime.now(timezone.utc) if now is None else now
    if not isinstance(moment, datetime) or moment.tzinfo is None or moment.utcoffset() is None:
        _deny("AUDIT_CLOCK_INVALID")
    moment = moment.astimezone(timezone.utc)
    expected = _repo_names(expected_repositories)
    if not _exact(github_snapshot, _SCAN_FIELDS) or github_snapshot["complete"] is not True:
        _deny("GITHUB_INVENTORY_INCOMPLETE")
    if _repo_names(github_snapshot["repositories"]) != expected:
        _deny("GITHUB_REPOSITORY_SCOPE_MISMATCH")
    _fresh_snapshot_time(github_snapshot["observed_at"], moment)
    items = github_snapshot["pull_requests"]
    if type(items) is not list or type(verified_registrations) is not list:
        _deny("GITHUB_OR_REGISTRATION_PAYLOAD_INVALID")

    registrations = {}
    resource_owners: dict[tuple[str, str], str] = {}
    for registration in verified_registrations:
        if not _exact(registration, _REG_FIELDS):
            _deny("REGISTRATION_SCHEMA_INVALID")
        worker = registration["worker_id"]
        if type(worker) is not str or not _WORKER.fullmatch(worker):
            _deny("REGISTRATION_WORKER_INVALID")
        if worker in registrations:
            _deny("REGISTRATION_DUPLICATE_WORKER")
        if any(not _hex(registration[field]) for field in _RESOURCES):
            _deny("REGISTRATION_RESOURCE_INVALID")
        for field in _RESOURCES:
            key = (field, registration[field])
            if key in resource_owners and resource_owners[key] != worker:
                _deny("CROSS_WORKER_RESOURCE_COLLISION")
            resource_owners[key] = worker
        registrations[worker] = registration

    seen_prs: set[tuple[str, int]] = set()
    assigned = {}
    for pr in items:
        if not _exact(pr, _PR_FIELDS):
            _deny("GITHUB_PR_SCHEMA_INVALID")
        repository = pr["repository"]
        if type(repository) is not str or not _REPOSITORY.fullmatch(repository):
            _deny("GITHUB_PR_REPOSITORY_INVALID")
        repository = repository.lower()
        if repository not in expected:
            _deny("GITHUB_PR_OUTSIDE_SCOPE")
        number = pr["number"]
        if type(number) is not int or number <= 0:
            _deny("GITHUB_PR_NUMBER_INVALID")
        identity = (repository, number)
        if identity in seen_prs:
            _deny("GITHUB_PR_DUPLICATE")
        seen_prs.add(identity)
        if pr["state"] != "open":
            _deny("GITHUB_SNAPSHOT_NONOPEN_PR")
        if type(pr["head_sha"]) is not str or not _SHA.fullmatch(pr["head_sha"]):
            _deny("GITHUB_PR_HEAD_INVALID")
        worker = _worker_label(pr["labels"])
        if worker is None:
            continue
        if worker in assigned:
            _deny("WORKER_MULTIPLE_ACTIVE_PRS")
        if worker not in registrations:
            _deny("ASSIGNED_WORKER_UNVERIFIED")
        assigned[worker] = {
            "repository": repository,
            "number": number,
            "head_sha": pr["head_sha"],
        }
    return {
        "state": "OWNERSHIP_CONSISTENT",
        "dispatch_authority": "NONE",
        "wake_authority": "NONE",
        "worker_liveness": "UNKNOWN",
        "scanned_repositories": len(expected),
        "open_pull_requests": len(seen_prs),
        "assigned_workers": len(assigned),
        "assignments": {w: assigned[w] for w in sorted(assigned)},
    }
