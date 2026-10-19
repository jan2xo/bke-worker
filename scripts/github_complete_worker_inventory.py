#!/usr/bin/env python3
"""Read-only GitHub App open-PR inventory, source-only.

The caller must independently authorize the EXACT complete repository scope.
Two matching passes are not an atomic GitHub snapshot and grant no dispatch.
"""
from __future__ import annotations

from datetime import datetime, timezone
import json
import re
from typing import Any, Callable
import urllib.error
import urllib.parse
import urllib.request

REPO = re.compile(r"[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+\Z")
SHA = re.compile(r"[a-f0-9]{40}\Z")
MAX_REPOSITORIES = 20
MAX_PAGES = 20
PAGE_SIZE = 100
MAX_PAGE_BYTES = 3 * 1024 * 1024


class InventoryError(ValueError):
    """Sanitized fail-closed error, never includes tokens or page content."""


def _deny(code: str) -> None:
    raise InventoryError(code)


def _scope(repositories: Any) -> tuple[str, ...]:
    if type(repositories) is not list or not 1 <= len(repositories) <= MAX_REPOSITORIES:
        _deny("GITHUB_SCOPE_INVALID")
    normalized = []
    for value in repositories:
        if type(value) is not str or not REPO.fullmatch(value):
            _deny("GITHUB_SCOPE_INVALID")
        normalized.append(value.lower())
    if len(set(normalized)) != len(normalized):
        _deny("GITHUB_SCOPE_DUPLICATE")
    return tuple(sorted(normalized))


def _normalized_pr(item: Any, repository: str) -> dict[str, Any]:
    if type(item) is not dict:
        _deny("GITHUB_PR_ROW_INVALID")
    base = item.get("base")
    base_repo = base.get("repo") if type(base) is dict else None
    base_name = base_repo.get("full_name") if type(base_repo) is dict else None
    if type(base_name) is not str or base_name.lower() != repository:
        _deny("GITHUB_PR_BASE_MISMATCH")
    number = item.get("number")
    head = item.get("head")
    sha = head.get("sha") if type(head) is dict else None
    labels = item.get("labels")
    if (type(number) is not int or number < 1 or item.get("state") != "open"
            or type(sha) is not str or not SHA.fullmatch(sha)
            or type(labels) is not list or len(labels) > 200):
        _deny("GITHUB_PR_ROW_INVALID")
    safe_labels = []
    for label in labels:
        name = label.get("name") if type(label) is dict else None
        if type(name) is not str or not name or len(name) > 100:
            _deny("GITHUB_PR_LABEL_INVALID")
        safe_labels.append({"name": name})
    # Do not import PR body, untrusted issue text, tokens or log fields.
    return {
        "repository": repository,
        "number": number,
        "state": "open",
        "head_sha": sha,
        "labels": safe_labels,
    }


def _collect(
    repos: tuple[str, ...],
    fetch_page: Callable[[str, int], tuple[list[Any], bool]],
) -> list[dict[str, Any]]:
    result: list[dict[str, Any]] = []
    seen: set[tuple[str, int]] = set()
    for repo in repos:
        for page in range(1, MAX_PAGES + 1):
            raw, has_next = fetch_page(repo, page)
            if type(raw) is not list or len(raw) > PAGE_SIZE or type(has_next) is not bool:
                _deny("GITHUB_PAGE_INVALID")
            if has_next != (len(raw) == PAGE_SIZE):
                # Invariant requires the next-page state and actual count to
                # agree, even at the last nonempty/empty page boundary.
                _deny("GITHUB_PAGE_PAGINATION_UNCERTAIN")
            for item in raw:
                normalized = _normalized_pr(item, repo)
                key = (repo, normalized["number"])
                if key in seen:
                    _deny("GITHUB_PR_DUPLICATE_DURING_PAGING")
                seen.add(key)
                result.append(normalized)
            if not has_next:
                break
        else:
            _deny("GITHUB_PAGE_LIMIT_EXCEEDED")
    return sorted(result, key=lambda row: (row["repository"], row["number"]))


