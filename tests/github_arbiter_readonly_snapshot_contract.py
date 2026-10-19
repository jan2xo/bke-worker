#!/usr/bin/env python3
"""Read-only GitHub arbiter wire fixtures: no network or ref writes."""
from __future__ import annotations
import base64
from copy import deepcopy
import json
from pathlib import Path
import sys
import unittest
import urllib.error
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "scripts"))
from github_arbiter_readonly_snapshot import (
    API_ORIGIN, _BASE_PATH, _REF_PATH, ARBITER_REF, ArbiterReadDenied,
    GitHubAppArbiterReader, MAX_JSON_BYTES, blob_sha1,
    canonical_manifest_bytes, inspect_arbiter, _NoRedirect,
)
HEAD, TREE, PARENT = "a"*40, "b"*40, "c"*40


def fixture():
    manifest = {"version":1,"sequence":0,"claims":[]}
    raw = canonical_manifest_bytes(manifest)
    blob = blob_sha1(raw)
    return {
      _REF_PATH: {"ref":ARBITER_REF,"object":{"type":"commit","sha":HEAD}},
      _BASE_PATH+"commits/"+HEAD: {"sha":HEAD,"tree":{"sha":TREE},"parents":[{"sha":PARENT}]},
      _BASE_PATH+"trees/"+TREE: {"sha":TREE,"truncated":False,
         "tree":[{"path":"claims-v1.json","mode":"100644","type":"blob","sha":blob}]},
      _BASE_PATH+"blobs/"+blob: {"sha":blob,"encoding":"base64",
         "size":len(raw),"content":base64.b64encode(raw).decode()+"\n"},
    }


class Response:
    def __init__(self, raw, status=200):
        self.raw,self.status=raw,status
    def __enter__(self): return self
    def __exit__(self,*_): return False
    def getcode(self): return self.status
    def read(self,n): return self.raw[:n]


class Opener:
    def __init__(self, documents):
        self.documents=documents
        self.calls=[]
        self.status=200
    def open(self, req, timeout):
        self.calls.append((req,timeout))
        path=req.full_url[len(API_ORIGIN):]
        if path not in self.documents:
            raise urllib.error.HTTPError(req.full_url,404,"missing",{},None)
        val=self.documents[path]
        if type(val) is not bytes:
            val=json.dumps(val).encode()
        return Response(val,self.status)


