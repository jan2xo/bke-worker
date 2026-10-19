#!/usr/bin/env python3
"""Source-only fixed GitHub App arbiter ref inspector. GET-only, no authority.

Provider credentials and installation identity MUST come from independently
certified server-private code. Neither synthetic responses nor double reads
prove remote authenticity, write rights, or atomicity.
"""
from __future__ import annotations

import base64
import binascii
from hashlib import sha1
import json
import re
from typing import Any, Callable
import urllib.error
import urllib.request

from github_atomic_claim import ARBITER_REF, validated_manifest, ClaimDenied

REPOSITORY = "jan2xo/bke-worker"
API_ORIGIN = "https://api.github.com"
MANIFEST_FILE = "claims-v1.json"
_SHA = re.compile(r"[0-9a-f]{40}\Z")
MAX_JSON_BYTES = 131072
MAX_BLOB_BYTES = 65536
_BASE_PATH = "/repos/" + REPOSITORY + "/git/"
_REF_PATH = _BASE_PATH + "ref/heads/bke/control-claims-v1"


class ArbiterReadDenied(ValueError):
    """Sanitized error, never a token or a raw provider response."""


def _deny(code: str) -> None:
    raise ArbiterReadDenied(code)


def _sha(value: Any) -> str:
    if type(value) is not str or _SHA.fullmatch(value) is None:
        _deny("ARBITER_SHA_INVALID")
    return value


def _json(value: bytes) -> Any:
    if type(value) is not bytes or len(value) > MAX_JSON_BYTES:
        _deny("ARBITER_RESPONSE_INVALID")
    def unique_pairs(pairs: list[tuple[str, Any]]) -> dict[str, Any]:
        result = {}
        for key, item in pairs:
            if key in result:
                _deny("ARBITER_JSON_DUPLICATE_KEY")
            result[key] = item
        return result
    try:
        return json.loads(value.decode("utf-8"), object_pairs_hook=unique_pairs,
                          parse_constant=lambda _: _deny("ARBITER_RESPONSE_INVALID"))
    except ArbiterReadDenied:
        raise
    except (ValueError, UnicodeError, TypeError):
        _deny("ARBITER_RESPONSE_INVALID")


def canonical_manifest_bytes(manifest: Any) -> bytes:
    try:
        valid = validated_manifest(manifest)
        content = (json.dumps(valid, sort_keys=True, separators=(",", ":"),
                              ensure_ascii=True) + "\n").encode("ascii")
    except ClaimDenied:
        _deny("ARBITER_MANIFEST_INVALID")
    if len(content) > MAX_BLOB_BYTES:
        _deny("ARBITER_MANIFEST_OVERSIZE")
    return content


def blob_sha1(content: bytes) -> str:
    if type(content) is not bytes or len(content) > MAX_BLOB_BYTES:
        _deny("ARBITER_BLOB_INVALID")
    return sha1(b"blob " + str(len(content)).encode("ascii") + b"\0" + content).hexdigest()


def parse_reference(data: Any) -> str:
    if (type(data) is not dict or data.get("ref") != ARBITER_REF or
            type(data.get("object")) is not dict or
            data["object"].get("type") != "commit"):
        _deny("ARBITER_REF_INVALID")
    return _sha(data["object"].get("sha"))


def _commit(data: Any, expected_head: str) -> tuple[str, list[str]]:
    if (type(data) is not dict or data.get("sha") != expected_head or
            type(data.get("tree")) is not dict or
            type(data.get("parents")) is not list or len(data["parents"]) > 1):
        _deny("ARBITER_COMMIT_INVALID")
    tree_sha = _sha(data["tree"].get("sha"))
    parents = data["parents"]
    if any(type(p) is not dict or type(p.get("sha")) is not str or
           _SHA.fullmatch(p["sha"]) is None or p["sha"] == expected_head for p in parents):
        _deny("ARBITER_COMMIT_INVALID")
    return tree_sha, [p["sha"] for p in parents]


def _tree(data: Any, expected_sha: str) -> str:
    if (type(data) is not dict or data.get("sha") != expected_sha or
            data.get("truncated") is not False or type(data.get("tree")) is not list or
            len(data["tree"]) != 1):
        _deny("ARBITER_TREE_INVALID")
    only = data["tree"][0]
    if (type(only) is not dict or only.get("path") != MANIFEST_FILE or
            only.get("mode") != "100644" or only.get("type") != "blob"):
        _deny("ARBITER_TREE_INVALID")
    return _sha(only.get("sha"))


