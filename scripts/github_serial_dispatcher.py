#!/usr/bin/env python3
from __future__ import annotations

import hashlib
import json
import os
import re
from datetime import datetime, timezone
import sys
import urllib.error
import urllib.parse
import urllib.request
from dataclasses import dataclass
from enum import Enum
from typing import Any, Iterable

MASTER_LABEL = "bke-queue:master"
READY_LABEL = "bke-task:ready"
BLOCKED_LABEL = "bke-task:blocked"
WORKER_ID = "android-worker-a"
WORKER_LABEL = f"bke-worker:{WORKER_ID}"
PROGRESS_LEASE_SECONDS = 30 * 60
CONTINUATION_MARKER = "BKE-CONTINUATION-RESUME"
TASK_BRANCH_PREFIX = "bke/task-"
TRUSTED_ASSOCIATIONS = frozenset({"OWNER", "MEMBER", "COLLABORATOR"})
ACTIONS_PR_CREATION_DENIED_FRAGMENT = (
    "GitHub Actions is not permitted to create or approve pull requests"
)
CONTROL_LABELS = {
    MASTER_LABEL: ("5319e7", "BKE serial Master Queue"),
    READY_LABEL: ("0e8a16", "Authorized runnable BKE task"),
    BLOCKED_LABEL: ("d73a4a", "BKE task is blocked and not runnable"),
    WORKER_LABEL: ("1d76db", "Assigned to android-worker-a"),
}

_CHECKLIST_RE = re.compile(r"^(?P<prefix>\s*[-*]\s+)\[(?P<checked>[ xX])\](?P<rest>.*)$")
_ISSUE_URL_RE = re.compile(
    r"https://github\.com/(?P<owner>[A-Za-z0-9_.-]+)/(?P<repo>[A-Za-z0-9_.-]+)/issues/(?P<number>\d+)"
)
_HASH_REF_RE = re.compile(r"(?<![A-Za-z0-9_/])#(?P<number>\d+)\b")


class DispatchError(RuntimeError):
    pass


class WorkerState(str, Enum):
    FREE = "FREE"
    BUSY = "BUSY"
    CONFLICT = "CONFLICT"


@dataclass(frozen=True)
class TaskSnapshot:
    number: int
    title: str
    body: str
    state: str
    labels: frozenset[str]
    author_association: str

    @property
    def is_runnable(self) -> bool:
        return (
            self.state.lower() == "open"
            and self.author_association in TRUSTED_ASSOCIATIONS
            and READY_LABEL in self.labels
            and BLOCKED_LABEL not in self.labels
        )


def _labels(payload: dict[str, Any]) -> frozenset[str]:
    names: set[str] = set()
    for item in payload.get("labels") or []:
        value = item.get("name") if isinstance(item, dict) else item
        if isinstance(value, str) and value.strip():
            names.add(value.strip())
    return frozenset(names)


def issue_number_from_checklist_line(line: str, owner: str, repo: str) -> int | None:
    match = _CHECKLIST_RE.match(line)
    if not match:
        return None

    rest = match.group("rest")
    for url_match in _ISSUE_URL_RE.finditer(rest):
        if (
            url_match.group("owner").lower() == owner.lower()
            and url_match.group("repo").lower() == repo.lower()
        ):
            return int(url_match.group("number"))

    hash_match = _HASH_REF_RE.search(rest)
    if hash_match:
        return int(hash_match.group("number"))
    return None


def parse_master_checklist(body: str, owner: str, repo: str) -> list[int]:
    ordered: list[int] = []
    seen: set[int] = set()
    for line in body.splitlines():
        number = issue_number_from_checklist_line(line, owner, repo)
        if number is None or number in seen:
            continue
        seen.add(number)
        ordered.append(number)
    return ordered


def reconcile_master_checklist(
    body: str,
    owner: str,
    repo: str,
    states: dict[int, str],
) -> str:
    output: list[str] = []
    for line in body.splitlines():
        number = issue_number_from_checklist_line(line, owner, repo)
        if number is None or number not in states:
            output.append(line)
            continue

        match = _CHECKLIST_RE.match(line)
        if not match:
            output.append(line)
            continue

        desired = "x" if states[number].lower() == "closed" else " "
        output.append(f"{match.group('prefix')}[{desired}]{match.group('rest')}")
    suffix = "\n" if body.endswith("\n") else ""
    return "\n".join(output) + suffix


