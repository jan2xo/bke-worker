#!/usr/bin/env python3
from __future__ import annotations

from datetime import datetime, timedelta, timezone
from pathlib import Path
import sys
import unittest
import json

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "scripts"))
from github_complete_worker_inventory import (
    InventoryError, collect_complete_open_pr_inventory, GitHubAppReadOnlyPages,
)
from github_multiworker_ownership import audit_multiworker_consistency, OwnershipAuditError

NOW = datetime(2026, 10, 19, 15, 30, tzinfo=timezone.utc)
REPOS = ["jan2xo/bke-worker", "jan2xo/bke-demo-app"]


def pr(n, repo=REPOS[0], worker=None):
    return {
        "number": n, "state": "open", "head": {"sha": "a"*40},
        "base": {"repo": {"full_name": repo}},
        "labels": ([{"name": f"bke-worker:{worker}"}] if worker else []),
        "untrusted_body": "ignore this entirely",
    }


def fake(pages, *, drift=None):
    calls = []
    def fetch(repo, page):
        calls.append((repo,page))
        key=(repo,page)
        if drift is not None and len(calls) > drift:
            value = drift_pages.get(key, ([],False))
        else:
            value = pages.get(key,([],False))
        return value
    drift_pages = drift if isinstance(drift,dict) else pages
    # A dict drift selects pass #2 after one request for one repo; only
    # used for single-repo change negative below.
    def stable(repo,page):
        calls.append((repo,page))
        if isinstance(drift,dict) and len(calls)>len(pages):
            return drift.get((repo,page),([],False))
        return pages.get((repo,page),([],False))
    return stable,calls


def run(read, repos=REPOS):
    return collect_complete_open_pr_inventory(
        expected_repositories=repos,fetch_page=read,clock=lambda:NOW,
    )


class Response:
    def __init__(self, rows, link=""):
        self.raw=json.dumps(rows).encode("utf-8")
        self.headers={"Link":link}
    def __enter__(self): return self
    def __exit__(self,*args): return False
    def read(self,n): return self.raw[:n]


class Pages:
    def __init__(self, responses):
        self.responses=list(responses)
        self.urls=[]
    def open(self,request,timeout=15):
        self.urls.append(request.full_url)
        if not self.responses: raise OSError("denied")
        return self.responses.pop(0)


