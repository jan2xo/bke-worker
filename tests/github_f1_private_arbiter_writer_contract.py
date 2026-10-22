#!/usr/bin/env python3
"""Adversarial fixed-REST F1 provider tests; simulated GitHub only, no secrets."""
from __future__ import annotations

import base64
from hashlib import sha1
import json
from pathlib import Path
import sys
import unittest
from unittest.mock import patch
from urllib.error import HTTPError
from urllib.parse import urlparse

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "scripts"))
from github_atomic_claim import prepare_reservation
from github_f1_private_arbiter_writer import (
    GitHubAppArbiterWriter, GitHubWriterDenied,
    REF_PATH, UPDATE_PATH, API, BASE, canonical, blob_sha,
)

HEAD = "a" * 40
TOKEN = "ghs_disposable_unit_test_token_not_real"


class Response:
    def __init__(self, payload, url, code=200):
        self.payload, self.url, self.code = payload, url, code
    def __enter__(self): return self
    def __exit__(self, *args): return False
    def geturl(self): return self.url
    def getcode(self): return self.code
    def read(self, limit):
        return self.payload[:limit]


class FakeProvider:
    """Minimal coherent GitHub REST semantics, never a privileged provider."""
    def __init__(self):
        self.head = HEAD
        raw = canonical({"version": 1, "sequence": 0, "claims": []})
        self.blobs = {blob_sha(raw): raw}
        tree = "b" * 40
        self.trees = {tree: blob_sha(raw)}
        self.commits = {HEAD: {"tree": tree, "parents": []}}
        self.requests = []
        self.lost_patch_reply = False
        self.race_on_patch = False
        self.redirect = False
        self.wrong_effective_url = False
        self.bad_child_parent = False
        self.bad_blob_raw = False
        self.duplicate_json = False
        self.invalid_response = False
        self.unknown_ref = False

    def open(self, request, timeout=15):
        method, path = request.get_method(), urlparse(request.full_url).path
        assert timeout == 15
        assert request.full_url.startswith(API + BASE)
        assert request.get_header("Authorization") == "Bearer " + TOKEN
        self.requests.append((method, path))
        if self.redirect:
            raise HTTPError(request.full_url, 302, "Moved", {}, None)
        if self.unknown_ref and path == REF_PATH:
            raise HTTPError(request.full_url, 404, "Not found", {}, None)
        data = json.loads(request.data) if request.data else None
        code = 200
        if method == "GET" and path == REF_PATH:
            result = {"ref": "refs/heads/bke/control-claims-v1",
                      "object": {"type": "commit", "sha": self.head}}
        elif method == "GET" and path.startswith(BASE + "commits/"):
            commit_sha = path.rsplit("/", 1)[-1]
            c = self.commits[commit_sha]
            result = {"sha": commit_sha, "tree": {"sha": c["tree"]},
                      "parents": [{"sha": p} for p in c["parents"]]}
        elif method == "GET" and path.startswith(BASE + "trees/"):
            tree_sha = path.rsplit("/", 1)[-1]
            blob = self.trees[tree_sha]
            result = {"sha": tree_sha, "truncated": False,
                      "tree": [{"path": "claims-v1.json", "mode": "100644",
                                "type": "blob", "sha": blob}]}
        elif method == "GET" and path.startswith(BASE + "blobs/"):
            bsha = path.rsplit("/", 1)[-1]
            raw = self.blobs[bsha]
            if self.bad_blob_raw:
                raw = b'{"version":1,"sequence":0,"claims":[]}'
            result = {"sha": bsha, "encoding": "base64", "size": len(raw),
                      "content": base64.b64encode(raw).decode("ascii")}
        elif method == "POST" and path == BASE + "blobs":
            raw = data["content"].encode("utf-8")
            bsha = blob_sha(raw)
            self.blobs[bsha] = raw
            result = {"sha": bsha}; code = 201
        elif method == "POST" and path == BASE + "trees":
            blob = data["tree"][0]["sha"]
            tree_sha = sha1(("tree:" + blob).encode()).hexdigest()
            self.trees[tree_sha] = blob
            result = {"sha": tree_sha}; code = 201
        elif method == "POST" and path == BASE + "commits":
            parent = data["parents"][0]
            tree = data["tree"]
            commit_sha = sha1(("commit:" + parent + tree).encode()).hexdigest()
            self.commits[commit_sha] = {
                "parents": ["e" * 40] if self.bad_child_parent else [parent],
                "tree": tree,
            }
            result = {"sha": commit_sha}; code = 201
        elif method == "PATCH" and path == UPDATE_PATH:
            assert data["force"] is False
            child = data["sha"]
            if self.race_on_patch:
                self.head = "f" * 40
            if self.head != self.commits[child]["parents"][0]:
                raise HTTPError(request.full_url, 422, "non fast forward", {}, None)
            self.head = child
            if self.lost_patch_reply:
                raise ConnectionResetError("mock private provider response")
            result = {"ref": "refs/heads/bke/control-claims-v1",
                      "object": {"type": "commit", "sha": child}}
        else:
            raise AssertionError((method, path))
        raw = json.dumps(result).encode()
        if self.duplicate_json and path == REF_PATH:
            raw = b'{"ref":"one","ref":"two"}'
        if self.invalid_response:
            raw = b"not-json"
        actual_url = "https://evil.invalid/" if self.wrong_effective_url else request.full_url
        return Response(raw, actual_url, code)