def classify_worker(open_assigned_prs: Iterable[int]) -> WorkerState:
    count = len(list(open_assigned_prs))
    if count == 0:
        return WorkerState.FREE
    if count == 1:
        return WorkerState.BUSY
    return WorkerState.CONFLICT


def choose_first_runnable(
    order: Iterable[int],
    tasks: dict[int, TaskSnapshot],
) -> TaskSnapshot | None:
    for number in order:
        task = tasks.get(number)
        if task is not None and task.is_runnable:
            return task
    return None


def task_branch(task_number: int) -> str:
    if task_number <= 0:
        raise ValueError("task number must be positive")
    return f"{TASK_BRANCH_PREFIX}{task_number}"


def materialization_commit_message(task_number: int) -> str:
    return f"chore(queue): materialize task #{task_number}"


def is_actions_pr_creation_denied(error: Exception) -> bool:
    return ACTIONS_PR_CREATION_DENIED_FRAGMENT.lower() in str(error).lower()


def validate_orphan_materialization(
    branch_commit: dict[str, Any],
    parent_commit: dict[str, Any],
    task_number: int,
) -> str:
    expected_message = materialization_commit_message(task_number)
    message = str(branch_commit.get("message") or "")
    parents = branch_commit.get("parents") or []
    branch_tree = ((branch_commit.get("tree") or {}).get("sha"))
    parent_tree = ((parent_commit.get("tree") or {}).get("sha"))

    if message != expected_message:
        raise DispatchError(
            "ORPHANED_TASK_BRANCH_UNSAFE: materialization commit message mismatch"
        )
    if len(parents) != 1:
        raise DispatchError(
            "ORPHANED_TASK_BRANCH_UNSAFE: expected exactly one materialization parent"
        )
    parent_sha = (parents[0] or {}).get("sha")
    if not isinstance(parent_sha, str) or len(parent_sha) != 40:
        raise DispatchError(
            "ORPHANED_TASK_BRANCH_UNSAFE: materialization parent SHA invalid"
        )
    if (
        not isinstance(branch_tree, str)
        or len(branch_tree) != 40
        or not isinstance(parent_tree, str)
        or len(parent_tree) != 40
        or branch_tree != parent_tree
    ):
        raise DispatchError(
            "ORPHANED_TASK_BRANCH_UNSAFE: orphan branch contains file changes"
        )
    return parent_sha


def extract_execution_checklist(body: str) -> list[tuple[str, str, bool]]:
    lines = body.splitlines()
    in_section = False
    entries: list[tuple[str, str, bool]] = []
    seen: set[str] = set()
    for line in lines:
        if line.strip().lower() == "## bke task checklist":
            in_section = True
            continue
        if in_section and line.startswith("## "):
            break
        if not in_section:
            continue
        match = re.match(r"^\s*[-*]\s+\[(?P<checked>[ xX])\]\s+\*\*(?P<id>[A-Z][A-Z0-9-]+)\s+—\s+(?P<text>.+?)\*\*\s*$", line)
        if not match:
            continue
        item_id = match.group("id")
        if item_id in seen:
            raise DispatchError(f"DUPLICATE_TASK_CHECKLIST_ITEM:{item_id}")
        seen.add(item_id)
        entries.append((item_id, match.group("text").strip(), match.group("checked").lower() == "x"))
    return entries


def ensure_execution_checklist(body: str) -> str:
    if extract_execution_checklist(body):
        return body
    return (
        body.rstrip()
        + "\n\n## BKE TASK CHECKLIST\n"
        + "- [ ] **TASK-1 — Complete and certify the authorized task contract above.**\n"
    )


def require_execution_checklist(body: str) -> None:
    if not extract_execution_checklist(ensure_execution_checklist(body)):
        raise DispatchError("TASK_PR_CHECKLIST_MISSING_OR_UNPARSEABLE")


