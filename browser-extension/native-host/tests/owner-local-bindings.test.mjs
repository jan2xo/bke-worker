import test from "node:test";
import assert from "node:assert/strict";
import {createHash} from "node:crypto";
import {spawnSync} from "node:child_process";
import {fileURLToPath} from "node:url";
import {deriveOwnerAttestedLocalPins} from "../owner-local-bindings.mjs";
import {buildReviewedOwnerPolicy} from "../owner-policy-provision.mjs";
import {validNativeHostPolicy} from "../host.mjs";
const h=x=>createHash("sha256").update("test-only-"+x).digest("hex");
const verified=()=>({
 worker_id:"f1-worker",
 extension_id:"abcdefghijklmnopabcdefghijklmnop",
 public_key_sha256:h("p256 actual key shape"),
 profile_path:"/Users/operator/.bke-worker/f1/chrome-profile",
 chrome_runtime_sha256:h("verified Google Chrome binary"),
 verified_process_profile:true,
 owner_attested_single_idle_chatgpt_tab:true,
});
test("owner-confirmed physical-process fields derive four domain-separated, locally bounded pins",()=>{
 const x=deriveOwnerAttestedLocalPins(verified());
 assert.equal(x.evidence,"OWNER_ATTESTED_LOCAL_COMMITMENTS_ONLY");
 assert.equal(x.independent_browser_attestation,"NOT_PROVEN");
 assert.equal(x.chatgpt_account_attestation,"NOT_PROVEN");
 assert.equal(x.pairing_authority,"NONE");
 assert.equal(x.dispatch_authority,"NONE");
 assert.equal(x.input.allowed_origin,"chrome-extension://abcdefghijklmnopabcdefghijklmnop/");
 const pins=["public_key_sha256","profile_binding_sha256","browser_profile_sha256",
  "chatgpt_target_sha256","bridge_identity_sha256"].map(k=>x.input[k]);
 assert.equal(new Set(pins).size,5);
 assert.ok(pins.every(v=>/^[0-9a-f]{64}$/.test(v)));
 const policy=buildReviewedOwnerPolicy(x.input);
 assert.equal(validNativeHostPolicy(policy),true);
 assert.equal(x.input.chatgpt_target_sha256===h("target"),false);
});
test("all scope changes invalidate local binding fingerprints",()=>{
 const source=verified(),base=deriveOwnerAttestedLocalPins(source).input;
 const modified=[
  {...source,worker_id:"other-worker"},
  {...source,extension_id:"bcdefghijklmnopabcdefghijklmnopa"},
  {...source,public_key_sha256:h("different real key")},
  {...source,profile_path:"/Users/operator/.bke-worker/f1/another-profile"},
  {...source,chrome_runtime_sha256:h("different chrome binary")},
 ];
 for(const next of modified){
  const x=deriveOwnerAttestedLocalPins(next).input;
  assert.notEqual(x.profile_binding_sha256,base.profile_binding_sha256);
  assert.notEqual(x.chatgpt_target_sha256,base.chatgpt_target_sha256);
 }
});
test("unverified OS process, tab, origin, hash and unsafe paths fail closed",()=>{
 const source=verified();
 const invalid=[
  {...source,verified_process_profile:false},
  {...source,verified_process_profile:"false"},
  {...source,owner_attested_single_idle_chatgpt_tab:false},
  {...source,owner_attested_single_idle_chatgpt_tab:"false"},
  {...source,public_key_sha256:"a".repeat(64)},
  {...source,public_key_sha256:"not-a-key"},
  {...source,chrome_runtime_sha256:"0".repeat(64)},
  {...source,chrome_runtime_sha256:"bad"},
  {...source,profile_path:"/tmp/../browser"},
  {...source,profile_path:"/tmp//browser"},
  {...source,profile_path:"/tmp/./browser"},
  {...source,profile_path:"relative/path"},
  {...source,worker_id:"F1-WORKER"},
  {...source,extension_id:"chrome-extension://abcdefghijklmnopabcdefghijklmnop/"},
  {...source,unknown:"untrusted"},
 ];
 for(const x of invalid)assert.throws(()=>deriveOwnerAttestedLocalPins(x),/OWNER_LOCAL_BINDING_UNVERIFIED/);
});
test("no access to private Chrome profile or ChatGPT page is required",()=>{
 const a=deriveOwnerAttestedLocalPins(verified()).input;
 assert.ok(!JSON.stringify(a).includes("/Users/operator/"));
 assert.ok(!JSON.stringify(a).includes("google-chrome"));
 assert.ok(!JSON.stringify(a).includes("cookies"));
 assert.ok(!JSON.stringify(a).includes("ChatGPT session"));
});

test("owner entrypoint refuses noninteractive execution before touching Chrome",()=>{
 const script=fileURLToPath(new URL("../../../scripts/forge-f1-owner-policy.mjs",import.meta.url));
 const r=spawnSync(process.execPath,[script],{encoding:"utf8",input:"",timeout:15000});
 assert.equal(r.status,2);
 assert.match(r.stderr,/OWNER_POLICY_OWNER_TTY_NODE22_REQUIRED/);
});
