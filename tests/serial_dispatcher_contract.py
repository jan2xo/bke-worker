#!/usr/bin/env python3
from __future__ import annotations

import importlib.util
from pathlib import Path
import sys
import unittest
from datetime import datetime, timedelta, timezone


ROOT = Path(__file__).resolve().parents[1]
SCRIPT = ROOT / "scripts/github_serial_dispatcher.py"
PR_CREATION_BOOTSTRAP = ROOT / "scripts/enable-serial-dispatcher-pr-creation.sh"
SPEC = importlib.util.spec_from_file_location("bke_serial_dispatcher", SCRIPT)
assert SPEC is not None and SPEC.loader is not None
dispatcher = importlib.util.module_from_spec(SPEC)
sys.modules[SPEC.name] = dispatcher
SPEC.loader.exec_module(dispatcher)


def issue(
    number,
    title,
    state="open",
    labels=(),
    body="task body",
    author_association="OWNER",
):
    return {
        "number": number,
        "title": title,
        "state": state,
        "body": body,
        "labels": [{"name": label} for label in labels],
        "author_association": author_association,
    }


class FakeApi:
    owner = "jan2xo"
    repo = "bke-worker"

    def __init__(
        self,
        *,
        masters=None,
        issues=None,
        assigned=None,
        task_prs=None,
        branches=None,
    ):
        self._masters = list(masters or [])
        self._issues = dict(issues or {})
        self._assigned = list(assigned or [])
        self._task_prs = dict(task_prs or {})
        self._branches = set(branches or [])
        self.updated_master = None
        self.materialized = []
        self.recovered = []
        self.created = []
        self.labeled = []
        self.label_bootstrap_calls = 0

    def ensure_control_labels(self):
        self.label_bootstrap_calls += 1

    def open_master_issues(self):
        return self._masters

    def get_issue(self, number):
        return self._issues[number]

    def update_issue_body(self, number, body):
        self.updated_master = (number, body)

    def search_open_worker_prs(self):
        return self._assigned

    def open_task_prs(self, branch):
        return list(self._task_prs.get(branch, []))

    def get_branch_ref(self, branch):
        return {"ref": branch} if branch in self._branches else None

    def repo_metadata(self):
        return {"default_branch": "main"}

    def materialize_branch(self, branch, base_branch, task_number):
        self.materialized.append((branch, base_branch, task_number))
        self._branches.add(branch)

    def recover_orphaned_task_branch(self, branch, base_branch, task_number):
        self.recovered.append((branch, base_branch, task_number))

    def create_draft_pr(self, task, branch, base_branch):
        created = {
            "number": 900 + task.number,
            "html_url": f"https://github.com/jan2xo/bke-worker/pull/{900 + task.number}",
            "labels": [],
        }
        self.created.append((task.number, branch, base_branch))
        return created

    def add_worker_label(self, pr_number):
        self.labeled.append(pr_number)


class RecordingLabelApi(dispatcher.GitHubApi):
    def __init__(self, existing=()):
        super().__init__("token", "https://api.example.test", "jan2xo/bke-worker")
        self.existing = set(existing)
        self.created = []

    def request(self, method, path, payload=None, *, allow_404=False):
        if method == "GET" and "/labels/" in path:
            name = path.rsplit("/", 1)[-1]
            import urllib.parse
            decoded = urllib.parse.unquote(name)
            return {"name": decoded} if decoded in self.existing else None
        if method == "POST" and path.endswith("/labels"):
            self.created.append(dict(payload))
            self.existing.add(payload["name"])
            return {"name": payload["name"]}
        raise AssertionError(f"Unexpected request: {method} {path}")