def build_task_pr_body(task: TaskSnapshot, worker_id: str = WORKER_ID) -> str:
    task_body = ensure_execution_checklist(task.body)
    require_execution_checklist(task_body)
    return (
        "## BKE queued task\n\n"
        f"Materialized deterministically from task issue #{task.number} by the GitHub-native serial dispatcher.\n\n"
        f"Closes #{task.number}\n\n"
        "## Worker Delegation\n\n"
        f"- **Assigned worker ID:** `{worker_id}`\n"
        f"- **Required PR label:** `bke-worker:{worker_id}`\n\n"
        "Before engineering action, recover the canonical execution contract from current `main`, "
        "recover this PR from live GitHub, verify exact ownership/head, and continue only this task intent.\n\n"
        "## Task contract\n\n"
        f"{task.body.rstrip()}\n\n"
        "## Dispatcher boundary\n\n"
        "- GitHub is task authority.\n"
        "- This PR is the active execution ledger.\n"
        "- Cloudflare/Android are wake/executor layers only.\n"
        "- Do not invent unrelated work.\n"
        "- Production remains locked unless separately authorized.\n"
    )



def _parse_iso_timestamp(value: Any) -> datetime | None:
    if not isinstance(value, str) or not value:
        return None
    try:
        return datetime.fromisoformat(value.replace("Z", "+00:00")).astimezone(timezone.utc)
    except ValueError:
        return None


def continuation_generation(
    head_sha: str,
    checklist: list[tuple[str, str, bool]],
    latest_progress_id: str,
) -> str:
    canonical = json.dumps(
        {
            "head_sha": head_sha,
            "checklist": [(item_id, checked) for item_id, _, checked in checklist],
            "latest_progress_id": latest_progress_id,
        },
        separators=(",", ":"),
        sort_keys=True,
    )
    return hashlib.sha256(canonical.encode("utf-8")).hexdigest()[:24]


def continuation_marker(worker_id: str, pr_number: int, head_sha: str, generation: str) -> str:
    return (
        f"<!-- {CONTINUATION_MARKER} worker={worker_id} "
        f"pr={pr_number} head={head_sha} generation={generation} -->"
    )


def continuation_should_resume(
    *,
    now: datetime,
    head_sha: str,
    checklist: list[tuple[str, str, bool]],
    progress_at: datetime | None,
    active_certification: bool,
    terminal_or_blocked: bool,
    relay_uncertain: bool,
) -> bool:
    if not checklist or all(checked for _, _, checked in checklist):
        return False
    if terminal_or_blocked or active_certification or relay_uncertain:
        return False
    if progress_at is None:
        return False
    return (now.astimezone(timezone.utc) - progress_at.astimezone(timezone.utc)).total_seconds() >= PROGRESS_LEASE_SECONDS


