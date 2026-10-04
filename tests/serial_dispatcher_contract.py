#!/usr/bin/env python3
from __future__ import annotations

import importlib.util
from pathlib import Path
import sys
import unittest


ROOT = Path(__file__).resolve().parents[1]
SCRIPT = ROOT / "scripts/github_serial_dispatcher.py"
SPEC = importlib.util.spec_from_file_location("bke_serial_dispatcher", SCRIPT)
assert SPEC is not None and SPEC.loader is not None
dispatcher = importlib.util.module_from_spec(SPEC)
sys.modules[SPEC.name] = dispatcher
SPEC.loader.exec_module(dispatcher)


def issue(number, title, state="open", labels=(), body="task body"):
    return {
        "number": number,
        "title": title,
        "state": state,
        "body": body,
        "labels": [{"name": label} for label in labels],
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
        self.created = []
        self.labeled = []

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


class SerialDispatcherTests(unittest.TestCase):
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

    def test_zero_master_waits(self):
        api = FakeApi()
        result = dispatcher.reconcile(api)
        self.assertEqual(result["state"], "WAITING")
        self.assertEqual(result["reason"], "NO_MASTER_QUEUE")

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

    def test_orphaned_task_branch_fails_closed(self):
        master = issue(100, "master", body="- [ ] #5")
        api = FakeApi(
            masters=[master],
            issues={
                5: issue(5, "ready", labels=[dispatcher.READY_LABEL])
            },
            branches={"bke/task-5"},
        )
        with self.assertRaisesRegex(
            dispatcher.DispatchError,
            "ORPHANED_TASK_BRANCH",
        ):
            dispatcher.reconcile(api)

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

    def test_workflow_is_serial_trusted_main_and_write_bounded(self):
        workflow = (
            ROOT / ".github/workflows/serial-dispatcher.yml"
        ).read_text(encoding="utf-8")
        required = [
            "issues:",
            "pull_request_target:",
            "workflow_dispatch:",
            "group: bke-worker-serial-dispatcher",
            "cancel-in-progress: false",
            "contents: write",
            "pull-requests: write",
            "issues: write",
            "ref: ${{ github.event.repository.default_branch }}",
            "persist-credentials: false",
            "python3 scripts/github_serial_dispatcher.py",
            "BKE_WORKER_ID: android-worker-a",
        ]
        for token in required:
            self.assertIn(token, workflow)
        forbidden = [
            "worker-b",
            "worker-c",
            "github.event.pull_request.head.sha",
        ]
        for token in forbidden:
            self.assertNotIn(token, workflow)


if __name__ == "__main__":
    unittest.main()