def collect_complete_open_pr_inventory(
    *,
    expected_repositories: list[str],
    fetch_page: Callable[[str, int], tuple[list[Any], bool]],
    clock: Callable[[], datetime] = lambda: datetime.now(timezone.utc),
) -> dict[str, Any]:
    """Read each explicitly owner-authorized repository twice; mutation-free."""
    scope = _scope(expected_repositories)
    if not callable(fetch_page) or not callable(clock):
        _deny("GITHUB_INVENTORY_INPUT_INVALID")
    first = _collect(scope, fetch_page)
    second = _collect(scope, fetch_page)
    if first != second:
        _deny("GITHUB_INVENTORY_CHANGED_BETWEEN_SCANS")
    moment = clock()
    if not isinstance(moment, datetime) or moment.tzinfo is None or moment.utcoffset() is None:
        _deny("GITHUB_INVENTORY_CLOCK_INVALID")
    return {
        "complete": True,
        "observed_at": moment.astimezone(timezone.utc).isoformat(),
        "repositories": list(scope),
        "pull_requests": second,
    }


class _NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, request, fp, code, msg, headers, newurl):
        _deny("GITHUB_REDIRECT_DENIED")


class GitHubAppReadOnlyPages:
    """Exact GitHub.com HTTPS API with caller-supplied scoped installation token.

    Never uses PAT fallback, cookies or web browser credentials.
    """
    def __init__(self, app_installation_token: str):
        if type(app_installation_token) is not str or len(app_installation_token) < 10:
            _deny("GITHUB_APP_TOKEN_REQUIRED")
        self._token = app_installation_token
        self._opener = urllib.request.build_opener(_NoRedirect())

    def fetch_page(self, repo: str, page: int) -> tuple[list[Any], bool]:
        if type(repo) is not str or not REPO.fullmatch(repo) or type(page) is not int or page < 1 or page > MAX_PAGES:
            _deny("GITHUB_PAGE_ARGUMENT_INVALID")
        path = "/repos/" + repo + "/pulls"
        query = urllib.parse.urlencode({"state":"open","per_page":PAGE_SIZE,"page":page})
        url = "https://api.github.com" + path + "?" + query
        request = urllib.request.Request(url, headers={
            "Accept": "application/vnd.github+json",
            "Authorization": "Bearer " + self._token,
            "User-Agent": "bke-worker-readonly-inventory",
            "X-GitHub-Api-Version": "2022-11-28",
        }, method="GET")
        try:
            with self._opener.open(request, timeout=15) as response:
                data = response.read(MAX_PAGE_BYTES + 1)
                if len(data) > MAX_PAGE_BYTES:
                    _deny("GITHUB_PAGE_OVERSIZE")
                payload = json.loads(data.decode("utf-8"))
                links = response.headers.get("Link", "")
                # GitHub pagination uses Link rel="next" when another page
                # exists. Refuse unrecognizable next URLs and wrong endpoints.
                has_next = False
                for chunk in links.split(","):
                    if 'rel="next"' not in chunk:
                        continue
                    if has_next or not re.fullmatch(
                        r'<https://api\.github\.com/repos/[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+/pulls\?[^>]+>;\s*rel="next"',
                        chunk.strip(),
                    ):
                        _deny("GITHUB_PAGE_LINK_INVALID")
                    target = chunk.strip()[1:].split(">",1)[0]
                    parsed = urllib.parse.urlparse(target)
                    params = urllib.parse.parse_qs(parsed.query)
                    if (parsed.path != path or params != {
                        "state": ["open"], "per_page": [str(PAGE_SIZE)], "page": [str(page + 1)]
                    }):
                        _deny("GITHUB_PAGE_LINK_INVALID")
                    has_next = True
                if type(payload) is not list:
                    _deny("GITHUB_PAGE_INVALID")
                # A full last page can lack rel=next; make an extra request so
                # a missing link cannot silently truncate a full page.
                if len(payload) == PAGE_SIZE and not has_next:
                    has_next = True
                return payload, has_next
        except InventoryError:
            raise
        except (urllib.error.HTTPError, urllib.error.URLError, OSError, ValueError, UnicodeError):
            _deny("GITHUB_PAGE_UNAVAILABLE")