class GitHubApi:
    def __init__(self, token: str, api_url: str, repository: str):
        if "/" not in repository:
            raise DispatchError("GITHUB_REPOSITORY must be owner/repo")
        self.token = token
        self.api_url = api_url.rstrip("/")
        self.repository = repository
        self.owner, self.repo = repository.split("/", 1)

    def request(
        self,
        method: str,
        path: str,
        payload: Any | None = None,
        *,
        allow_404: bool = False,
    ) -> Any:
        data = None
        headers = {
            "Accept": "application/vnd.github+json",
            "Authorization": f"Bearer {self.token}",
            "User-Agent": "bke-worker-serial-dispatcher",
            "X-GitHub-Api-Version": "2022-11-28",
        }
        if payload is not None:
            data = json.dumps(payload).encode("utf-8")
            headers["Content-Type"] = "application/json"

        request = urllib.request.Request(
            f"{self.api_url}{path}",
            data=data,
            headers=headers,
            method=method,
        )
        try:
            with urllib.request.urlopen(request, timeout=30) as response:
                raw = response.read()
                return json.loads(raw.decode("utf-8")) if raw else None
        except urllib.error.HTTPError as error:
            raw = error.read().decode("utf-8", errors="replace")
            if allow_404 and error.code == 404:
                return None
            raise DispatchError(
                f"GitHub API {method} {path} failed with {error.code}: {raw}"
            ) from error

    def paginate(self, path: str) -> list[dict[str, Any]]:
        separator = "&" if "?" in path else "?"
        page = 1
        results: list[dict[str, Any]] = []
        while True:
            batch = self.request("GET", f"{path}{separator}per_page=100&page={page}")
            if not isinstance(batch, list):
                raise DispatchError(f"Expected list response for {path}")
            results.extend(item for item in batch if isinstance(item, dict))
            if len(batch) < 100:
                return results
            page += 1

    def repo_metadata(self) -> dict[str, Any]:
        payload = self.request("GET", f"/repos/{self.repository}")
        if not isinstance(payload, dict):
            raise DispatchError("Repository metadata invalid")
        return payload

    def ensure_control_labels(self) -> None:
        for name, (color, description) in CONTROL_LABELS.items():
            encoded = urllib.parse.quote(name, safe="")
            existing = self.request(
                "GET",
                f"/repos/{self.repository}/labels/{encoded}",
                allow_404=True,
            )
            if existing is not None:
                continue

            created = self.request(
                "POST",
                f"/repos/{self.repository}/labels",
                {
                    "name": name,
                    "color": color,
                    "description": description,
                },
            )
            if not isinstance(created, dict) or created.get("name") != name:
                raise DispatchError(f"CONTROL_LABEL_BOOTSTRAP_FAILED: {name}")

    def open_master_issues(self) -> list[dict[str, Any]]:
        encoded = urllib.parse.quote(MASTER_LABEL)
        issues = self.paginate(
            f"/repos/{self.repository}/issues?state=open&labels={encoded}"
        )
        return [issue for issue in issues if "pull_request" not in issue]

    def get_issue(self, number: int) -> dict[str, Any]:
        payload = self.request("GET", f"/repos/{self.repository}/issues/{number}")
        if not isinstance(payload, dict):
            raise DispatchError(f"Issue #{number} payload invalid")
        if "pull_request" in payload:
            raise DispatchError(
                f"Master checklist reference #{number} is a pull request, not a task issue"
            )
        return payload

    def get_pull_request(self, number: int) -> dict[str, Any]:
        payload = self.request("GET", f"/repos/{self.repository}/pulls/{number}")
        if not isinstance(payload, dict):
            raise DispatchError(f"Pull request #{number} payload invalid")
        return payload

    def list_issue_comments(self, number: int) -> list[dict[str, Any]]:
        return self.paginate(f"/repos/{self.repository}/issues/{number}/comments")

    def get_commit(self, sha: str) -> dict[str, Any]:
        payload = self.request("GET", f"/repos/{self.repository}/commits/{sha}")
        if not isinstance(payload, dict):
            raise DispatchError(f"Commit {sha} payload invalid")
        return payload

    def active_workflow_runs_for_sha(self, sha: str) -> list[dict[str, Any]]:
        encoded = urllib.parse.quote(sha, safe="")
        payload = self.request(
            "GET",
            f"/repos/{self.repository}/actions/runs?head_sha={encoded}&per_page=100",
        )
        if not isinstance(payload, dict):
            raise DispatchError("Workflow run payload invalid")
        runs = payload.get("workflow_runs") or []
        return [
            item for item in runs
            if isinstance(item, dict) and item.get("status") in {"queued", "in_progress"}
        ]

    def add_issue_comment(self, number: int, body: str) -> None:
        self.request(
            "POST",
            f"/repos/{self.repository}/issues/{number}/comments",
            {"body": body},
        )

    def update_issue_body(self, number: int, body: str) -> None:
        self.request(
            "PATCH",
            f"/repos/{self.repository}/issues/{number}",
            {"body": body},
        )

    def search_open_worker_prs(self) -> list[dict[str, Any]]:
        query = f'is:pr is:open label:"{WORKER_LABEL}" user:{self.owner}'
        encoded = urllib.parse.quote(query)
        payload = self.request("GET", f"/search/issues?q={encoded}&per_page=100")
        if not isinstance(payload, dict):
            raise DispatchError("Worker PR search payload invalid")
        return [item for item in payload.get("items") or [] if isinstance(item, dict)]

    def get_branch_ref(self, branch: str) -> dict[str, Any] | None:
        encoded = urllib.parse.quote(branch, safe="/")
        payload = self.request(
            "GET",
            f"/repos/{self.repository}/git/ref/heads/{encoded}",
            allow_404=True,
        )
        if payload is not None and not isinstance(payload, dict):
            raise DispatchError(f"Branch ref payload invalid for {branch}")
        return payload

    def open_task_prs(self, branch: str) -> list[dict[str, Any]]:
        head = urllib.parse.quote(f"{self.owner}:{branch}")
        return self.paginate(
            f"/repos/{self.repository}/pulls?state=open&head={head}"
        )

    def materialize_branch(
        self,
        branch: str,
        base_branch: str,
        task_number: int,
    ) -> None:
        base_ref = self.get_branch_ref(base_branch)
        if base_ref is None:
            raise DispatchError(f"Default branch {base_branch} not found")
        base_sha = ((base_ref.get("object") or {}).get("sha"))
        if not isinstance(base_sha, str) or len(base_sha) != 40:
            raise DispatchError("Default branch SHA invalid")

        commit = self.request(
            "GET",
            f"/repos/{self.repository}/git/commits/{base_sha}",
        )
        tree_sha = ((commit or {}).get("tree") or {}).get("sha")
        if not isinstance(tree_sha, str) or len(tree_sha) != 40:
            raise DispatchError("Default branch tree SHA invalid")

        created = self.request(
            "POST",
            f"/repos/{self.repository}/git/commits",
            {
                "message": materialization_commit_message(task_number),
                "tree": tree_sha,
                "parents": [base_sha],
            },
        )
        commit_sha = (created or {}).get("sha")
        if not isinstance(commit_sha, str) or len(commit_sha) != 40:
            raise DispatchError("Materialization commit SHA invalid")

        self.request(
            "POST",
            f"/repos/{self.repository}/git/refs",
            {"ref": f"refs/heads/{branch}", "sha": commit_sha},
        )

    def recover_orphaned_task_branch(
        self,
        branch: str,
        base_branch: str,
        task_number: int,
    ) -> None:
        branch_ref = self.get_branch_ref(branch)
        if branch_ref is None:
            raise DispatchError(f"Orphan branch {branch} disappeared during recovery")
        branch_sha = ((branch_ref.get("object") or {}).get("sha"))
        if not isinstance(branch_sha, str) or len(branch_sha) != 40:
            raise DispatchError("ORPHANED_TASK_BRANCH_UNSAFE: branch SHA invalid")

        branch_commit = self.request(
            "GET",
            f"/repos/{self.repository}/git/commits/{branch_sha}",
        )
        if not isinstance(branch_commit, dict):
            raise DispatchError(
                "ORPHANED_TASK_BRANCH_UNSAFE: branch commit payload invalid"
            )
        parents = branch_commit.get("parents") or []
        if len(parents) != 1:
            raise DispatchError(
                "ORPHANED_TASK_BRANCH_UNSAFE: expected one branch parent"
            )
        original_parent_sha = (parents[0] or {}).get("sha")
        if not isinstance(original_parent_sha, str) or len(original_parent_sha) != 40:
            raise DispatchError(
                "ORPHANED_TASK_BRANCH_UNSAFE: original parent SHA invalid"
            )
        original_parent = self.request(
            "GET",
            f"/repos/{self.repository}/git/commits/{original_parent_sha}",
        )
        if not isinstance(original_parent, dict):
            raise DispatchError(
                "ORPHANED_TASK_BRANCH_UNSAFE: parent commit payload invalid"
            )
        validate_orphan_materialization(
            branch_commit,
            original_parent,
            task_number,
        )

        base_ref = self.get_branch_ref(base_branch)
        if base_ref is None:
            raise DispatchError(f"Default branch {base_branch} not found")
        base_sha = ((base_ref.get("object") or {}).get("sha"))
        if not isinstance(base_sha, str) or len(base_sha) != 40:
            raise DispatchError("Default branch SHA invalid")

        if original_parent_sha == base_sha:
            return

        base_commit = self.request(
            "GET",
            f"/repos/{self.repository}/git/commits/{base_sha}",
        )
        base_tree_sha = ((base_commit or {}).get("tree") or {}).get("sha")
        if not isinstance(base_tree_sha, str) or len(base_tree_sha) != 40:
            raise DispatchError("Default branch tree SHA invalid")

        refreshed = self.request(
            "GET",
            f"/repos/{self.repository}/git/ref/heads/{urllib.parse.quote(branch, safe='/')}",
        )
        refreshed_sha = ((refreshed or {}).get("object") or {}).get("sha")
        if refreshed_sha != branch_sha:
            raise DispatchError(
                "ORPHANED_TASK_BRANCH_UNSAFE: branch changed during recovery"
            )

        created = self.request(
            "POST",
            f"/repos/{self.repository}/git/commits",
            {
                "message": materialization_commit_message(task_number),
                "tree": base_tree_sha,
                "parents": [base_sha],
            },
        )
        new_sha = (created or {}).get("sha")
        if not isinstance(new_sha, str) or len(new_sha) != 40:
            raise DispatchError("Recovered materialization commit SHA invalid")

        encoded = urllib.parse.quote(branch, safe="/")
        self.request(
            "PATCH",
            f"/repos/{self.repository}/git/refs/heads/{encoded}",
            {"sha": new_sha, "force": True},
        )

    def create_draft_pr(
        self,
        task: TaskSnapshot,
        branch: str,
        base_branch: str,
    ) -> dict[str, Any]:
        try:
            payload = self.request(
                "POST",
                f"/repos/{self.repository}/pulls",
                {
                    "title": f"task #{task.number}: {task.title}",
                    "head": branch,
                    "base": base_branch,
                    "body": build_task_pr_body(task),
                    "draft": True,
                    "maintainer_can_modify": True,
                },
            )
        except DispatchError as error:
            if is_actions_pr_creation_denied(error):
                raise DispatchError(
                    "OWNER_GATE_ACTIONS_PR_CREATION_DISABLED: "
                    "enable repository Settings -> Actions -> General -> "
                    "Workflow permissions -> Allow GitHub Actions to create "
                    "and approve pull requests; or run "
                    "scripts/enable-serial-dispatcher-pr-creation.sh "
                    "with a human-authenticated GitHub CLI session"
                ) from error
            raise

        if not isinstance(payload, dict):
            raise DispatchError("Created PR payload invalid")
        return payload

    def add_worker_label(self, pr_number: int) -> None:
        self.request(
            "POST",
            f"/repos/{self.repository}/issues/{pr_number}/labels",
            {"labels": [WORKER_LABEL]},
        )


