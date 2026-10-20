#!/usr/bin/env python3
"""F1-02 first-send ledger schema/transition checks for ONE shared GitHub ref.

Pure validation and proposal only. The dormant fixed GitHub REST adapter owns
publication. No browser, service principal, PR label, or send is authorized.
"""
from __future__ import annotations

from copy import deepcopy
from datetime import datetime
import re
from typing import Any

from github_atomic_claim import ClaimDenied, _validate_successor, validated_manifest

_SHA = re.compile(r"[a-f0-9]{40}\Z")
_HEX256 = re.compile(r"[a-f0-9]{64}\Z")
_ID = re.compile(r"[A-Za-z0-9_-]{8,128}\Z")
_ATTEMPT = re.compile(r"[a-z0-9][a-z0-9-]{0,95}\Z")
_ISO = re.compile(r"\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z\Z")
_ROW_KEYS = frozenset({
    "attempt_id", "worker_id", "repository", "number", "head_sha",
    "worker_claim_id", "target_sha256", "profile_sha256", "tab_id",
    "execution_id", "fence_id", "state", "fence_snapshot_sha",
    "send_claim_id", "claimed_at",
})
_LEDGER_KEYS = frozenset({"version", "sequence", "claims", "attempts"})
_STATES = frozenset({"FENCED_READY_TO_SEND", "FENCED_MAY_HAVE_SENT"})
MAX_ATTEMPTS = 64


class FirstSendLedgerDenied(ValueError):
    """Sanitized deny result without target/profile material."""


def _deny(code: str) -> None:
    raise FirstSendLedgerDenied(code)


def _string(pattern, value: Any) -> bool:
    return type(value) is str and pattern.fullmatch(value) is not None


def _clock(value: Any) -> bool:
    if not _string(_ISO, value):
        return False
    try:
        return datetime.fromisoformat(value.replace("Z", "+00:00")).isoformat(
            timespec="milliseconds").replace("+00:00", "Z") == value
    except ValueError:
        return False


def validated_ledger(raw: Any) -> dict[str, Any]:
    """Validate v2 for future use; read legacy v1 without silently migrating.

    v2 lives in the SAME fixed claims-v1.json on the SAME single Git ref.
    There is no second branch/queue/database. No v1->v2 wire migration here.
    """
    if type(raw) is not dict:
        _deny("F1_LEDGER_INVALID")
    if raw.get("version") == 1:
        try:
            return validated_manifest(raw)
        except ClaimDenied:
            _deny("F1_LEDGER_INVALID")
    if raw.keys() != _LEDGER_KEYS or type(raw.get("version")) is not int or raw["version"] != 2:
        _deny("F1_LEDGER_INVALID")
    seq, claims, attempts = raw["sequence"], raw["claims"], raw["attempts"]
    if (type(seq) is not int or seq < 0 or type(attempts) is not list
            or len(attempts) > MAX_ATTEMPTS):
        _deny("F1_LEDGER_INVALID")
    try:
        validated_manifest({"version": 1, "sequence": seq, "claims": claims})
    except ClaimDenied:
        _deny("F1_LEDGER_CLAIMS_INVALID")
    if len(attempts) > seq:
        _deny("F1_LEDGER_INVALID")
    seen_ids, seen_claims, seen_send_ids = set(), set(), set()
    by_claim = {c["claim_id"]: c for c in claims}
    for item in attempts:
        if type(item) is not dict or item.keys() != _ROW_KEYS:
            _deny("F1_ATTEMPT_ROW_INVALID")
        worker = by_claim.get(item["worker_claim_id"]) if type(item["worker_claim_id"]) is str else None
        if (worker is None or worker["state"] != "RESERVED" or
                any(item[k] != worker[k] for k in
                    ("worker_id", "repository", "number", "head_sha"))):
            _deny("F1_ATTEMPT_WORKER_CLAIM_INVALID")
        if (not _string(_ATTEMPT, item["attempt_id"]) or
                not _string(_HEX256, item["target_sha256"]) or
                not _string(_HEX256, item["profile_sha256"]) or
                type(item["tab_id"]) is not int or item["tab_id"] < 0 or
                not _string(_ID, item["execution_id"]) or
                not _string(_ID, item["fence_id"]) or
                type(item["state"]) is not str or item["state"] not in _STATES):
            _deny("F1_ATTEMPT_ROW_INVALID")
        if (item["attempt_id"] in seen_ids or
                item["worker_claim_id"] in seen_claims):
            _deny("F1_ATTEMPT_REPLAY")
        seen_ids.add(item["attempt_id"])
        seen_claims.add(item["worker_claim_id"])
        if item["state"] == "FENCED_READY_TO_SEND":
            if any(item[k] is not None for k in
                   ("fence_snapshot_sha", "send_claim_id", "claimed_at")):
                _deny("F1_ATTEMPT_PHASE_INVALID")
        else:
            if (not _string(_SHA, item["fence_snapshot_sha"]) or
                    not _string(_ID, item["send_claim_id"]) or
                    not _clock(item["claimed_at"])):
                _deny("F1_ATTEMPT_PHASE_INVALID")
            if item["send_claim_id"] in seen_send_ids:
                _deny("F1_SEND_CLAIM_REPLAY")
            seen_send_ids.add(item["send_claim_id"])
    return deepcopy(raw)


