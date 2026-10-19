#!/usr/bin/env python3
"""Source-only, GitHub-native, fast-forward claim serialization contract.

This module does NOT call GitHub, authenticate the injected functions, label a
pull request, or dispatch ChatGPT. Its success never grants assignment, wake,
delivery or session authority. Future wiring requires separately certified
trusted GitHub App/server-private and browser boundaries.
"""
from __future__ import annotations

from copy import deepcopy
from hashlib import sha256
import json
import re
from typing import Any, Callable

ARBITER_REF = "refs/heads/bke/control-claims-v1"
_SHA = re.compile(r"[a-f0-9]{40}\Z")
_WORKER = re.compile(r"[a-z0-9][a-z0-9-]{0,62}\Z")
_REPO = re.compile(r"[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+\Z")
_CLAIM = re.compile(r"[a-f0-9]{32}\Z")
_MANIFEST_KEYS = frozenset({"version", "sequence", "claims"})
_ROW_KEYS = frozenset({
    "claim_id", "worker_id", "repository", "number", "head_sha",
    "state", "lease_deadline_ms",
})
_PREFLIGHT_KEYS = frozenset({
    "state", "worker_id", "repository", "number", "head_sha",
    "assignment_authority", "dispatch_authority", "wake_authority", "atomicity",
})
_PR_KEYS = frozenset({"repository", "number", "head_sha", "labels"})
_STATES = frozenset({"RESERVED", "DELIVERY_UNCERTAIN"})
MAX_CLAIMS = 100
LEASE_MS = 30_000


class ClaimDenied(ValueError):
    """Stable sanitized error; never include private session or tokens."""


def _deny(code: str) -> None:
    raise ClaimDenied(code)


def _exact(value: Any, keys: frozenset[str]) -> bool:
    return type(value) is dict and value.keys() == keys


def _identity(repo: Any, number: Any, sha: Any) -> tuple[str, int, str]:
    if (
        type(repo) is not str
        or not _REPO.fullmatch(repo)
        or any(piece in (".", "..") for piece in repo.split("/"))
        or repo != repo.lower()
        or type(number) is not int
        or number < 1
        or type(sha) is not str
        or not _SHA.fullmatch(sha)
    ):
        _deny("CLAIM_TARGET_INVALID")
    return repo, number, sha


def _worker(worker: Any) -> str:
    if type(worker) is not str or not _WORKER.fullmatch(worker):
        _deny("CLAIM_WORKER_INVALID")
    return worker


def _clock(now_ms: Any) -> int:
    if type(now_ms) is not int or now_ms < 0:
        _deny("CLAIM_CLOCK_INVALID")
    return now_ms


def validated_manifest(raw: Any) -> dict[str, Any]:
    """Validate the entire bounded reservation set; expiry never frees a key."""
    if not _exact(raw, _MANIFEST_KEYS):
        _deny("CLAIM_MANIFEST_INVALID")
    if raw["version"] != 1 or type(raw["version"]) is not int:
        _deny("CLAIM_VERSION_UNSUPPORTED")
    seq, claims = raw["sequence"], raw["claims"]
    if type(seq) is not int or seq < 0 or type(claims) is not list or len(claims) > MAX_CLAIMS:
        _deny("CLAIM_MANIFEST_INVALID")
    try:
        result = deepcopy(raw)
    except Exception:
        _deny("CLAIM_MANIFEST_INVALID")
    ids, workers, prs = set(), set(), set()
    for row in result["claims"]:
        if not _exact(row, _ROW_KEYS):
            _deny("CLAIM_ROW_INVALID")
        worker = _worker(row["worker_id"])
        repo, num, _ = _identity(row["repository"], row["number"], row["head_sha"])
        if (
            type(row["claim_id"]) is not str or not _CLAIM.fullmatch(row["claim_id"])
            or type(row["state"]) is not str or row["state"] not in _STATES
            or type(row["lease_deadline_ms"]) is not int
            or row["lease_deadline_ms"] < 0
        ):
            _deny("CLAIM_ROW_INVALID")
        if row["claim_id"] in ids or worker in workers or (repo, num) in prs:
            _deny("CLAIM_GLOBAL_CONFLICT")
        ids.add(row["claim_id"])
        workers.add(worker)
        prs.add((repo, num))
    if len(claims) > seq:
        _deny("CLAIM_MANIFEST_INVALID")
    return result