def task_snapshot(payload: dict[str, Any]) -> TaskSnapshot:
    return TaskSnapshot(
        number=int(payload["number"]),
        title=str(payload.get("title") or "").strip(),
        body=str(payload.get("body") or ""),
        state=str(payload.get("state") or ""),
        labels=_labels(payload),
        author_association=str(payload.get("author_association") or "NONE").upper(),
    )


def _worker_labels(payload: dict[str, Any]) -> list[str]:
    return sorted(
        label
        for label in _labels(payload)
        if label.lower().startswith("bke-worker:")
    )


def request_continuation(api: GitHubApi) -> dict[str, Any]:
    assigned = api.search_open_worker_prs()
    if len(assigned) != 1:
        return {
            "state": "WAITING",
            "reason": "CONTINUATION_NOT_SINGLE_OWNER",
            "assigned_prs": len(assigned),
        }

    pr_number = int(assigned[0]["number"])
    pr = api.get_pull_request(pr_number)
    if str(pr.get("state") or "").lower() != "open":
        return {"state": "WAITING", "reason": "PR_NOT_OPEN"}

    body = str(pr.get("body") or "")
    checklist = extract_execution_checklist(body)
    if not checklist:
        raise DispatchError("CONTINUATION_CHECKLIST_MISSING")
    if all(checked for _, _, checked in checklist):
        return {"state": "WAITING", "reason": "CHECKLIST_COMPLETE", "pr": pr_number}

    comments = api.list_issue_comments(pr_number)
    progress_events = [
        comment for comment in comments
        if isinstance(comment, dict)
        and isinstance(comment.get("body"), str)
        and (
            comment["body"].startswith("BKE EXECUTION CHECKPOINT —")
            or comment["body"].startswith("BKE CONTINUATION CHECKPOINT —")
        )
    ]
    progress_events.sort(key=lambda item: str(item.get("created_at") or ""))
    latest_progress = progress_events[-1] if progress_events else None

    head_sha = str((pr.get("head") or {}).get("sha") or "")
    if not re.fullmatch(r"[0-9a-f]{40}", head_sha):
        raise DispatchError("CONTINUATION_HEAD_INVALID")
    head_commit = api.get_commit(head_sha)
    commit_date = _parse_iso_timestamp(
        ((head_commit.get("commit") or {}).get("committer") or {}).get("date")
    )
    progress_at = commit_date
    if latest_progress:
        progress_at = max(
            [value for value in [commit_date, _parse_iso_timestamp(latest_progress.get("created_at"))] if value],
            default=commit_date,
        )

    active_certification = bool(api.active_workflow_runs_for_sha(head_sha))
    terminal_or_blocked = (
        "BKE EXECUTION CHECKPOINT — READY_FOR_AUDIT" in body
        or any(
            isinstance(item.get("body"), str) and (
                "BKE EXECUTION CHECKPOINT — READY_FOR_AUDIT" in item["body"]
                or "BKE EXECUTION CHECKPOINT — BLOCKED" in item["body"]
            )
            for item in comments
        )
    )
    relay_events = [
        item for item in comments
        if isinstance(item, dict)
        and isinstance(item.get("body"), str)
        and item["body"].startswith("BKE RELAY —")
    ]
    relay_events.sort(key=lambda item: str(item.get("created_at") or ""))
    latest_relay = relay_events[-1] if relay_events else None
    relay_uncertain = bool(
        latest_relay and re.search(r"BKE RELAY — (?:sent|accepted|deferred|conflict|recovery_required)", latest_relay["body"], re.I)
    )

    if not continuation_should_resume(
        now=datetime.now(timezone.utc),
        head_sha=head_sha,
        checklist=checklist,
        progress_at=progress_at,
        active_certification=active_certification,
        terminal_or_blocked=terminal_or_blocked,
        relay_uncertain=relay_uncertain,
    ):
        return {"state": "WAITING", "reason": "CONTINUATION_NOT_SAFE_OR_LEASE_ACTIVE", "pr": pr_number}

    latest_progress_id = str(latest_progress.get("id") if latest_progress else head_sha)
    generation = continuation_generation(head_sha, checklist, latest_progress_id)
    marker = continuation_marker(WORKER_ID, pr_number, head_sha, generation)
    if marker not in body:
        new_body = re.sub(r"<!-- BKE-CONTINUATION-RESUME worker=[^>]+ -->\s*", "", body)
        new_body = new_body.rstrip() + "\n\n" + marker + "\n"
        api.update_issue_body(pr_number, new_body)

    checkpoint = (
        "BKE CONTINUATION CHECKPOINT — RESUME_REQUESTED\n"
        f"worker={WORKER_ID}\npr=#{pr_number}\nhead={head_sha}\n"
        f"generation={generation}\nreason=progress_lease_expired"
    )
    if not any(
        isinstance(item.get("body"), str) and f"generation={generation}" in item["body"]
        and item["body"].startswith("BKE CONTINUATION CHECKPOINT — RESUME_REQUESTED")
        for item in comments
    ):
        api.add_issue_comment(pr_number, checkpoint)

    return {
        "state": "CONTINUATION_REQUESTED",
        "pr": pr_number,
        "head": head_sha,
        "generation": generation,
    }