class FakeContinuationApi:
    def __init__(self, *, active_ci=False):
        self.active_ci = active_ci
        self.pr = {
            "number": 82,
            "state": "open",
            "body": "## BKE TASK CHECKLIST\\n- [ ] **A1 — perform authorized work.**",
            "head": {"sha": "a" * 40},
        }
        self.comments = [
            {
                "id": 100,
                "created_at": "2020-01-01T00:00:00Z",
                "body": "BKE EXECUTION CHECKPOINT — IMPLEMENTED\\nhead=" + "a" * 40,
            },
        ]
        self.edits = []
        self.created_comments = []

    def search_open_worker_prs(self):
        return [{"number": 82}]

    def get_pull_request(self, number):
        assert number == 82
        return self.pr

    def list_issue_comments(self, number):
        assert number == 82
        return list(self.comments)

    def get_commit(self, sha):
        assert sha == "a" * 40
        return {"commit": {"committer": {"date": "2020-01-01T00:00:00Z"}}}

    def active_workflow_runs_for_sha(self, sha):
        return []

    def active_required_certification_runs(self):
        return self.active_ci

    def update_issue_body(self, number, body):
        assert number == 82
        self.pr["body"] = body
        self.edits.append(body)

    def add_issue_comment(self, number, body):
        assert number == 82
        self.created_comments.append(body)
        self.comments.append({
            "id": 200 + len(self.created_comments),
            "created_at": datetime.now(timezone.utc).isoformat(),
            "body": body,
        })


class FakeCertificationRunsApi(dispatcher.GitHubApi):
    def __init__(self, statuses=()):
        super().__init__("test-only", "https://api.test", "jan2xo/bke-worker")
        self.active_statuses = set(statuses)
        self.requested_statuses = []

    def request(self, method, path, payload=None, *, allow_404=False):
        assert method == "GET"
        assert "/actions/workflows/certify.yml/runs?" in path
        status = path.split("status=", 1)[1].split("&", 1)[0]
        self.requested_statuses.append(status)
        return {"workflow_runs": [{"status": status}] if status in self.active_statuses else []}


