#!/usr/bin/env python3
"""Adversarial F1-02 v2 send-once ledger; local only, no GitHub mutation."""
from __future__ import annotations

from copy import deepcopy
from datetime import datetime
from pathlib import Path
import sys
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "scripts"))
from github_atomic_claim import prepare_reservation
from github_f1_first_send_ledger import (
    FirstSendLedgerDenied, append_first_send_fence, consume_first_send_claim,
    confirm_new_conversation, validate_ledger_successor, validated_ledger,
)
from github_f1_private_arbiter_writer import GitHubAppArbiterWriter, GitHubWriterDenied, canonical, blob_sha
from github_f1_private_arbiter_writer_contract import FakeProvider, TOKEN
from unittest.mock import patch

PR_HEAD = "a" * 40
FENCE_HEAD = "f" * 40
TIME = "2026-10-20T06:00:00.000Z"
CLAIM_NOW_MS = int(datetime.fromisoformat(
    TIME.replace("Z", "+00:00")).timestamp() * 1000)
SEND_NOW_MS = CLAIM_NOW_MS + 1_000
FENCE_ID = "fence-123456"
SEND_CLAIM_ID = "send-1234567"


def base():
    preflight = {
        "state": "PRECLAIM_CONSISTENT_ONLY", "worker_id": "f1",
        "repository": "jan2xo/bke-worker", "number": 122,
        "head_sha": PR_HEAD, "assignment_authority": "NONE",
        "dispatch_authority": "NONE", "wake_authority": "NONE",
        "atomicity": "NONE",
    }
    observed = {
        "repository": preflight["repository"], "number": preflight["number"],
        "head_sha": preflight["head_sha"], "labels": [],
    }
    claim, claim_id = prepare_reservation(
        manifest={"version": 1, "sequence": 0, "claims": []},
        preflight=preflight, current_pr=observed,
        expected_labels=[], now_ms=CLAIM_NOW_MS,
    )
    ledger = {"version": 2, "sequence": claim["sequence"],
              "claims": claim["claims"], "attempts": []}
    return ledger, claim_id


def prepared():
    ledger, worker_claim_id = base()
    return ledger, append_first_send_fence(
        ledger, attempt_id="attempt-f1-01",
        worker_claim_id=worker_claim_id,
        target_sha256="a" * 64, profile_sha256="b" * 64,
        tab_id=17, execution_id="execution-12345678",
        fence_id=FENCE_ID,
     now_ms=SEND_NOW_MS)


def consumed():
    base_ledger, fence = prepared()
    sent = consume_first_send_claim(
        fence, attempt_id="attempt-f1-01",
        expected_parent_sha=FENCE_HEAD,
        send_claim_id=SEND_CLAIM_ID, claimed_at=TIME,
     now_ms=SEND_NOW_MS)
    return base_ledger, fence, sent