def _verified_shape_only(preflight: Any, current_pr: Any) -> tuple[str, str, int, str]:
    """Preclaim formatting is NOT authentic session/installation attestation."""
    if not _exact(preflight, _PREFLIGHT_KEYS):
        _deny("CLAIM_PREFLIGHT_INVALID")
    if (
        preflight["state"] != "PRECLAIM_CONSISTENT_ONLY"
        or any(preflight[field] != "NONE" for field in
               ("assignment_authority", "dispatch_authority", "wake_authority", "atomicity"))
    ):
        _deny("CLAIM_PREFLIGHT_INVALID")
    worker = _worker(preflight["worker_id"])
    repo, num, sha = _identity(
        preflight["repository"], preflight["number"], preflight["head_sha"]
    )
    if not _exact(current_pr, _PR_KEYS):
        _deny("CLAIM_PR_OBSERVATION_INVALID")
    if _identity(current_pr["repository"], current_pr["number"], current_pr["head_sha"]) != (
        repo, num, sha
    ):
        _deny("CLAIM_PR_CHANGED")
    labels = current_pr["labels"]
    if type(labels) is not list or len(labels) > 200:
        _deny("CLAIM_PR_LABELS_INVALID")
    seen = set()
    for label in labels:
        if type(label) is not str or not label or len(label) > 100:
            _deny("CLAIM_PR_LABELS_INVALID")
        lowered = label.lower()
        if lowered in seen:
            _deny("CLAIM_PR_LABELS_INVALID")
        seen.add(lowered)
        if lowered.startswith("bke-worker:"):
            _deny("CLAIM_PR_ALREADY_ASSIGNED")
    return worker, repo, num, sha


def prepare_reservation(
    *, manifest: dict[str, Any], preflight: dict[str, Any],
    current_pr: dict[str, Any], expected_labels: list[str], now_ms: int,
) -> tuple[dict[str, Any], str]:
    """Pure plan. Caller must prove all external freshness/trust independently.

    No GitHub, label or ChatGPT side effect is made by this function.
    """
    _clock(now_ms)
    old = validated_manifest(manifest)
    worker, repo, number, head = _verified_shape_only(preflight, current_pr)
    if (type(expected_labels) is not list or
            any(type(label) is not str for label in expected_labels)):
        _deny("CLAIM_PR_LABELS_INVALID")
    if sorted(expected_labels) != sorted(current_pr["labels"]):
        _deny("CLAIM_PR_LABELS_CHANGED")
    if len(old["claims"]) >= MAX_CLAIMS:
        _deny("CLAIM_CAPACITY_REQUIRES_OWNER_RECOVERY")
    for row in old["claims"]:
        if row["worker_id"] == worker or (row["repository"], row["number"]) == (repo, number):
            _deny("CLAIM_BUSY_OR_RECOVERY_REQUIRED")
    seq = old["sequence"] + 1
    identity = json.dumps([seq, worker, repo, number, head], separators=(",", ":"))
    claim_id = sha256(identity.encode("ascii")).hexdigest()[:32]
    old["sequence"] = seq
    old["claims"].append({
        "claim_id": claim_id, "worker_id": worker, "repository": repo,
        "number": number, "head_sha": head, "state": "RESERVED",
        "lease_deadline_ms": now_ms + LEASE_MS,
    })
    return validated_manifest(old), claim_id


def fence_uncertain_delivery(
    *, manifest: dict[str, Any], claim_id: str, now_ms: int,
) -> dict[str, Any]:
    """Must be durably published BEFORE an external delivery attempt.

    Publishing a fence alone never authorizes delivery. Once fenced, any
    uncertainty including no attempted send requires explicit owner recovery.
    """
    _clock(now_ms)
    value = validated_manifest(manifest)
    if type(claim_id) is not str or not _CLAIM.fullmatch(claim_id):
        _deny("CLAIM_ID_INVALID")
    matching = [row for row in value["claims"] if row["claim_id"] == claim_id]
    if len(matching) != 1:
        _deny("CLAIM_NOT_FOUND")
    row = matching[0]
    if row["state"] != "RESERVED" or now_ms >= row["lease_deadline_ms"]:
        _deny("CLAIM_RECOVERY_REQUIRED")
    value["sequence"] += 1
    row["state"] = "DELIVERY_UNCERTAIN"
    return validated_manifest(value)