def reconcile(api: GitHubApi) -> dict[str, Any]:
    api.ensure_control_labels()
    masters = api.open_master_issues()
    if len(masters) == 0:
        return {"state": "WAITING", "reason": "NO_MASTER_QUEUE"}
    if len(masters) > 1:
        raise DispatchError(
            "AMBIGUOUS_MASTER_QUEUE: expected exactly one open issue labeled "
            f"{MASTER_LABEL}, found {len(masters)}"
        )

    master = masters[0]
    master_association = str(master.get("author_association") or "NONE").upper()
    if master_association not in TRUSTED_ASSOCIATIONS:
        raise DispatchError(
            f"UNTRUSTED_MASTER_QUEUE: author_association={master_association}"
        )
    master_number = int(master["number"])
    master_body = str(master.get("body") or "")
    order = parse_master_checklist(master_body, api.owner, api.repo)

    tasks: dict[int, TaskSnapshot] = {}
    states: dict[int, str] = {}
    for number in order:
        if number == master_number:
            raise DispatchError("Master queue cannot reference itself as a task")
        snapshot = task_snapshot(api.get_issue(number))
        tasks[number] = snapshot
        states[number] = snapshot.state

    reconciled_body = reconcile_master_checklist(
        master_body,
        api.owner,
        api.repo,
        states,
    )
    if reconciled_body != master_body:
        api.update_issue_body(master_number, reconciled_body)

    assigned = api.search_open_worker_prs()
    worker_state = classify_worker(int(item["number"]) for item in assigned)
    if worker_state == WorkerState.CONFLICT:
        refs = [
            str(item.get("html_url") or item.get("url") or item.get("number"))
            for item in assigned
        ]
        raise DispatchError(
            "WORKER_OWNERSHIP_CONFLICT: "
            f"{WORKER_LABEL} owns {len(assigned)} open PRs: {', '.join(refs)}"
        )
    if worker_state == WorkerState.BUSY:
        current = assigned[0]
        return {
            "state": "BUSY",
            "reason": "WORKER_ALREADY_ASSIGNED",
            "worker": WORKER_ID,
            "active_pr": current.get("html_url") or current.get("url"),
        }

    task = choose_first_runnable(order, tasks)
    if task is None:
        return {"state": "WAITING", "reason": "NO_RUNNABLE_TASK"}

    branch = task_branch(task.number)
    existing_prs = api.open_task_prs(branch)
    if len(existing_prs) > 1:
        raise DispatchError(
            f"TASK_MATERIALIZATION_CONFLICT: branch {branch} has {len(existing_prs)} open PRs"
        )
    if len(existing_prs) == 1:
        pr = existing_prs[0]
        labels = _worker_labels(pr)
        if len(labels) > 1:
            raise DispatchError(
                f"TASK_ASSIGNMENT_CONFLICT: PR #{pr.get('number')} has multiple worker labels"
            )
        if len(labels) == 1 and labels[0].lower() != WORKER_LABEL.lower():
            raise DispatchError(
                f"TASK_ASSIGNMENT_CONFLICT: PR #{pr.get('number')} belongs to {labels[0]}"
            )
        if len(labels) == 0:
            api.add_worker_label(int(pr["number"]))
        return {
            "state": "DISPATCHED",
            "reason": "ASSIGNED_EXISTING_TASK_PR",
            "task": task.number,
            "pr": pr.get("html_url") or pr.get("url"),
            "worker": WORKER_ID,
        }

    repository = api.repo_metadata()
    base_branch = str(repository.get("default_branch") or "").strip()
    if not base_branch:
        raise DispatchError("Repository default branch missing")

    orphaned = api.get_branch_ref(branch) is not None
    if orphaned:
        api.recover_orphaned_task_branch(branch, base_branch, task.number)
    else:
        api.materialize_branch(branch, base_branch, task.number)

    pr = api.create_draft_pr(task, branch, base_branch)
    pr_number = int(pr["number"])
    api.add_worker_label(pr_number)

    return {
        "state": "DISPATCHED",
        "reason": (
            "RECOVERED_ORPHANED_TASK_BRANCH"
            if orphaned
            else "MATERIALIZED_NEW_TASK_PR"
        ),
        "task": task.number,
        "pr": pr.get("html_url") or pr.get("url"),
        "worker": WORKER_ID,
    }


def main() -> int:
    token = os.environ.get("GITHUB_TOKEN", "").strip()
    repository = os.environ.get("GITHUB_REPOSITORY", "").strip()
    api_url = os.environ.get("GITHUB_API_URL", "https://api.github.com").strip()
    requested_worker = os.environ.get("BKE_WORKER_ID", WORKER_ID).strip()

    if requested_worker != WORKER_ID:
        print(
            f"BKE serial dispatcher: unsupported worker_id {requested_worker}; v1 is {WORKER_ID} only",
            file=sys.stderr,
        )
        return 2
    if not token:
        print("BKE serial dispatcher: GITHUB_TOKEN is required", file=sys.stderr)
        return 2
    if not repository:
        print("BKE serial dispatcher: GITHUB_REPOSITORY is required", file=sys.stderr)
        return 2

    try:
        api = GitHubApi(token, api_url, repository)
        result = request_continuation(api) if os.environ.get("BKE_CONTINUATION_ONLY") == "true" else reconcile(api)
    except DispatchError as error:
        print(f"BKE serial dispatcher FAIL-CLOSED: {error}", file=sys.stderr)
        return 3

    print(json.dumps(result, sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