class FirstSendLedgerTests(unittest.TestCase):
    def denied(self, code, op):
        with self.assertRaisesRegex(FirstSendLedgerDenied, "^" + code + "$"):
            op()

    def test_expired_send_lease_denies_new_fence_and_consumption(self):
        ledger, claim_id = base()
        expires = ledger["claims"][0]["lease_deadline_ms"]
        self.assertEqual(expires, CLAIM_NOW_MS + 30_000)
        args = dict(attempt_id="attempt-lease-01", worker_claim_id=claim_id,
                    target_sha256="a" * 64, profile_sha256="b" * 64,
                    tab_id=1, execution_id="execution-lease-1234",
                    fence_id="fence-lease-12345")
        self.denied("F1_ATTEMPT_LEASE_EXPIRED", lambda:
                    append_first_send_fence(ledger, now_ms=expires, **args))
        self.denied("F1_ATTEMPT_CLOCK_INVALID", lambda:
                    append_first_send_fence(ledger, now_ms=True, **args))
        fence = append_first_send_fence(
            ledger, now_ms=expires - 1, **args)
        self.denied("F1_ATTEMPT_LEASE_EXPIRED", lambda:
                    consume_first_send_claim(
                        fence, attempt_id="attempt-lease-01",
                        expected_parent_sha=FENCE_HEAD,
                        send_claim_id="send-lease-12345",
                        claimed_at=TIME, now_ms=expires))
        self.denied("F1_ATTEMPT_CLOCK_INVALID", lambda:
                    consume_first_send_claim(
                        fence, attempt_id="attempt-lease-01",
                        expected_parent_sha=FENCE_HEAD,
                        send_claim_id="send-lease-12345",
                        claimed_at=TIME, now_ms=-1))
        valid = consume_first_send_claim(
            fence, attempt_id="attempt-lease-01",
            expected_parent_sha=FENCE_HEAD,
            send_claim_id="send-lease-12345",
            claimed_at=TIME, now_ms=expires - 1)
        self.assertEqual(valid["attempts"][0]["state"], "FENCED_MAY_HAVE_SENT")
        self.assertEqual(validate_ledger_successor(
            fence, valid, expected_parent_sha=FENCE_HEAD), valid)
        # Expiry is NOT release: the original reservation and its resources
        # remain occupied and must never be reclaimed from local clock alone.
        self.assertEqual(ledger["claims"][0]["state"], "RESERVED")
        self.assertEqual(ledger["claims"][0]["lease_deadline_ms"], expires)

    def test_v1_existing_claim_reader_works_but_no_implicit_v2_migration(self):
        ledger, _ = base()
        legacy = {"version": 1, "sequence": ledger["sequence"],
                  "claims": deepcopy(ledger["claims"])}
        self.assertEqual(validated_ledger(legacy), legacy)
        self.denied("F1_LEDGER_MIGRATION_NOT_AUTHORIZED", lambda:
                    validate_ledger_successor(legacy, ledger,
                                             expected_parent_sha=FENCE_HEAD))

    def test_distinct_workers_cannot_reuse_target_or_profile_commitment(self):
        # Distinct RESERVED GitHub claims for separate workers/PRs may coexist,
        # but cannot reserve one browser profile or ChatGPT target fingerprint.
        ledger, claim_one = base()
        preflight = {
            "state": "PRECLAIM_CONSISTENT_ONLY", "worker_id": "f2",
            "repository": "jan2xo/bke-worker", "number": 123,
            "head_sha": "b" * 40, "assignment_authority": "NONE",
            "dispatch_authority": "NONE", "wake_authority": "NONE",
            "atomicity": "NONE",
        }
        observed = {
            "repository": preflight["repository"], "number": 123,
            "head_sha": preflight["head_sha"], "labels": [],
        }
        other, claim_two = prepare_reservation(
            manifest={"version": 1, "sequence": ledger["sequence"],
                      "claims": ledger["claims"]},
            preflight=preflight, current_pr=observed,
            expected_labels=[], now_ms=CLAIM_NOW_MS + 1,
        )
        both = {"version": 2, "sequence": other["sequence"],
                "claims": other["claims"], "attempts": []}
        first = append_first_send_fence(
            both, attempt_id="attempt-first-01", worker_claim_id=claim_one,
            target_sha256="a" * 64, profile_sha256="b" * 64,
            tab_id=17, execution_id="execution-first-1234",
            fence_id="fence-first-12345",
         now_ms=SEND_NOW_MS)
        def second(target, profile):
            return append_first_send_fence(
                first, attempt_id="attempt-second-01", worker_claim_id=claim_two,
                target_sha256=target, profile_sha256=profile,
                tab_id=18, execution_id="execution-second-1234",
                fence_id="fence-second-12345",
             now_ms=SEND_NOW_MS)
        self.denied("F1_ATTEMPT_RESOURCE_CONFLICT",
                    lambda: second("a" * 64, "d" * 64))
        self.denied("F1_ATTEMPT_RESOURCE_CONFLICT",
                    lambda: second("c" * 64, "b" * 64))
        self.denied("F1_ATTEMPT_RESOURCE_CONFLICT",
                    lambda: second("a" * 64, "b" * 64))
        allowed = second("c" * 64, "d" * 64)
        self.assertEqual(len(allowed["attempts"]), 2)
        self.assertEqual(validate_ledger_successor(
            first, allowed, expected_parent_sha=FENCE_HEAD), allowed)

    def test_confirmed_attempt_fence_and_execution_ids_cannot_be_reused(self):
        _, _, consumed_claim = consumed()
        confirmed = confirm_new_conversation(
            consumed_claim, attempt_id="attempt-f1-01",
            conversation_id="conversation-first-123", confirmed_at=TIME)
        existing = confirmed["attempts"][0]
        args = dict(
            attempt_id="attempt-f1-02",
            worker_claim_id=existing["worker_claim_id"],
            target_sha256=existing["target_sha256"],
            profile_sha256=existing["profile_sha256"],
            tab_id=18,
            execution_id="execution-fresh-2345",
            fence_id="fence-fresh-234567",
        )
        # Reusing either original identity after full confirmation was
        # previously accepted, undermining cross-attempt replay isolation.
        for key in ("fence_id", "execution_id"):
            reused = dict(args, **{key: existing[key]})
            self.denied("F1_ATTEMPT_IDENTITY_REPLAY",
                        lambda reused=reused: append_first_send_fence(
                            confirmed, **reused, now_ms=SEND_NOW_MS))
        valid = append_first_send_fence(confirmed, **args, now_ms=SEND_NOW_MS)
        self.assertEqual(len(valid["attempts"]), 2)
        self.assertEqual(validate_ledger_successor(
            confirmed, valid, expected_parent_sha=FENCE_HEAD), valid)
        # Validator, not merely the proposal helper, must deny a history
        # graft with a duplicated one-shot identifier.
        for key in ("fence_id", "execution_id"):
            graft = deepcopy(valid)
            graft["attempts"][1][key] = existing[key]
            self.denied("F1_ATTEMPT_IDENTITY_REPLAY",
                        lambda graft=graft: validated_ledger(graft))

    def test_fence_requires_existing_reserved_worker_claim(self):
        ledger, claim = base()
        self.denied("F1_ATTEMPT_WORKER_CLAIM_INVALID", lambda:
                    append_first_send_fence(
                        ledger, attempt_id="attempt-f1-01",
                        worker_claim_id="0" * 32,
                        target_sha256="a" * 64, profile_sha256="b" * 64,
                        tab_id=1, execution_id="execution-12345", fence_id=FENCE_ID, now_ms=SEND_NOW_MS))
        self.assertEqual(len(ledger["attempts"]), 0)
        fence = append_first_send_fence(
            ledger, attempt_id="attempt-f1-01", worker_claim_id=claim,
            target_sha256="a" * 64, profile_sha256="b" * 64, tab_id=17,
            execution_id="execution-12345678", fence_id=FENCE_ID, now_ms=SEND_NOW_MS)
        self.assertEqual(fence["attempts"][0]["state"], "FENCED_READY_TO_SEND")

    def test_fence_append_requires_one_sequence_increment_and_no_claim_mutation(self):
        ledger, fence = prepared()
        self.assertEqual(validate_ledger_successor(
            ledger, fence, expected_parent_sha=PR_HEAD), fence)
        malicious = deepcopy(fence)
        malicious["claims"][0]["head_sha"] = "f" * 40
        self.denied("F1_ATTEMPT_WORKER_CLAIM_INVALID", lambda:
                    validate_ledger_successor(ledger, malicious,
                                              expected_parent_sha=PR_HEAD))
        malicious = deepcopy(fence)
        malicious["sequence"] += 1
        self.denied("F1_LEDGER_TRANSITION_INVALID", lambda:
                    validate_ledger_successor(ledger, malicious,
                                              expected_parent_sha=PR_HEAD))

    def test_consume_is_irreversible_and_exact_snapshot_bound(self):
        _, fence, used = consumed()
        self.assertEqual(validate_ledger_successor(
            fence, used, expected_parent_sha=FENCE_HEAD), used)
        self.assertEqual(used["attempts"][0]["state"], "FENCED_MAY_HAVE_SENT")
        self.assertEqual(used["attempts"][0]["fence_snapshot_sha"], FENCE_HEAD)
        self.denied("F1_SEND_ALREADY_CONSUMED", lambda:
                    consume_first_send_claim(
                        used, attempt_id="attempt-f1-01",
                        expected_parent_sha=FENCE_HEAD, send_claim_id=SEND_CLAIM_ID,
                        claimed_at=TIME, now_ms=SEND_NOW_MS))
        self.denied("F1_LEDGER_TRANSITION_INVALID", lambda:
                    validate_ledger_successor(
                        used, fence, expected_parent_sha=FENCE_HEAD))

    def test_stale_head_blocks_consumed_claim_prepublication(self):
        _, fence, used = consumed()
        self.denied("F1_LEDGER_TRANSITION_INVALID", lambda:
                    validate_ledger_successor(
                        fence, used, expected_parent_sha="e" * 40))

    def test_claim_insertion_without_prior_fence_is_denied(self):
        old, fence, used = consumed()
        self.denied("F1_LEDGER_TRANSITION_INVALID", lambda:
                    validate_ledger_successor(
                        old, used, expected_parent_sha=FENCE_HEAD))

    def test_cross_attempt_and_same_claim_replay_denied(self):
        ledger, fence = prepared()
        row = deepcopy(fence["attempts"][0])
        replay = deepcopy(fence)
        replay["attempts"].append(row)
        replay["sequence"] += 1
        self.denied("F1_ATTEMPT_REPLAY", lambda: validated_ledger(replay))
        replay = deepcopy(fence)
        replay["attempts"][0]["worker_id"] = "f2"
        self.denied("F1_ATTEMPT_WORKER_CLAIM_INVALID", lambda: validated_ledger(replay))
        replay = deepcopy(fence)
        replay["attempts"][0]["number"] = 124
        self.denied("F1_ATTEMPT_WORKER_CLAIM_INVALID", lambda: validated_ledger(replay))

    def test_invalid_raw_profile_target_identifier_and_claim_shape(self):
        _, fence = prepared()
        for key, invalid in [("target_sha256", "raw target"), ("profile_sha256", []),
                             ("tab_id", True), ("execution_id", 15), ("fence_id", None)]:
            mutated = deepcopy(fence)
            mutated["attempts"][0][key] = invalid
            self.denied("F1_ATTEMPT_ROW_INVALID",
                        lambda mutated=mutated: validated_ledger(mutated))

    def test_missing_or_malformed_consumed_marker_blocks(self):
        _, _, used = consumed()
        for key, invalid in [("send_claim_id", None), ("claimed_at", "bad-time"),
                             ("fence_snapshot_sha", [FENCE_HEAD])]:
            mutated = deepcopy(used)
            mutated["attempts"][0][key] = invalid
            self.denied("F1_ATTEMPT_PHASE_INVALID",
                        lambda mutated=mutated: validated_ledger(mutated))

    def test_consume_cannot_modify_owner_pr_head_or_profile(self):
        _, fence, used = consumed()
        for key, replacement in [("worker_id", "f2"), ("head_sha", "e" * 40),
                                 ("profile_sha256", "e" * 64),
                                 ("execution_id", "execution-hijacked")]:
            changed = deepcopy(used)
            changed["attempts"][0][key] = replacement
            expected = "F1_ATTEMPT_WORKER_CLAIM_INVALID" if key in (
                "worker_id", "head_sha") else "F1_LEDGER_TRANSITION_INVALID"
            self.denied(expected, lambda changed=changed:
                        validate_ledger_successor(
                            fence, changed, expected_parent_sha=FENCE_HEAD))

    def test_writer_denies_expired_and_backdated_v2_send_proposals(self):
        provider = FakeProvider()
        root, fence = prepared()
        raw = canonical(root)
        digest = blob_sha(raw)
        provider.blobs[digest] = raw
        provider.trees[provider.commits[provider.head]["tree"]] = digest
        with patch("urllib.request.build_opener", return_value=provider):
            writer = GitHubAppArbiterWriter(TOKEN, live_writes_enabled=True)
        deadline = root["claims"][0]["lease_deadline_ms"]
        for ns, code in (
            (deadline * 1_000_000, "F1_PROVIDER_LEASE_EXPIRED"),
            ((deadline - 30_001) * 1_000_000, "F1_PROVIDER_CLOCK_BACKDATED"),
            (True, "F1_PROVIDER_CLOCK_INVALID"),
        ):
            with patch("github_f1_private_arbiter_writer.time.time_ns",
                       return_value=ns):
                self.denied(code, lambda: writer.publish(
                    expected_head=provider.head, proposed_manifest=fence))
            self.assertEqual(provider.head, HEAD)
            self.assertFalse(any(method != "GET" for method, _ in provider.requests))
        provider.requests.clear()
        # Expiry between the first check and PATCH must not publish.
        with patch("github_f1_private_arbiter_writer.time.time_ns",
                   side_effect=[(deadline - 1) * 1_000_000,
                                deadline * 1_000_000]):
            self.denied("F1_PROVIDER_LEASE_EXPIRED", lambda: writer.publish(
                expected_head=provider.head, proposed_manifest=fence))
        self.assertEqual(provider.head, HEAD)
        self.assertFalse(any(method == "PATCH" for method, _ in provider.requests))
        provider.requests.clear()
        with patch("github_f1_private_arbiter_writer.time.time_ns",
                   side_effect=[(deadline - 1) * 1_000_000,
                                (deadline - 2) * 1_000_000]):
            self.denied("F1_PROVIDER_CLOCK_REWOUND", lambda: writer.publish(
                expected_head=provider.head, proposed_manifest=fence))
        self.assertEqual(provider.head, HEAD)
        self.assertFalse(any(method == "PATCH" for method, _ in provider.requests))

    def test_writer_denies_expired_consumption_without_ref_mutation(self):
        provider = FakeProvider()
        root, fence = prepared()
        raw = canonical(root)
        digest = blob_sha(raw)
        provider.blobs[digest] = raw
        provider.trees[provider.commits[provider.head]["tree"]] = digest
        with patch("urllib.request.build_opener", return_value=provider):
            writer = GitHubAppArbiterWriter(TOKEN, live_writes_enabled=True)
        with patch("github_f1_private_arbiter_writer.time.time_ns",
                   return_value=SEND_NOW_MS * 1_000_000):
            first = writer.publish(expected_head=provider.head,
                                   proposed_manifest=fence)
        consumed = consume_first_send_claim(
            fence, attempt_id="attempt-f1-01",
            expected_parent_sha=first["arbiter_head"], send_claim_id=SEND_CLAIM_ID,
            claimed_at=TIME, now_ms=SEND_NOW_MS)
        provider.requests.clear()
        deadline = root["claims"][0]["lease_deadline_ms"]
        with patch("github_f1_private_arbiter_writer.time.time_ns",
                   return_value=deadline * 1_000_000):
            self.denied("F1_PROVIDER_LEASE_EXPIRED", lambda: writer.publish(
                expected_head=provider.head, proposed_manifest=consumed))
        self.assertEqual(provider.head, first["arbiter_head"])
        self.assertFalse(any(method != "GET" for method, _ in provider.requests))

    @patch("github_f1_private_arbiter_writer.time.time_ns",
           return_value=SEND_NOW_MS * 1_000_000)
    def test_real_wire_adapter_models_one_fence_then_one_consumption(self, _clock):
        provider = FakeProvider()
        root, fence = prepared()
        # The synthetic provider starts with legacy v1; replacing its
        # preinstalled fixture with a hypothetical manually approved v2
        # initialization is *test-only*. No live migration is implemented.
        from github_f1_private_arbiter_writer import blob_sha, canonical
        raw = canonical(root)
        bsha = blob_sha(raw)
        provider.blobs[bsha] = raw
        old_tree = provider.commits[provider.head]["tree"]
        provider.trees[old_tree] = bsha
        with patch("urllib.request.build_opener", return_value=provider):
            writer = GitHubAppArbiterWriter(TOKEN, live_writes_enabled=True)
        first = writer.publish(expected_head=provider.head, proposed_manifest=fence)
        fence_head = first["arbiter_head"]
        next_ledger = consume_first_send_claim(
            fence, attempt_id="attempt-f1-01", expected_parent_sha=fence_head,
            send_claim_id=SEND_CLAIM_ID, claimed_at=TIME, now_ms=SEND_NOW_MS)
        second = writer.publish(expected_head=fence_head,
                                proposed_manifest=next_ledger)
        self.assertNotEqual(first["arbiter_head"], second["arbiter_head"])
        self.assertEqual(provider.head, second["arbiter_head"])
        self.assertEqual(sum(1 for method, path in provider.requests if method == "PATCH"), 2)
        self.assertEqual(second["send_authority"], "NONE")
        with self.assertRaises(GitHubWriterDenied):
            writer.publish(expected_head=provider.head, proposed_manifest=next_ledger)

    def test_confirmed_conversation_is_durable_unique_and_preserves_send_claim(self):
        _, fence, used = consumed()
        confirmed = confirm_new_conversation(
            used, attempt_id="attempt-f1-01",
            conversation_id="conversation-first-123", confirmed_at=TIME)
        self.assertEqual(validate_ledger_successor(
            used, confirmed, expected_parent_sha="d" * 40), confirmed)
        self.assertEqual(confirmed["attempts"][0]["state"], "CONFIRMED_NEW_CONVERSATION")
        self.assertEqual(confirmed["attempts"][0]["send_claim_id"], SEND_CLAIM_ID)
        self.denied("F1_CONFIRMATION_NOT_ALLOWED", lambda:
                    confirm_new_conversation(
                        confirmed, attempt_id="attempt-f1-01",
                        conversation_id="conversation-second-123", confirmed_at=TIME))
        self.denied("F1_LEDGER_TRANSITION_INVALID", lambda:
                    validate_ledger_successor(
                        confirmed, used, expected_parent_sha="d" * 40))

    def test_followup_attempt_requires_confirmed_prior_and_same_owner_pins(self):
        ledger, worker_claim = base()
        _, fence, used = consumed()
        params = dict(
            attempt_id="attempt-f1-02", worker_claim_id=worker_claim,
            target_sha256="a" * 64, profile_sha256="b" * 64,
            tab_id=18, execution_id="execution-87654321",
            fence_id="fence-second-123")
        self.denied("F1_PREVIOUS_ATTEMPT_UNRESOLVED",
                    lambda: append_first_send_fence(fence, **params, now_ms=SEND_NOW_MS))
        self.denied("F1_PREVIOUS_ATTEMPT_UNRESOLVED",
                    lambda: append_first_send_fence(used, **params, now_ms=SEND_NOW_MS))
        confirmed = confirm_new_conversation(
            used, attempt_id="attempt-f1-01",
            conversation_id="conversation-first-123", confirmed_at=TIME)
        again = append_first_send_fence(confirmed, **params, now_ms=SEND_NOW_MS)
        self.assertEqual(validate_ledger_successor(
            confirmed, again, expected_parent_sha="d" * 40), again)
        self.assertEqual(len(again["attempts"]), 2)
        self.assertEqual(again["attempts"][0]["conversation_id"], "conversation-first-123")
        for key in ("profile_sha256", "target_sha256"):
            corrupted = dict(params)
            corrupted[key] = "e" * 64
            self.denied("F1_PREVIOUS_ATTEMPT_UNRESOLVED",
                        lambda corrupted=corrupted:
                        append_first_send_fence(confirmed, **corrupted, now_ms=SEND_NOW_MS))

    def test_confirmation_wrong_order_duplicate_conversation_and_malformed_rejected(self):
        _, fence, used = consumed()
        self.denied("F1_CONFIRMATION_NOT_ALLOWED", lambda:
                    confirm_new_conversation(
                        fence, attempt_id="attempt-f1-01",
                        conversation_id="conversation-first-123", confirmed_at=TIME))
        for id_value, timestamp in [(None, TIME), ("bad", TIME),
                                    ("conversation-first-123", "bad-clock"),
                                    ("conversation-first-123", "2020-10-20T06:00:00.000Z")]:
            self.denied("F1_CONVERSATION_RECEIPT_INVALID" if id_value is None or id_value == "bad" or timestamp == "bad-clock" else "F1_ATTEMPT_PHASE_INVALID", lambda id_value=id_value, timestamp=timestamp:
                        confirm_new_conversation(
                            used, attempt_id="attempt-f1-01",
                            conversation_id=id_value, confirmed_at=timestamp))
        confirmed = confirm_new_conversation(
            used, attempt_id="attempt-f1-01",
            conversation_id="conversation-first-123", confirmed_at=TIME)
        row = deepcopy(confirmed["attempts"][0])
        dupe = deepcopy(confirmed)
        dupe["attempts"].append({**row, "attempt_id": "attempt-f1-02",
                                 "execution_id": "execution-other-123",
                                 "fence_id": "fence-other-123",
                                 "send_claim_id": "send-other-123"})
        dupe["sequence"] += 1
        self.denied("F1_CONVERSATION_ID_REUSED", lambda: validated_ledger(dupe))

    def test_stale_or_wrong_head_confirmation_cannot_rewrite_consumed_row(self):
        _, fence, used = consumed()
        confirmed = confirm_new_conversation(
            used, attempt_id="attempt-f1-01",
            conversation_id="conversation-first-123", confirmed_at=TIME)
        for key, new_val in [
            ("worker_id", "f2"), ("head_sha", "e" * 40),
            ("send_claim_id", "send-other-123"),
            ("profile_sha256", "e" * 64), ("fence_snapshot_sha", "e" * 40)]:
            changed = deepcopy(confirmed)
            changed["attempts"][0][key] = new_val
            self.assertRaises(FirstSendLedgerDenied, validate_ledger_successor,
                              used, changed, expected_parent_sha="d" * 40)

    @patch("github_f1_private_arbiter_writer.time.time_ns",
           return_value=SEND_NOW_MS * 1_000_000)
    def test_confirmed_second_attempt_full_mock_provider_successor_sequence(self, _clock):
        provider = FakeProvider()
        root, fence = prepared()
        from github_f1_private_arbiter_writer import blob_sha, canonical
        raw = canonical(root)
        h = blob_sha(raw)
        provider.blobs[h] = raw
        provider.trees[provider.commits[provider.head]["tree"]] = h
        with patch("urllib.request.build_opener", return_value=provider):
            writer = GitHubAppArbiterWriter(TOKEN, live_writes_enabled=True)
        first = writer.publish(expected_head=provider.head, proposed_manifest=fence)
        used = consume_first_send_claim(
            fence, attempt_id="attempt-f1-01",
            expected_parent_sha=first["arbiter_head"],
            send_claim_id=SEND_CLAIM_ID, claimed_at=TIME, now_ms=SEND_NOW_MS)
        second = writer.publish(expected_head=first["arbiter_head"],
                                proposed_manifest=used)
        confirmed = confirm_new_conversation(
            used, attempt_id="attempt-f1-01",
            conversation_id="conversation-first-123", confirmed_at=TIME)
        third = writer.publish(expected_head=second["arbiter_head"],
                               proposed_manifest=confirmed)
        newer = append_first_send_fence(
            confirmed, attempt_id="attempt-f1-02",
            worker_claim_id=confirmed["claims"][0]["claim_id"],
            target_sha256="a" * 64, profile_sha256="b" * 64,
            tab_id=18, execution_id="execution-87654321", fence_id="fence-second-123", now_ms=SEND_NOW_MS)
        fourth = writer.publish(expected_head=third["arbiter_head"],
                                proposed_manifest=newer)
        self.assertNotEqual(fourth["arbiter_head"], third["arbiter_head"])
        self.assertEqual(sum(1 for method, path in provider.requests if method == "PATCH"), 4)
        self.assertEqual(provider.head, fourth["arbiter_head"])
        self.assertEqual(fourth["send_authority"], "NONE")


if __name__ == "__main__":
    unittest.main()