class ArbiterTests(unittest.TestCase):
    def denied(self, code, callback):
        with self.assertRaisesRegex(ArbiterReadDenied,"^"+code+"$"):
            callback()
    def parse(self, d):
        return inspect_arbiter(lambda p: deepcopy(d[p]))
    def test_positive_fixture_always_none_authority(self):
        data=fixture()
        result=self.parse(data)
        self.assertEqual(result["state"],"UNVERIFIED_GITHUB_REF_SNAPSHOT_ONLY")
        self.assertEqual(result["head_sha"],HEAD)
        for k in ("evidence_authority","assignment_authority","wake_authority","dispatch_authority"):
            self.assertEqual(result[k],"NONE")
    def test_coherent_fake_provider_does_not_grant_authority(self):
        fake=Opener(fixture())
        result=GitHubAppArbiterReader("disposable-fixture-token",opener=fake).inspect()
        self.assertEqual(result["evidence_authority"],"NONE")
        self.assertEqual(result["assignment_authority"],"NONE")
        self.assertEqual(len(fake.calls),5)
        self.assertTrue(all(req.get_method()=="GET" and
          req.full_url.startswith(API_ORIGIN+_BASE_PATH) and timeout==15
          for req,timeout in fake.calls))
    def test_missing_ref_never_bootstraps(self):
        f=fixture()
        del f[_REF_PATH]
        fake=Opener(f)
        self.denied("ARBITER_REF_NOT_INITIALIZED",
          lambda: GitHubAppArbiterReader("disposable-fixture-token",opener=fake).inspect())
        self.assertEqual(len(fake.calls),1)
    def test_bad_ref_and_type(self):
        for field,value,code in (("ref","refs/heads/main","ARBITER_REF_INVALID"),
          ("type","tag","ARBITER_REF_INVALID"),("sha","BAD","ARBITER_SHA_INVALID")):
            f=fixture()
            target=f[_REF_PATH] if field=="ref" else f[_REF_PATH]["object"]
            target[field]=value
            self.denied(code,lambda:self.parse(f))
    def test_wrong_commit_or_tree(self):
        path=_BASE_PATH+"commits/"+HEAD
        for key,value,code in (("sha","d"*40,"ARBITER_COMMIT_INVALID"),
          ("parents",[{"sha":PARENT},{"sha":"d"*40}],"ARBITER_COMMIT_INVALID"),
          ("parents",[{"sha":HEAD}],"ARBITER_COMMIT_INVALID")):
            f=fixture()
            f[path][key]=value
            self.denied(code,lambda:self.parse(f))
    def test_bad_tree_truncation_symlink_and_extra_file(self):
        path=_BASE_PATH+"trees/"+TREE
        for kind in ("truncated","extra","symlink","traversal"):
            f=fixture()
            t=f[path]
            if kind=="truncated":t["truncated"]=True
            if kind=="extra":t["tree"].append(deepcopy(t["tree"][0]))
            if kind=="symlink":t["tree"][0]["mode"]="120000"
            if kind=="traversal":t["tree"][0]["path"]="../x"
            self.denied("ARBITER_TREE_INVALID",lambda:self.parse(f))
    def test_bad_blob_digest_size_base64(self):
        for kind,code in (("sha","ARBITER_BLOB_INVALID"),
          ("size","ARBITER_BLOB_MISMATCH"),("base64","ARBITER_BLOB_INVALID")):
            f=fixture()
            p=next(x for x in f if "/blobs/" in x)
            if kind=="sha":f[p]["sha"]="f"*40
            if kind=="size":f[p]["size"]+=1
            if kind=="base64":f[p]["content"]="@@@@"
            self.denied(code,lambda:self.parse(f))
    def test_noncanonical_or_duplicate_json_rejected(self):
        for raw,code in (
          (b'{"version":1,"sequence":0,"claims":[]}\n',"ARBITER_MANIFEST_NONCANONICAL"),
          (b'{"claims":[],"sequence":0,"version":1,"version":1}\n',"ARBITER_JSON_DUPLICATE_KEY")):
            f=fixture()
            tree=f[_BASE_PATH+"trees/"+TREE]["tree"][0]
            old=tree["sha"]
            del f[_BASE_PATH+"blobs/"+old]
            sha=blob_sha1(raw)
            tree["sha"]=sha
            f[_BASE_PATH+"blobs/"+sha]={"sha":sha,"size":len(raw),
              "content":base64.b64encode(raw).decode(),"encoding":"base64"}
            self.denied(code,lambda:self.parse(f))
    def test_ref_moves_in_middle(self):
        f=fixture()
        count=[0]
        def provider(path):
            if path==_REF_PATH:
                count[0]+=1
                if count[0]>1:return {"ref":ARBITER_REF,"object":{"type":"commit","sha":"d"*40}}
            return f[path]
        self.denied("ARBITER_REF_MOVED",lambda:inspect_arbiter(provider))
    def test_failure_not_token_or_raw_error(self):
        def failed(_):raise RuntimeError("secret=do-not-leak")
        self.denied("ARBITER_PROVIDER_UNAVAILABLE",lambda:inspect_arbiter(failed))
        self.denied("ARBITER_READER_INVALID",lambda:inspect_arbiter(None))
    def test_no_arbitrary_url_or_ref_selection(self):
        fake=Opener(fixture())
        client=GitHubAppArbiterReader("disposable-fixture-token",opener=fake)
        for path in ("https://evil.test/",_BASE_PATH+"ref/heads/main",
                     _BASE_PATH+"commits/../main",_BASE_PATH+"blobs/"+"F"*40):
            self.denied("ARBITER_PATH_DENIED",lambda:client._fetch(path))
        self.assertEqual(fake.calls,[])
    def test_oversized_or_non_200_provider_response(self):
        f=fixture()
        f[_REF_PATH]=b"x"*(MAX_JSON_BYTES+1)
        self.denied("ARBITER_RESPONSE_INVALID",
          lambda:GitHubAppArbiterReader("disposable-fixture-token",opener=Opener(f)).inspect())
        fake=Opener(fixture())
        fake.status=403
        self.denied("ARBITER_PROVIDER_UNAVAILABLE",
          lambda:GitHubAppArbiterReader("disposable-fixture-token",opener=fake).inspect())
    def test_token_required_and_redirect_denied(self):
        for token in (None,"","short","bad\nnewline"):
            self.denied("ARBITER_APP_TOKEN_REQUIRED",lambda:GitHubAppArbiterReader(token))
        self.denied("ARBITER_REDIRECT_DENIED",lambda:
          _NoRedirect().redirect_request(None,None,302,"redirect",{},"https://evil.test"))


if __name__=="__main__":
    unittest.main()