def append_first_send_fence(ledger: dict, *, attempt_id: str,
                            worker_claim_id: str, target_sha256: str,
                            profile_sha256: str, tab_id: int, execution_id: str,
                            fence_id: str) -> dict:
    """Propose durable PRE-SEND fence; must be published/read back before CAS."""
    old = validated_ledger(ledger)
    if old["version"] != 2:
        _deny("F1_LEDGER_V2_REQUIRED")
    claim = next((c for c in old["claims"] if c["claim_id"] == worker_claim_id), None)
    if claim is None or claim["state"] != "RESERVED":
        _deny("F1_ATTEMPT_WORKER_CLAIM_INVALID")
    out = deepcopy(old)
    out["sequence"] += 1
    out["attempts"].append({
        "attempt_id": attempt_id, "worker_id": claim["worker_id"],
        "repository": claim["repository"], "number": claim["number"],
        "head_sha": claim["head_sha"], "worker_claim_id": worker_claim_id,
        "target_sha256": target_sha256, "profile_sha256": profile_sha256,
        "tab_id": tab_id, "execution_id": execution_id, "fence_id": fence_id,
        "state": "FENCED_READY_TO_SEND", "fence_snapshot_sha": None,
        "send_claim_id": None, "claimed_at": None,
    })
    return validated_ledger(out)


def consume_first_send_claim(ledger: dict, *, attempt_id: str,
                              expected_parent_sha: str,
                              send_claim_id: str, claimed_at: str) -> dict:
    """Irreversibly consume one opportunity; never a browser-send permit."""
    old = validated_ledger(ledger)
    if old["version"] != 2:
        _deny("F1_LEDGER_V2_REQUIRED")
    matches = [row for row in old["attempts"] if row["attempt_id"] == attempt_id]
    if len(matches) != 1 or matches[0]["state"] != "FENCED_READY_TO_SEND":
        _deny("F1_SEND_ALREADY_CONSUMED")
    if not _string(_SHA, expected_parent_sha) or not _string(_ID, send_claim_id) or not _clock(claimed_at):
        _deny("F1_SEND_CLAIM_INVALID")
    out = deepcopy(old)
    out["sequence"] += 1
    row = next(r for r in out["attempts"] if r["attempt_id"] == attempt_id)
    row.update({
        "state": "FENCED_MAY_HAVE_SENT",
        # This is the exact observed GitHub ref commit containing the fence.
        "fence_snapshot_sha": expected_parent_sha,
        "send_claim_id": send_claim_id,
        "claimed_at": claimed_at,
    })
    return validated_ledger(out)


def validate_ledger_successor(parent: Any, proposed: Any, *, expected_parent_sha: str) -> dict:
    """One and only one transition in the shared GitHub ref commit.

    v1 -> v2 is NEVER implicitly permitted. Explicit owner-controlled v2
    migration/installation and actual provider principal are separate gates.
    """
    if not _string(_SHA, expected_parent_sha):
        _deny("F1_LEDGER_PARENT_SHA_INVALID")
    before, after = validated_ledger(parent), validated_ledger(proposed)
    if before["version"] != after["version"]:
        _deny("F1_LEDGER_MIGRATION_NOT_AUTHORIZED")
    if before["version"] == 1:
        try:
            return _validate_successor(before, after)
        except ClaimDenied:
            _deny("F1_LEDGER_TRANSITION_INVALID")
    if after["sequence"] != before["sequence"] + 1:
        _deny("F1_LEDGER_TRANSITION_INVALID")
    previous_claims, next_claims = before["claims"], after["claims"]
    old_attempts, new_attempts = before["attempts"], after["attempts"]
    if next_claims != previous_claims:
        if old_attempts != new_attempts:
            _deny("F1_LEDGER_TRANSITION_INVALID")
        try:
            _validate_successor(
                {"version": 1, "sequence": before["sequence"], "claims": previous_claims},
                {"version": 1, "sequence": after["sequence"], "claims": next_claims},
            )
        except ClaimDenied:
            _deny("F1_LEDGER_TRANSITION_INVALID")
    elif len(new_attempts) == len(old_attempts) + 1:
        if new_attempts[:-1] != old_attempts or new_attempts[-1]["state"] != "FENCED_READY_TO_SEND":
            _deny("F1_LEDGER_TRANSITION_INVALID")
    elif len(new_attempts) == len(old_attempts):
        changes = 0
        for old, new in zip(old_attempts, new_attempts):
            if old == new:
                continue
            allowed = dict(old)
            if old["state"] != "FENCED_READY_TO_SEND":
                _deny("F1_LEDGER_TRANSITION_INVALID")
            allowed["state"] = "FENCED_MAY_HAVE_SENT"
            allowed["fence_snapshot_sha"] = expected_parent_sha
            allowed["send_claim_id"] = new["send_claim_id"]
            allowed["claimed_at"] = new["claimed_at"]
            if new != allowed:
                _deny("F1_LEDGER_TRANSITION_INVALID")
            changes += 1
        if changes != 1:
            _deny("F1_LEDGER_TRANSITION_INVALID")
    else:
        _deny("F1_LEDGER_TRANSITION_INVALID")
    return after