def _validate_successor(parent: Any, proposal: Any) -> dict[str, Any]:
    """Allow only one append or one irreversible delivery uncertainty fence.

    Fast-forward ancestry alone does not prove a child preserves existing
    reservations. An authorized future writer must also enforce transitions.
    This source-only check does not authenticate the writer or external input.
    """
    previous = validated_manifest(parent)
    candidate = validated_manifest(proposal)
    if candidate["sequence"] != previous["sequence"] + 1:
        _deny("CLAIM_TRANSITION_INVALID")
    before, after = previous["claims"], candidate["claims"]
    if len(after) == len(before) + 1:
        if after[:-1] != before or after[-1]["state"] != "RESERVED":
            _deny("CLAIM_TRANSITION_INVALID")
    elif len(after) == len(before):
        changed = 0
        for old_row, new_row in zip(before, after):
            if old_row == new_row:
                continue
            expected = dict(old_row)
            expected["state"] = "DELIVERY_UNCERTAIN"
            if old_row["state"] != "RESERVED" or new_row != expected:
                _deny("CLAIM_TRANSITION_INVALID")
            changed += 1
        if changed != 1:
            _deny("CLAIM_TRANSITION_INVALID")
    else:
        _deny("CLAIM_TRANSITION_INVALID")
    return candidate


def publish_by_fast_forward(
    *,
    expected_head: str,
    proposed_manifest: dict[str, Any],
    create_child_commit: Callable[[str, dict[str, Any]], str],
    inspect_commit: Callable[[str], dict[str, Any]],
    update_ref_nonforce: Callable[[str], bool],
    read_ref: Callable[[], str],
) -> dict[str, str]:
    """Source-only transport protocol. Real adapter MUST PATCH force:false.

    A commit with exactly expected_head as its sole parent cannot update a
    ref already advanced to a sibling by normal GitHub fast-forward rules.
    The callbacks here are fixtures/untrusted until server-private certified.
    A lost response is *unknown*, not a successful claim or safe retry.
    """
    if type(expected_head) is not str or not _SHA.fullmatch(expected_head):
        _deny("CLAIM_ARBITER_HEAD_INVALID")
    validated_manifest(proposed_manifest)
    if not all(callable(fn) for fn in (
        create_child_commit, inspect_commit, update_ref_nonforce, read_ref,
    )):
        _deny("CLAIM_TRANSPORT_INVALID")
    try:
        if read_ref() != expected_head:
            _deny("CLAIM_ARBITER_MOVED")
        parent_commit = inspect_commit(expected_head)
        if not _exact(parent_commit, frozenset({"parents", "manifest"})):
            _deny("CLAIM_PARENT_INVALID")
        # Enforce append-only reservations / irreversible uncertainty fences.
        # A valid descendant is not sufficient if it deletes an older claim.
        _validate_successor(parent_commit["manifest"], proposed_manifest)
        new_head = create_child_commit(expected_head, deepcopy(proposed_manifest))
        if type(new_head) is not str or not _SHA.fullmatch(new_head) or new_head == expected_head:
            _deny("CLAIM_CHILD_INVALID")
        commit = inspect_commit(new_head)
        if (
            not _exact(commit, frozenset({"parents", "manifest"}))
            or commit["parents"] != [expected_head]
            or validated_manifest(commit["manifest"]) != proposed_manifest
        ):
            _deny("CLAIM_CHILD_INVALID")
        # This exact function MUST be implemented using GitHub REST
        # PATCH /repos/{owner}/{repo}/git/refs/heads/bke/control-claims-v1
        # {"sha":new_head,"force":false}. No force-with-lease fallback.
        if update_ref_nonforce(new_head) is not True:
            _deny("CLAIM_REF_UPDATE_UNCERTAIN")
        if read_ref() != new_head:
            _deny("CLAIM_REF_UPDATE_UNCERTAIN")
    except ClaimDenied:
        raise
    except Exception:
        _deny("CLAIM_REF_UPDATE_UNCERTAIN")
    return {
        "state": "RESERVATION_RECORDED_ONLY",
        "arbiter_ref": ARBITER_REF,
        "arbiter_head": new_head,
        "assignment_authority": "NONE",
        "dispatch_authority": "NONE",
        "wake_authority": "NONE",
    }