def successor():
    base = {"version": 1, "sequence": 0, "claims": []}
    preflight = {
        "state": "PRECLAIM_CONSISTENT_ONLY", "worker_id": "f1",
        "repository": "jan2xo/bke-worker", "number": 123, "head_sha": "c" * 40,
        "assignment_authority": "NONE", "dispatch_authority": "NONE",
        "wake_authority": "NONE", "atomicity": "NONE",
    }
    current_pr = {
        "repository": "jan2xo/bke-worker", "number": 123,
        "head_sha": "c" * 40, "labels": [],
    }
    return prepare_reservation(
        manifest=base, preflight=preflight, current_pr=current_pr,
        expected_labels=[], now_ms=123456,
    )[0]


class F1PrivateWriterTests(unittest.TestCase):
    def setUp(self):
        self.provider = FakeProvider()
        with patch("urllib.request.build_opener", return_value=self.provider):
            self.writer = GitHubAppArbiterWriter(TOKEN)
            self.enabled = GitHubAppArbiterWriter(TOKEN, live_writes_enabled=True)

    def denied(self, code, call):
        with self.assertRaisesRegex(GitHubWriterDenied, "^" + code + "$"):
            call()

    def test_readback_is_bounded_and_never_authorizes_a_send(self):
        evidence = self.writer.inspect()
        self.assertEqual(evidence["head"], HEAD)
        self.assertEqual(evidence["manifest"]["claims"], [])
        self.assertEqual(evidence["state"], "UNVERIFIED_PRIVATE_TRANSPORT_ONLY")
        for field in ("assignment_authority", "send_authority",
                      "dispatch_authority", "wake_authority"):
            self.assertEqual(evidence[field], "NONE")

    def test_default_write_lock_never_calls_a_mutating_endpoint(self):
        self.denied("F1_PROVIDER_LIVE_WRITE_LOCKED", lambda: self.writer.publish(
            expected_head=HEAD, proposed_manifest=successor()
        ))
        self.assertEqual(self.provider.requests, [])

    def test_real_wire_sequence_updates_only_single_fixed_ref(self):
        result = self.enabled.publish(expected_head=HEAD, proposed_manifest=successor())
        self.assertNotEqual(self.provider.head, HEAD)
        self.assertEqual(result["arbiter_head"], self.provider.head)
        self.assertEqual(result["state"], "REMOTE_REF_UPDATED_UNVERIFIED_PRINCIPAL")
        for field in ("assignment_authority", "send_authority",
                      "dispatch_authority", "wake_authority"):
            self.assertEqual(result[field], "NONE")
        self.assertEqual(sum(1 for method, path in self.provider.requests
                             if method == "PATCH" and path == UPDATE_PATH), 1)
        self.assertFalse(any("issues/" in path or "pulls/" in path for _, path in self.provider.requests))
        self.denied("F1_PROVIDER_REF_MOVED", lambda: self.enabled.publish(
            expected_head=HEAD, proposed_manifest=successor()
        ))

    def test_concurrent_sibling_conflict_does_not_retry_or_send(self):
        self.provider.race_on_patch = True
        self.denied("F1_PROVIDER_CAS_CONFLICT", lambda: self.enabled.publish(
            expected_head=HEAD, proposed_manifest=successor()
        ))
        self.assertEqual(sum(1 for method, path in self.provider.requests
                             if method == "PATCH" and path == UPDATE_PATH), 1)

    def test_lost_response_after_actual_mutation_is_uncertain_not_success(self):
        self.provider.lost_patch_reply = True
        self.denied("F1_PROVIDER_REMOTE_UNCERTAIN", lambda: self.enabled.publish(
            expected_head=HEAD, proposed_manifest=successor()
        ))
        self.assertNotEqual(self.provider.head, HEAD)
        self.assertEqual(sum(1 for method, path in self.provider.requests
                             if method == "PATCH" and path == UPDATE_PATH), 1)

    def test_broken_commit_parent_is_rejected_before_reference_update(self):
        self.provider.bad_child_parent = True
        self.denied("F1_PROVIDER_CHILD_INVALID", lambda: self.enabled.publish(
            expected_head=HEAD, proposed_manifest=successor()
        ))
        self.assertEqual(self.provider.head, HEAD)
        self.assertFalse(any(method == "PATCH" for method, _ in self.provider.requests))

    def test_bad_transition_is_rejected_before_any_write(self):
        proposal = successor()
        proposal["claims"][0]["head_sha"] = "d" * 40
        proposal["claims"][0]["state"] = "INVALID"
        self.denied("F1_PROVIDER_TRANSITION_INVALID", lambda: self.enabled.publish(
            expected_head=HEAD, proposed_manifest=proposal
        ))
        self.assertFalse(any(method != "GET" for method, _ in self.provider.requests))

    def test_provider_ref_missing_does_not_initialize_it(self):
        self.provider.unknown_ref = True
        self.denied("F1_PROVIDER_REF_NOT_INITIALIZED", self.writer.inspect)
        self.assertEqual(self.provider.head, HEAD)

    def test_redirect_and_foreign_effective_url_fail_closed(self):
        self.provider.redirect = True
        self.denied("F1_PROVIDER_HTTP_UNAVAILABLE", self.writer.inspect)
        self.provider.redirect = False
        self.provider.wrong_effective_url = True
        self.denied("F1_PROVIDER_REDIRECT_DENIED", self.writer.inspect)

    def test_duplicate_json_and_invalid_provider_payload_fail(self):
        self.provider.duplicate_json = True
        self.denied("F1_PROVIDER_DUPLICATE_KEY", self.writer.inspect)
        self.provider.duplicate_json = False
        self.provider.invalid_response = True
        self.denied("F1_PROVIDER_RESPONSE_INVALID", self.writer.inspect)

    def test_blob_tampering_and_noncanonical_manifest_cannot_pass(self):
        self.provider.bad_blob_raw = True
        self.denied("F1_PROVIDER_BLOB_INVALID", self.writer.inspect)

    def test_constructor_forbids_untrusted_transport_and_invalid_tokens(self):
        with patch("urllib.request.build_opener", return_value=self.provider):
            for token in ["", "short", "token with space", "token\r\nX-Leak:1", None]:
                self.denied("F1_PROVIDER_PRIVATE_TOKEN_REQUIRED",
                            lambda token=token: GitHubAppArbiterWriter(token))
            with self.assertRaises(TypeError):
                GitHubAppArbiterWriter(TOKEN, opener=self.provider)
            self.denied("F1_PROVIDER_CONFIGURATION_INVALID",
                        lambda: GitHubAppArbiterWriter(TOKEN, live_writes_enabled="yes"))


if __name__ == "__main__":
    unittest.main()