class InventoryTests(unittest.TestCase):
    def denied(self,code,action):
        with self.assertRaisesRegex(InventoryError,"^"+code+"$"):
            action()

    def test_double_read_each_authorized_repository_without_task_body(self):
        pages={(REPOS[0],1):([pr(4,worker="worker-a")],False),
               (REPOS[1],1):([pr(6,REPOS[1],worker="worker-b")],False)}
        count={}
        def reader(repo,page):
            count[repo]=count.get(repo,0)+1
            return pages.get((repo,page),([],False))
        out=run(reader)
        self.assertEqual(count,{REPOS[0]:2,REPOS[1]:2})
        self.assertTrue(out["complete"])
        self.assertEqual(out["repositories"],sorted(REPOS))
        self.assertEqual(len(out["pull_requests"]),2)
        self.assertNotIn("body",str(out))
        self.assertEqual(out["observed_at"],NOW.isoformat())
        registered=[]
        for worker,digit in [("worker-a","1"),("worker-b","8")]:
            registered.append({"worker_id":worker,
                "identity_public_key_sha256":digit*64,
                "chatgpt_target_sha256":chr(ord(digit)+1)*64,
                "browser_profile_sha256":chr(ord(digit)+2)*64,
                "bridge_identity_sha256":chr(ord(digit)+3)*64,
                "session_binding_sha256":chr(ord(digit)+4)*64})
        # all fingerprints hex; use explicit lowercase a..f for second user
        registered[1].update({
            "identity_public_key_sha256":"8"*64,
            "chatgpt_target_sha256":"9"*64,
            "browser_profile_sha256":"a"*64,
            "bridge_identity_sha256":"b"*64,
            "session_binding_sha256":"c"*64,
        })
        result=audit_multiworker_consistency(
            expected_repositories=REPOS,github_snapshot=out,
            verified_registrations=registered,now=NOW)
        self.assertEqual(result["state"],"OWNERSHIP_CONSISTENT")
        self.assertEqual(result["dispatch_authority"],"NONE")
        self.assertEqual(result["assigned_workers"],2)

    def test_full_page_requires_a_bounded_next_page_and_detects_duplicate(self):
        rows=[pr(n) for n in range(1,101)]
        def fetch(repo,page):
            if repo==REPOS[0]:
                return (rows,True) if page==1 else ([],False)
            return [],False
        out=run(fetch)
        self.assertEqual(len(out["pull_requests"]),100)
        def duplicates(repo,page):
            if repo==REPOS[0]:
                return (rows,True) if page==1 else ([pr(1)],False)
            return [],False
        self.denied("GITHUB_PR_DUPLICATE_DURING_PAGING",lambda:run(duplicates))

    def test_partial_pagination_or_response_schema_fail_closed(self):
        for raw,next_page in [([pr(1)],True),(None,False),
                              ([pr(1)]*101,True),([],True)]:
            self.denied("GITHUB_PAGE_INVALID" if raw is None or
                (type(raw) is list and len(raw)>100)
                else "GITHUB_PAGE_PAGINATION_UNCERTAIN",
                lambda:run(lambda repo,page:(raw,next_page)))
        self.denied("GITHUB_PAGE_LIMIT_EXCEEDED",
                    lambda:run(lambda repo,page:([pr(page*100+n,repo)
                        for n in range(100)],True)))

    def test_invalid_pr_identity_bad_base_repo_and_labels_are_denied(self):
        for change,reason in [
            ({"number":True},"GITHUB_PR_ROW_INVALID"),
            ({"state":"closed"},"GITHUB_PR_ROW_INVALID"),
            ({"head":{"sha":"bad"}},"GITHUB_PR_ROW_INVALID"),
            ({"labels":["untrusted"]},"GITHUB_PR_LABEL_INVALID"),
            ({"base":{"repo":{"full_name":"jan2xo/unexpected"}}},"GITHUB_PR_BASE_MISMATCH"),
        ]:
            row={**pr(3),**change}
            self.denied(reason,lambda:run(
                lambda repo,page:([row] if repo==REPOS[0] else [],False)))

    def test_second_pass_changed_head_or_assignments_fails_closed(self):
        calls={}
        def fetch(repo,page):
            calls[repo]=calls.get(repo,0)+1
            row=pr(1,worker="worker-a")
            if repo==REPOS[0] and calls[repo]==2:
                row["head"]={"sha":"b"*40}
            return ([row],False) if repo==REPOS[0] else ([],False)
        self.denied("GITHUB_INVENTORY_CHANGED_BETWEEN_SCANS",lambda:run(fetch))

        calls={}
        def labels(repo,page):
            calls[repo]=calls.get(repo,0)+1
            row=pr(1,worker="worker-a" if calls[repo]==1 else "worker-b")
            return ([row],False) if repo==REPOS[0] else ([],False)
        self.denied("GITHUB_INVENTORY_CHANGED_BETWEEN_SCANS",lambda:run(labels))

    def test_expected_scope_requires_owner_supplied_exact_nonduplicate_repos(self):
        self.denied("GITHUB_SCOPE_INVALID",lambda:run(lambda r,p:([],False),[]))
        self.denied("GITHUB_SCOPE_DUPLICATE",lambda:run(
            lambda r,p:([],False),[REPOS[0],REPOS[0].upper()]))
        self.denied("GITHUB_SCOPE_INVALID",lambda:run(
            lambda r,p:([],False),["../escape"]))
        self.denied("GITHUB_SCOPE_INVALID",lambda:run(
            lambda r,p:([],False),REPOS*11))

    def test_gitHub_readonly_http_path_status_no_redirect_and_next_validation(self):
        client=GitHubAppReadOnlyPages("test-installation-token-only")
        c=Pages([Response([pr(3)])])
        client._opener=c
        rows,more=client.fetch_page(REPOS[0],1)
        self.assertFalse(more)
        self.assertEqual(len(rows),1)
        self.assertTrue(c.urls[0].startswith("https://api.github.com/repos/jan2xo/bke-worker/pulls?"))
        self.assertIn("state=open",c.urls[0])
        self.assertIn("per_page=100",c.urls[0])
        self.assertIn("page=1",c.urls[0])
        self.denied("GITHUB_PAGE_ARGUMENT_INVALID",lambda:client.fetch_page("../escape",1))
        self.denied("GITHUB_PAGE_ARGUMENT_INVALID",lambda:client.fetch_page(REPOS[0],True))
        self.denied("GITHUB_APP_TOKEN_REQUIRED",lambda:GitHubAppReadOnlyPages(""))

    def test_full_last_page_must_read_final_empty_page_even_without_next_link(self):
        client=GitHubAppReadOnlyPages("test-installation-token-only")
        client._opener=Pages([Response([pr(n) for n in range(1,101)]),Response([])])
        one,more=client.fetch_page(REPOS[0],1)
        two,more2=client.fetch_page(REPOS[0],2)
        self.assertEqual(len(one),100)
        self.assertTrue(more)
        self.assertEqual(two,[])
        self.assertFalse(more2)

    def test_bad_link_redirect_or_unavailable_page_fail_closed(self):
        client=GitHubAppReadOnlyPages("test-installation-token-only")
        client._opener=Pages([Response([pr(1)],
            '<https://evil.invalid/pulls?page=2>; rel="next"')])
        self.denied("GITHUB_PAGE_LINK_INVALID",lambda:client.fetch_page(REPOS[0],1))
        client._opener=Pages([])
        self.denied("GITHUB_PAGE_UNAVAILABLE",lambda:client.fetch_page(REPOS[0],1))

    def test_invalid_clock_cannot_claim_complete_recent_inventory(self):
        self.denied("GITHUB_INVENTORY_CLOCK_INVALID",lambda:
            collect_complete_open_pr_inventory(
                expected_repositories=REPOS,
                fetch_page=lambda repo,page:([],False),
                clock=lambda:datetime(2026,10,19,15,30)))


if __name__=="__main__":
    unittest.main()