class SerialDispatcherTests(unittest.TestCase):
    def test_resume_requested_is_not_progress_and_is_deduped(self):
        api = FakeContinuationApi()
        first = dispatcher.request_continuation(api)
        self.assertEqual(first["state"], "CONTINUATION_REQUESTED")
        self.assertEqual(len(api.edits), 1)
        self.assertEqual(len(api.created_comments), 1)
        self.assertIn("RESUME_REQUESTED", api.created_comments[0])

        second = dispatcher.request_continuation(api)
        self.assertEqual(second, {
            "state": "WAITING",
            "reason": "RESUME_ALREADY_REQUESTED",
            "pr": 82,
        })
        self.assertEqual(len(api.edits), 1)
        self.assertEqual(len(api.created_comments), 1)

    def test_running_issue_comment_certification_suppresses_resume(self):
        api = FakeContinuationApi(active_ci=True)
        result = dispatcher.request_continuation(api)
        self.assertEqual(result["state"], "WAITING")
        self.assertEqual(result["reason"], "CONTINUATION_NOT_SAFE_OR_LEASE_ACTIVE")
        self.assertEqual(api.edits, [])
        self.assertEqual(api.created_comments, [])

    def test_issue_comment_ci_query_is_not_pr_head_sha_only(self):
        active = FakeCertificationRunsApi(statuses=("in_progress",))
        self.assertTrue(active.active_required_certification_runs())
        self.assertEqual(active.requested_statuses, ["queued", "in_progress"])
        idle = FakeCertificationRunsApi()
        self.assertFalse(idle.active_required_certification_runs())
        self.assertEqual(idle.requested_statuses, ["queued", "in_progress", "waiting"])

    def test_execution_checklist_is_machine_recognizable(self):
        body = """## BKE TASK CHECKLIST
- [ ] **A1 — Authoritative assignment discovery.**
- [x] **A2 — Zero / one / multiple assignment proof.**
## Certification
"""
        entries = dispatcher.extract_execution_checklist(body)
        self.assertEqual(entries[0][0], "A1")
        self.assertFalse(entries[0][2])
        self.assertEqual(entries[1][0], "A2")
        self.assertTrue(entries[1][2])

    def test_execution_checklist_adds_stable_fallback_cursor(self):
        body = dispatcher.ensure_execution_checklist("## Task contract\nNo checklist")
        entries = dispatcher.extract_execution_checklist(body)
        self.assertEqual(entries, [("TASK-1", "Complete and certify the authorized task contract above.", False)])
        dispatcher.require_execution_checklist(body)

    def test_execution_checklist_rejects_duplicate_ids(self):
        with self.assertRaisesRegex(dispatcher.DispatchError, "DUPLICATE_TASK_CHECKLIST_ITEM:A1"):
            dispatcher.extract_execution_checklist(
                "## BKE TASK CHECKLIST\n- [ ] **A1 — one**\n- [ ] **A1 — duplicate**"
            )

    def test_progress_lease_requires_unresolved_safe_work(self):
        checklist = [("A1", "assignment", False), ("A2", "proof", True)]
        now = datetime.now(timezone.utc)
        self.assertFalse(
            dispatcher.continuation_should_resume(
                now=now,
                head_sha="a" * 40,
                checklist=checklist,
                progress_at=now - timedelta(minutes=29),
                active_certification=False,
                terminal_or_blocked=False,
                relay_uncertain=False,
            )
        )
        self.assertTrue(
            dispatcher.continuation_should_resume(
                now=now,
                head_sha="a" * 40,
                checklist=checklist,
                progress_at=now - timedelta(minutes=30),
                active_certification=False,
                terminal_or_blocked=False,
                relay_uncertain=False,
            )
        )
        for blocked in (True,):
            self.assertFalse(
                dispatcher.continuation_should_resume(
                    now=now,
                    head_sha="a" * 40,
                    checklist=checklist,
                    progress_at=now - timedelta(minutes=31),
                    active_certification=False,
                    terminal_or_blocked=blocked,
                    relay_uncertain=False,
                )
            )

    def test_continuation_generation_changes_only_on_meaningful_progress(self):
        checklist = [("A1", "assignment", False)]
        first = dispatcher.continuation_generation("a" * 40, checklist, "1")
        same = dispatcher.continuation_generation("a" * 40, checklist, "1")
        head_progress = dispatcher.continuation_generation("b" * 40, checklist, "1")
        checkpoint_progress = dispatcher.continuation_generation("a" * 40, checklist, "2")
        self.assertEqual(first, same)
        self.assertNotEqual(first, head_progress)
        self.assertNotEqual(first, checkpoint_progress)

    def test_continuation_marker_is_bounded_metadata(self):
        marker = dispatcher.continuation_marker(
            "android-worker-a",
            82,
            "a" * 40,
            "0123456789abcdef01234567",
        )
        self.assertIn("BKE-CONTINUATION-RESUME", marker)
        self.assertNotIn("prompt=", marker)
        self.assertNotIn("javascript=", marker)
        self.assertNotIn("shell=", marker)

    def test_long_run_cursor_progresses_then_stops_at_terminal_state(self):
        now = datetime.now(timezone.utc)
        checklist = [("A1", "assignment", False), ("A2", "proof", False)]
        self.assertTrue(
            dispatcher.continuation_should_resume(
                now=now, head_sha="a" * 40, checklist=checklist,
                progress_at=now - timedelta(minutes=31),
                active_certification=False, terminal_or_blocked=False, relay_uncertain=False,
            )
        )
        generation_one = dispatcher.continuation_generation("a" * 40, checklist, "checkpoint-1")
        progressed = [("A1", "assignment", True), ("A2", "proof", False)]
        generation_two = dispatcher.continuation_generation("b" * 40, progressed, "checkpoint-2")
        self.assertNotEqual(generation_one, generation_two)
        self.assertFalse(
            dispatcher.continuation_should_resume(
                now=now, head_sha="b" * 40, checklist=progressed,
                progress_at=now - timedelta(minutes=31),
                active_certification=False, terminal_or_blocked=True, relay_uncertain=False,
            )
        )

    def test_checkpoint_reconciliation_requires_every_item_and_fresh_head(self):
        checklist = [("A1", "assignment", False), ("A2", "proof", False)]
        reconciled, unresolved = dispatcher.reconcile_execution_checkpoint(
            checklist,
            {"A1": "DONE", "A2": "BLOCKED"},
            exact_head="a" * 40,
            certified_head=None,
        )
        self.assertEqual(reconciled, {"A1": "DONE", "A2": "BLOCKED"})
        self.assertEqual(unresolved, ["A2"])
        with self.assertRaisesRegex(dispatcher.DispatchError, "CHECKPOINT_RECONCILIATION_INVALID"):
            dispatcher.reconcile_execution_checkpoint(
                checklist, {"A1": "DONE"}, exact_head="a" * 40, certified_head=None
            )
        with self.assertRaisesRegex(dispatcher.DispatchError, "CHECKPOINT_CERTIFICATION_STALE_HEAD"):
            dispatcher.reconcile_execution_checkpoint(
                checklist, {"A1": "DONE", "A2": "DONE"},
                exact_head="a" * 40, certified_head="b" * 40
            )

    def test_ready_for_audit_requires_complete_fresh_certification(self):
        complete = {"A1": "DONE", "A2": "NOT_REQUIRED"}
        self.assertTrue(
            dispatcher.ready_for_audit_allowed(
                complete, exact_head="a" * 40, certified_head="a" * 40,
                required_certification_complete=True,
            )
        )
        self.assertFalse(
            dispatcher.ready_for_audit_allowed(
                {"A1": "DONE", "A2": "BLOCKED"}, exact_head="a" * 40,
                certified_head="a" * 40, required_certification_complete=True,
            )
        )
        self.assertFalse(
            dispatcher.ready_for_audit_allowed(
                complete, exact_head="a" * 40, certified_head="b" * 40,
                required_certification_complete=True,
            )
        )

    def test_control_label_contract_is_bounded(self):
        self.assertEqual(
            set(dispatcher.CONTROL_LABELS),
            {
                dispatcher.MASTER_LABEL,
                dispatcher.READY_LABEL,
                dispatcher.BLOCKED_LABEL,
                dispatcher.WORKER_LABEL,
            },
        )

    def test_control_label_bootstrap_is_idempotent(self):
        api = RecordingLabelApi(
            existing=[dispatcher.MASTER_LABEL, dispatcher.WORKER_LABEL]
        )
        api.ensure_control_labels()
        self.assertEqual(
            {item["name"] for item in api.created},
            {dispatcher.READY_LABEL, dispatcher.BLOCKED_LABEL},
        )
        api.ensure_control_labels()
        self.assertEqual(len(api.created), 2)

    def test_master_checklist_preserves_order_and_deduplicates(self):
        body = """# Queue
- [ ] First #12
- [ ] Second https://github.com/jan2xo/bke-worker/issues/7
- [ ] Duplicate #12
- [x] Closed #19
"""
        self.assertEqual(
            dispatcher.parse_master_checklist(body, "jan2xo", "bke-worker"),
            [12, 7, 19],
        )

    def test_external_issue_url_is_not_imported(self):
        body = "- [ ] external https://github.com/other/repo/issues/55"
        self.assertEqual(
            dispatcher.parse_master_checklist(body, "jan2xo", "bke-worker"),
            [],
        )

    def test_reconcile_master_checkboxes_mirror_issue_state(self):
        body = "- [ ] A #1\n- [x] B #2\n"
        actual = dispatcher.reconcile_master_checklist(
            body,
            "jan2xo",
            "bke-worker",
            {1: "closed", 2: "open"},
        )
        self.assertEqual(actual, "- [x] A #1\n- [ ] B #2\n")

    def test_worker_free_busy_conflict(self):
        self.assertEqual(
            dispatcher.classify_worker([]),
            dispatcher.WorkerState.FREE,
        )
        self.assertEqual(
            dispatcher.classify_worker([1]),
            dispatcher.WorkerState.BUSY,
        )
        self.assertEqual(
            dispatcher.classify_worker([1, 2]),
            dispatcher.WorkerState.CONFLICT,
        )

    def test_first_runnable_skips_closed_nonready_and_blocked(self):
        tasks = {
            1: dispatcher.task_snapshot(
                issue(1, "closed", state="closed", labels=[dispatcher.READY_LABEL])
            ),
            2: dispatcher.task_snapshot(issue(2, "not ready")),
            3: dispatcher.task_snapshot(
                issue(
                    3,
                    "blocked",
                    labels=[dispatcher.READY_LABEL, dispatcher.BLOCKED_LABEL],
                )
            ),
            4: dispatcher.task_snapshot(
                issue(4, "go", labels=[dispatcher.READY_LABEL])
            ),
        }
        selected = dispatcher.choose_first_runnable([1, 2, 3, 4], tasks)
        self.assertIsNotNone(selected)
        self.assertEqual(selected.number, 4)

    def test_untrusted_master_fails_closed(self):
        api = FakeApi(
            masters=[
                issue(
                    100,
                    "master",
                    body="- [ ] #1",
                    author_association="NONE",
                )
            ],
            issues={
                1: issue(1, "ready", labels=[dispatcher.READY_LABEL])
            },
        )
        with self.assertRaisesRegex(
            dispatcher.DispatchError,
            "UNTRUSTED_MASTER_QUEUE",
        ):
            dispatcher.reconcile(api)

    def test_untrusted_ready_task_is_not_runnable(self):
        master = issue(100, "master", body="- [ ] #1")
        api = FakeApi(
            masters=[master],
            issues={
                1: issue(
                    1,
                    "ready but untrusted",
                    labels=[dispatcher.READY_LABEL],
                    author_association="NONE",
                )
            },
        )
        result = dispatcher.reconcile(api)
        self.assertEqual(
            result,
            {"state": "WAITING", "reason": "NO_RUNNABLE_TASK"},
        )

    def test_zero_master_waits(self):
        api = FakeApi()
        result = dispatcher.reconcile(api)
        self.assertEqual(result["state"], "WAITING")
        self.assertEqual(result["reason"], "NO_MASTER_QUEUE")
        self.assertEqual(api.label_bootstrap_calls, 1)

    def test_multiple_masters_fail_closed(self):
        api = FakeApi(masters=[issue(100, "m1"), issue(101, "m2")])
        with self.assertRaisesRegex(
            dispatcher.DispatchError,
            "AMBIGUOUS_MASTER_QUEUE",
        ):
            dispatcher.reconcile(api)

    def test_busy_worker_does_not_assign_another_task(self):
        master = issue(100, "master", body="- [ ] #1")
        api = FakeApi(
            masters=[master],
            issues={
                1: issue(1, "task", labels=[dispatcher.READY_LABEL])
            },
            assigned=[
                {
                    "number": 77,
                    "html_url": "https://github.com/jan2xo/other/pull/77",
                }
            ],
        )
        result = dispatcher.reconcile(api)
        self.assertEqual(result["state"], "BUSY")
        self.assertFalse(api.materialized)
        self.assertFalse(api.labeled)

    def test_multiple_active_worker_prs_fail_closed(self):
        master = issue(100, "master", body="- [ ] #1")
        api = FakeApi(
            masters=[master],
            issues={
                1: issue(1, "task", labels=[dispatcher.READY_LABEL])
            },
            assigned=[
                {
                    "number": 1,
                    "html_url": "https://github.com/jan2xo/a/pull/1",
                },
                {
                    "number": 2,
                    "html_url": "https://github.com/jan2xo/b/pull/2",
                },
            ],
        )
        with self.assertRaisesRegex(
            dispatcher.DispatchError,
            "WORKER_OWNERSHIP_CONFLICT",
        ):
            dispatcher.reconcile(api)

    def test_free_worker_materializes_first_runnable_task_once(self):
        master = issue(100, "master", body="- [ ] #1\n- [ ] #2\n")
        api = FakeApi(
            masters=[master],
            issues={
                1: issue(
                    1,
                    "blocked",
                    labels=[dispatcher.READY_LABEL, dispatcher.BLOCKED_LABEL],
                ),
                2: issue(
                    2,
                    "ready",
                    labels=[dispatcher.READY_LABEL],
                    body="Do the exact task.",
                ),
            },
        )
        result = dispatcher.reconcile(api)
        self.assertEqual(result["state"], "DISPATCHED")
        self.assertEqual(result["task"], 2)
        self.assertEqual(api.materialized, [("bke/task-2", "main", 2)])
        self.assertEqual(api.created, [(2, "bke/task-2", "main")])
        self.assertEqual(api.labeled, [902])

    def test_existing_unassigned_task_pr_is_reused_idempotently(self):
        master = issue(100, "master", body="- [ ] #5")
        existing = {
            "number": 55,
            "html_url": "https://github.com/jan2xo/bke-worker/pull/55",
            "labels": [],
        }
        api = FakeApi(
            masters=[master],
            issues={
                5: issue(5, "ready", labels=[dispatcher.READY_LABEL])
            },
            task_prs={"bke/task-5": [existing]},
            branches={"bke/task-5"},
        )
        result = dispatcher.reconcile(api)
        self.assertEqual(
            result["reason"],
            "ASSIGNED_EXISTING_TASK_PR",
        )
        self.assertEqual(api.labeled, [55])
        self.assertFalse(api.materialized)
        self.assertFalse(api.created)

    def test_safe_orphaned_task_branch_is_recovered(self):
        master = issue(100, "master", body="- [ ] #5")
        api = FakeApi(
            masters=[master],
            issues={
                5: issue(5, "ready", labels=[dispatcher.READY_LABEL])
            },
            branches={"bke/task-5"},
        )
        result = dispatcher.reconcile(api)
        self.assertEqual(result["state"], "DISPATCHED")
        self.assertEqual(result["reason"], "RECOVERED_ORPHANED_TASK_BRANCH")
        self.assertEqual(api.recovered, [("bke/task-5", "main", 5)])
        self.assertFalse(api.materialized)
        self.assertEqual(api.created, [(5, "bke/task-5", "main")])
        self.assertEqual(api.labeled, [905])

    def test_orphan_materialization_validation_accepts_metadata_only_commit(self):
        parent_sha = "a" * 40
        tree_sha = "b" * 40
        branch_commit = {
            "message": dispatcher.materialization_commit_message(5),
            "tree": {"sha": tree_sha},
            "parents": [{"sha": parent_sha}],
        }
        parent_commit = {"tree": {"sha": tree_sha}}
        self.assertEqual(
            dispatcher.validate_orphan_materialization(
                branch_commit,
                parent_commit,
                5,
            ),
            parent_sha,
        )

    def test_orphan_materialization_validation_rejects_file_changes(self):
        branch_commit = {
            "message": dispatcher.materialization_commit_message(5),
            "tree": {"sha": "b" * 40},
            "parents": [{"sha": "a" * 40}],
        }
        parent_commit = {"tree": {"sha": "c" * 40}}
        with self.assertRaisesRegex(
            dispatcher.DispatchError,
            "ORPHANED_TASK_BRANCH_UNSAFE",
        ):
            dispatcher.validate_orphan_materialization(
                branch_commit,
                parent_commit,
                5,
            )

    def test_orphan_materialization_validation_rejects_unexpected_commit(self):
        tree_sha = "b" * 40
        branch_commit = {
            "message": "feat: unexpected work",
            "tree": {"sha": tree_sha},
            "parents": [{"sha": "a" * 40}],
        }
        parent_commit = {"tree": {"sha": tree_sha}}
        with self.assertRaisesRegex(
            dispatcher.DispatchError,
            "ORPHANED_TASK_BRANCH_UNSAFE",
        ):
            dispatcher.validate_orphan_materialization(
                branch_commit,
                parent_commit,
                5,
            )

    def test_no_runnable_task_waits(self):
        master = issue(100, "master", body="- [ ] #1")
        api = FakeApi(
            masters=[master],
            issues={1: issue(1, "not ready")},
        )
        result = dispatcher.reconcile(api)
        self.assertEqual(
            result,
            {"state": "WAITING", "reason": "NO_RUNNABLE_TASK"},
        )

    def test_dispatcher_source_has_no_invalid_markdown_escape(self):
        source = SCRIPT.read_text(encoding="utf-8")
        self.assertNotIn(r"\\`", source)

    def test_actions_pr_creation_gate_is_named(self):
        error = dispatcher.DispatchError(
            "GitHub API POST /repos/jan2xo/bke-worker/pulls failed with 403: "
            '{"message":"GitHub Actions is not permitted to create or approve pull requests."}'
        )
        self.assertTrue(dispatcher.is_actions_pr_creation_denied(error))
        self.assertFalse(
            dispatcher.is_actions_pr_creation_denied(
                dispatcher.DispatchError("GitHub API failed with 500")
            )
        )

    def test_human_authenticated_pr_creation_bootstrap_is_bounded(self):
        source = PR_CREATION_BOOTSTRAP.read_text(encoding="utf-8")
        for token in [
            'REPOSITORY="${BKE_WORKER_REPOSITORY:-jan2xo/bke-worker}"'.replace("\\", ""),
            'if [[ "$REPOSITORY" != "jan2xo/bke-worker" ]]',
            "gh auth status --hostname github.com",
            '/actions/permissions/workflow',
            "default_workflow_permissions",
            "can_approve_pull_request_reviews=true",
            'if [[ "$verified" != "true" ]]',
            "BKE serial dispatcher PR-creation permission: ENABLED",
        ]:
            self.assertIn(token, source)

        for forbidden in [
            "GITHUB_TOKEN=",
            "GH_TOKEN=",
            "PRIVATE_KEY",
            "PERSONAL_ACCESS_TOKEN",
            "gh auth login",
        ]:
            self.assertNotIn(forbidden, source)

    def test_pr_body_carries_issue_contract_and_worker_lock(self):
        task = dispatcher.task_snapshot(
            issue(
                8,
                "feature",
                labels=[dispatcher.READY_LABEL],
                body="## Intent\nDo one bounded thing.",
            )
        )
        body = dispatcher.build_task_pr_body(task)
        for token in [
            "Closes #8",
            "android-worker-a",
            "bke-worker:android-worker-a",
            "## Intent",
            "Do one bounded thing.",
            "GitHub is task authority.",
            "Production remains locked",
        ]:
            self.assertIn(token, body)

    def test_workflow_is_serial_trusted_main_and_github_app_bounded(self):
        workflow = (
            ROOT / ".github/workflows/serial-dispatcher.yml"
        ).read_text(encoding="utf-8")
        required = [
            "issues:",
            "pull_request_target:",
            "workflow_dispatch:",
            "group: bke-worker-serial-dispatcher",
            "cancel-in-progress: false",
            "contents: read",
            "id-token: write",
            "ref: ${{ github.event.repository.default_branch }}",
            "persist-credentials: false",
            "BKE_WORKER_GITHUB_APP_BROKER_URL",
            "bke-worker-github-app-broker",
            "/github/app/install-token",
            "ACTIONS_ID_TOKEN_REQUEST_URL",
            "ACTIONS_ID_TOKEN_REQUEST_TOKEN",
            "broker_response_file",
            "broker_status",
            "broker rejected token request status=",
            "GITHUB_APP_BROKER_FAILED",
            'echo "::add-mask::$app_token"',
            "BKE_GITHUB_APP_TOKEN=$app_token",
            'export GITHUB_TOKEN="$BKE_GITHUB_APP_TOKEN"',
            "python3 scripts/github_serial_dispatcher.py",
            "BKE_WORKER_ID: android-worker-a",
        ]
        for token in required:
            self.assertIn(token, workflow)
        forbidden = [
            "contents: write",
            "pull-requests: write",
            "issues: write",
            "GITHUB_TOKEN: ${{ github.token }}",
            "worker-b",
            "worker-c",
            "github.event.pull_request.head.sha",
            'echo "$oidc_token"',
            'echo "$app_token"',
            'echo "$broker_json"',
        ]
        for token in forbidden:
            self.assertNotIn(token, workflow)


if __name__ == "__main__":
    unittest.main()
