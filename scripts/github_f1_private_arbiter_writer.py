#!/usr/bin/env python3
"""Server-private GitHub REST writer for the existing single arbiter ref.

Dormant until an owner-authorized, separately certified GitHub App caller
provides an installation token. This is a REAL HTTPS REST transport, unlike
the older callback model, but it grants NO assignment, delivery or wake
authority and is NEVER wired into the relay/dispatcher by this PR.
"""
from __future__ import annotations

import base64
import binascii
from hashlib import sha1
import json
import re
import urllib.error
import urllib.request
from typing import Any

from github_atomic_claim import (
    ARBITER_REF, ClaimDenied, _validate_successor, validated_manifest,
)

REPOSITORY = "jan2xo/bke-worker"
API = "https://api.github.com"
MANIFEST_PATH = "claims-v1.json"
BASE = "/repos/jan2xo/bke-worker/git/"
REF_PATH = BASE + "ref/heads/bke/control-claims-v1"
UPDATE_PATH = BASE + "refs/heads/bke/control-claims-v1"
SHA = re.compile(r"[a-f0-9]{40}\Z")
MAX_REPLY = 131072
MAX_MANIFEST = 65536


class GitHubWriterDenied(ValueError):
    """Sanitized failure. Never include bearer, provider body or URL payload."""


def deny(code: str) -> None:
    raise GitHubWriterDenied(code)


def sha(value: Any) -> str:
    if type(value) is not str or SHA.fullmatch(value) is None:
        deny("F1_PROVIDER_SHA_INVALID")
    return value


def strict_json(raw: bytes) -> Any:
    if type(raw) is not bytes or len(raw) > MAX_REPLY:
        deny("F1_PROVIDER_RESPONSE_INVALID")
    def no_duplicates(pairs):
        out = {}
        for key, value in pairs:
            if key in out:
                deny("F1_PROVIDER_DUPLICATE_KEY")
            out[key] = value
        return out
    try:
        return json.loads(raw.decode("utf-8"), object_pairs_hook=no_duplicates,
                          parse_constant=lambda _: deny("F1_PROVIDER_RESPONSE_INVALID"))
    except GitHubWriterDenied:
        raise
    except (TypeError, UnicodeError, ValueError):
        deny("F1_PROVIDER_RESPONSE_INVALID")


def canonical(value: Any) -> bytes:
    try:
        result = validated_manifest(value)
    except ClaimDenied:
        deny("F1_PROVIDER_MANIFEST_INVALID")
    raw = (json.dumps(result, sort_keys=True, separators=(",", ":"),
                      ensure_ascii=True) + "\n").encode("ascii")
    if len(raw) > MAX_MANIFEST:
        deny("F1_PROVIDER_MANIFEST_TOO_LARGE")
    return raw


def blob_sha(raw: bytes) -> str:
    return sha1(b"blob " + str(len(raw)).encode("ascii") + b"\0" + raw).hexdigest()


def parse_ref(value: Any) -> str:
    if (type(value) is not dict or value.get("ref") != ARBITER_REF or
            type(value.get("object")) is not dict or
            value["object"].get("type") != "commit"):
        deny("F1_PROVIDER_REF_INVALID")
    return sha(value["object"].get("sha"))


class _NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, request, fp, code, msg, headers, newurl):
        deny("F1_PROVIDER_REDIRECT_DENIED")