def _blob(data: Any, expected_sha: str) -> dict[str, Any]:
    if (type(data) is not dict or data.get("sha") != expected_sha or
            data.get("encoding") != "base64" or
            type(data.get("size")) is not int or not 0 < data["size"] <= MAX_BLOB_BYTES or
            type(data.get("content")) is not str):
        _deny("ARBITER_BLOB_INVALID")
    raw = data["content"].replace("\n", "")
    if len(raw) > ((MAX_BLOB_BYTES + 2)//3)*4:
        _deny("ARBITER_BLOB_OVERSIZE")
    try:
        content = base64.b64decode(raw, validate=True)
    except (ValueError, binascii.Error):
        _deny("ARBITER_BLOB_INVALID")
    if (len(content) != data["size"] or blob_sha1(content) != expected_sha):
        _deny("ARBITER_BLOB_MISMATCH")
    parsed = _json(content)
    if content != canonical_manifest_bytes(parsed):
        _deny("ARBITER_MANIFEST_NONCANONICAL")
    return parsed


def inspect_arbiter(fetch_json: Callable[[str], Any]) -> dict[str, Any]:
    """Fetch strictly predetermined paths, verify links, but grant NO authority.

    fetch_json may be a fully forged callback. All outputs remain unverified.
    """
    if not callable(fetch_json):
        _deny("ARBITER_READER_INVALID")
    try:
        ref_sha = parse_reference(fetch_json(_REF_PATH))
        commit_data = fetch_json(_BASE_PATH + "commits/" + ref_sha)
        tree_sha, parents = _commit(commit_data, ref_sha)
        blob_sha = _tree(fetch_json(_BASE_PATH + "trees/" + tree_sha), tree_sha)
        manifest = _blob(fetch_json(_BASE_PATH + "blobs/" + blob_sha), blob_sha)
        if parse_reference(fetch_json(_REF_PATH)) != ref_sha:
            _deny("ARBITER_REF_MOVED")
    except ArbiterReadDenied:
        raise
    except Exception:
        _deny("ARBITER_PROVIDER_UNAVAILABLE")
    return {
        "state": "UNVERIFIED_GITHUB_REF_SNAPSHOT_ONLY",
        "arbiter_ref": ARBITER_REF,
        "head_sha": ref_sha,
        "tree_sha": tree_sha,
        "blob_sha": blob_sha,
        "parent_shas": parents,
        "manifest": manifest,
        "evidence_authority": "NONE",
        "assignment_authority": "NONE",
        "dispatch_authority": "NONE",
        "wake_authority": "NONE",
    }


class _NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, request, fp, code, msg, headers, newurl):
        _deny("ARBITER_REDIRECT_DENIED")


class GitHubAppArbiterReader:
    """Fixed GitHub REST GET adapter; token is supplied by trusted caller.

    This class neither mints tokens nor verifies the caller's identity.
    No output from this adapter alone is assignment or session evidence.
    """
    def __init__(self, scoped_installation_token: str, *, opener=None):
        if (type(scoped_installation_token) is not str or
                not 10 <= len(scoped_installation_token) <= 1000 or
                any(c.isspace() for c in scoped_installation_token)):
            _deny("ARBITER_APP_TOKEN_REQUIRED")
        self.__token = scoped_installation_token
        self.__opener = opener if opener is not None else urllib.request.build_opener(_NoRedirect())

    def _fetch(self, path: str) -> Any:
        if (type(path) is not str or not path.startswith(_BASE_PATH) or
                not (path == _REF_PATH or re.fullmatch(
                    re.escape(_BASE_PATH) + r"(?:commits|trees|blobs)/[a-f0-9]{40}", path
                ))):
            _deny("ARBITER_PATH_DENIED")
        req = urllib.request.Request(API_ORIGIN + path, headers={
            "Accept": "application/vnd.github+json",
            "Authorization": "Bearer " + self.__token,
            "User-Agent": "bke-arbiter-ref-inspector",
            "X-GitHub-Api-Version": "2022-11-28",
        }, method="GET")
        try:
            with self.__opener.open(req, timeout=15) as response:
                if response.getcode() != 200:
                    _deny("ARBITER_PROVIDER_UNAVAILABLE")
                data = response.read(MAX_JSON_BYTES + 1)
                return _json(data)
        except ArbiterReadDenied:
            raise
        except urllib.error.HTTPError as ex:
            if ex.code == 404 and path == _REF_PATH:
                _deny("ARBITER_REF_NOT_INITIALIZED")
            _deny("ARBITER_PROVIDER_UNAVAILABLE")
        except Exception:
            _deny("ARBITER_PROVIDER_UNAVAILABLE")

    def inspect(self) -> dict[str, Any]:
        return inspect_arbiter(self._fetch)