class GitHubAppArbiterWriter:
    """Fixed HTTPS GitHub REST transport, never a privileged identity issuer.

    The token MUST come from a separately authenticated server-private
    GitHub App issuer, verified installation/repository/principal scope,
    not a chat, browser, GitHub PR body, PAT, or callback. This module
    deliberately does not accept configurable URLs, openers, proxies,
    repository/ref names, or an arbitrary HTTP route.
    """

    def __init__(self, scoped_installation_token: str, *, live_writes_enabled=False):
        if (type(scoped_installation_token) is not str or
                not 10 <= len(scoped_installation_token) <= 8192 or
                any(ord(c) < 33 or ord(c) > 126 for c in scoped_installation_token)):
            deny("F1_PROVIDER_PRIVATE_TOKEN_REQUIRED")
        if type(live_writes_enabled) is not bool:
            deny("F1_PROVIDER_CONFIGURATION_INVALID")
        self.__token = scoped_installation_token
        self.__enabled = live_writes_enabled
        self.__opener = urllib.request.build_opener(
            urllib.request.ProxyHandler({}), _NoRedirect()
        )

    def _call(self, method: str, path: str, body: dict | None = None) -> Any:
        # All credential-bearing URLs are FIXED or Git SHA constrained.
        valid_dynamic = re.fullmatch(
            re.escape(BASE) + r"(?:commits|trees|blobs)/[a-f0-9]{40}", path
        ) is not None
        permitted = (
            method == "GET" and (path == REF_PATH or valid_dynamic)
        ) or (
            method == "POST" and path in (BASE + "blobs", BASE + "trees", BASE + "commits")
        ) or (method == "PATCH" and path == UPDATE_PATH)
        if not permitted:
            deny("F1_PROVIDER_PATH_DENIED")
        url = API + path
        headers = {
            "Accept": "application/vnd.github+json",
            "Authorization": "Bearer " + self.__token,
            "User-Agent": "bke-f1-private-arbiter-writer",
            "X-GitHub-Api-Version": "2022-11-28",
        }
        data = None
        if method != "GET":
            if not self.__enabled:
                deny("F1_PROVIDER_LIVE_WRITE_LOCKED")
            if type(body) is not dict:
                deny("F1_PROVIDER_BODY_INVALID")
            data = json.dumps(body, sort_keys=True, separators=(",", ":")).encode("utf-8")
            if len(data) > MAX_REPLY:
                deny("F1_PROVIDER_BODY_TOO_LARGE")
            headers["Content-Type"] = "application/json"
        request = urllib.request.Request(url, headers=headers, data=data, method=method)
        try:
            with self.__opener.open(request, timeout=15) as response:
                if response.geturl() != url:
                    deny("F1_PROVIDER_REDIRECT_DENIED")
                if response.getcode() not in (200, 201):
                    deny("F1_PROVIDER_HTTP_UNAVAILABLE")
                return strict_json(response.read(MAX_REPLY + 1))
        except GitHubWriterDenied:
            raise
        except urllib.error.HTTPError as error:
            if method == "GET" and path == REF_PATH and error.code == 404:
                deny("F1_PROVIDER_REF_NOT_INITIALIZED")
            if method == "PATCH" and error.code in (409, 412, 422):
                deny("F1_PROVIDER_CAS_CONFLICT")
            deny("F1_PROVIDER_HTTP_UNAVAILABLE")
        except Exception:
            # Includes a lost PATCH response: NEVER automatically retry.
            deny("F1_PROVIDER_REMOTE_UNCERTAIN")

    def _head(self) -> str:
        return parse_ref(self._call("GET", REF_PATH))

    def _snapshot(self, head: str) -> dict[str, Any]:
        head = sha(head)
        commit = self._call("GET", BASE + "commits/" + head)
        if (type(commit) is not dict or commit.get("sha") != head or
                type(commit.get("tree")) is not dict or
                type(commit.get("parents")) is not list or
                len(commit["parents"]) > 1):
            deny("F1_PROVIDER_COMMIT_INVALID")
        parents = commit["parents"]
        for parent in parents:
            if type(parent) is not dict or sha(parent.get("sha")) == head:
                deny("F1_PROVIDER_COMMIT_INVALID")
        tree_sha = sha(commit["tree"].get("sha"))
        tree = self._call("GET", BASE + "trees/" + tree_sha)
        if (type(tree) is not dict or tree.get("sha") != tree_sha or
                tree.get("truncated") is not False or
                type(tree.get("tree")) is not list or len(tree["tree"]) != 1):
            deny("F1_PROVIDER_TREE_INVALID")
        entry = tree["tree"][0]
        if (type(entry) is not dict or entry.get("path") != MANIFEST_PATH or
                entry.get("mode") != "100644" or entry.get("type") != "blob"):
            deny("F1_PROVIDER_TREE_INVALID")
        content_sha = sha(entry.get("sha"))
        data = self._call("GET", BASE + "blobs/" + content_sha)
        if (type(data) is not dict or data.get("sha") != content_sha or
                data.get("encoding") != "base64" or
                type(data.get("content")) is not str or
                type(data.get("size")) is not int or
                not 1 <= data["size"] <= MAX_MANIFEST):
            deny("F1_PROVIDER_BLOB_INVALID")
        try:
            encoded = data["content"].replace("\n", "")
            if len(encoded) > (MAX_MANIFEST + 2) // 3 * 4 + 4:
                deny("F1_PROVIDER_BLOB_INVALID")
            raw = base64.b64decode(encoded, validate=True)
        except (binascii.Error, ValueError):
            deny("F1_PROVIDER_BLOB_INVALID")
        if len(raw) != data["size"] or blob_sha(raw) != content_sha:
            deny("F1_PROVIDER_BLOB_INVALID")
        payload = strict_json(raw)
        if canonical(payload) != raw:
            deny("F1_PROVIDER_MANIFEST_NONCANONICAL")
        return {"head": head, "tree": tree_sha, "blob": content_sha,
                "parents": [p["sha"] for p in parents], "manifest": payload}

    def inspect(self) -> dict[str, Any]:
        before = self._head()
        snapshot = self._snapshot(before)
        if self._head() != before:
            deny("F1_PROVIDER_REF_MOVED")
        return {"state": "UNVERIFIED_PRIVATE_TRANSPORT_ONLY", **snapshot,
                "assignment_authority": "NONE", "send_authority": "NONE",
                "dispatch_authority": "NONE", "wake_authority": "NONE"}

    def publish(self, *, expected_head: str, proposed_manifest: dict) -> dict[str, Any]:
        """One append-only successor through actual non-force GitHub REST.

        If any response/readback is ambiguous, NO send, retry, or new claim.
        No authority can arise from this result: provider principal, complete
        PR ownership, browser target, and first-send claim are separate gates.
        """
        if not self.__enabled:
            deny("F1_PROVIDER_LIVE_WRITE_LOCKED")
        sha(expected_head)
        try:
            before = self._head()
            if before != expected_head:
                deny("F1_PROVIDER_REF_MOVED")
            parent = self._snapshot(before)
            try:
                successor = _validate_successor(parent["manifest"], proposed_manifest)
            except ClaimDenied:
                deny("F1_PROVIDER_TRANSITION_INVALID")
            content = canonical(successor)
            # Re-read immediately before mutation. This is not a substitute
            # for GitHub's atomic non-force ref update in a concurrent race.
            if self._head() != before:
                deny("F1_PROVIDER_REF_MOVED")
            created_blob = self._call("POST", BASE + "blobs", {
                "content": content.decode("ascii"), "encoding": "utf-8",
            })
            new_blob_sha = sha(created_blob.get("sha") if type(created_blob) is dict else None)
            if new_blob_sha != blob_sha(content):
                deny("F1_PROVIDER_BLOB_MISMATCH")
            new_tree = self._call("POST", BASE + "trees", {
                "tree": [{"path": MANIFEST_PATH, "mode": "100644",
                          "type": "blob", "sha": new_blob_sha}],
            })
            new_tree_sha = sha(new_tree.get("sha") if type(new_tree) is dict else None)
            new_commit = self._call("POST", BASE + "commits", {
                "message": "bke: append one F1 arbiter transition",
                "tree": new_tree_sha, "parents": [before],
            })
            child = sha(new_commit.get("sha") if type(new_commit) is dict else None)
            if child == before:
                deny("F1_PROVIDER_CHILD_INVALID")
            # Independently reread the child before advancing the shared ref.
            evidence = self._snapshot(child)
            if evidence["parents"] != [before] or evidence["manifest"] != successor:
                deny("F1_PROVIDER_CHILD_INVALID")
            # GitHub fast-forward constraint serializes sibling contenders.
            updated = self._call("PATCH", UPDATE_PATH, {
                "sha": child, "force": False,
            })
            if parse_ref(updated) != child:
                deny("F1_PROVIDER_REMOTE_UNCERTAIN")
            if self._head() != child:
                deny("F1_PROVIDER_REMOTE_UNCERTAIN")
            verified = self._snapshot(child)
            if verified["parents"] != [before] or verified["manifest"] != successor:
                deny("F1_PROVIDER_REMOTE_UNCERTAIN")
            if self._head() != child:
                deny("F1_PROVIDER_REMOTE_UNCERTAIN")
        except GitHubWriterDenied:
            raise
        except Exception:
            deny("F1_PROVIDER_REMOTE_UNCERTAIN")
        return {"state": "REMOTE_REF_UPDATED_UNVERIFIED_PRINCIPAL",
                "arbiter_head": child, "arbiter_ref": ARBITER_REF,
                "assignment_authority": "NONE", "send_authority": "NONE",
                "dispatch_authority": "NONE", "wake_authority": "NONE"}
