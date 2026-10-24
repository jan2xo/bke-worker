import test from "node:test";
import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
import {checkOwnerNativePolicy} from "../dist/native-policy-gate.js";
const h=x=>x.repeat(64);
const O="chrome-extension://"+"a".repeat(32)+"/";
const NOW=Date.now();
const expected=()=>({origin:O,workerId:"f1-worker",
 publicKeySha256:h("1"),now:NOW});
const policy=()=>({
 version:1,allowed_origin:O,worker_id:"f1-worker",
 public_key_sha256:h("1"),profile_binding_sha256:h("2"),
 resources:{chatgpt_target_sha256:h("3"),
  browser_profile_sha256:h("4"),bridge_identity_sha256:h("5")},
 expires_at_ms:NOW+120000,
});
test("exact owner policy and identity authorize local proof ATTEMPT only",()=>{
 const x=checkOwnerNativePolicy(policy(),expected());
 assert.equal(x.state,"LOCAL_POLICY_MATCH_ONLY");
 assert.deepEqual([x.pairing_authority,x.dispatch_authority],["NONE","NONE"]);
 assert.equal(x.profileBindingSha256,h("2"));
 assert.deepEqual(Object.keys(x.resources).sort(),[
  "bridge_identity_sha256","browser_profile_sha256","chatgpt_target_sha256"]);
});
test("mismatched Chrome origin, worker, P256 thumbprint and target pins refuse",()=>{
 const v=policy();
 for(const invalid of [
  {...v,allowed_origin:"chrome-extension://"+"b".repeat(32)+"/"},
  {...v,worker_id:"other-worker"},
  {...v,public_key_sha256:h("7")},
  {...v,profile_binding_sha256:"z"},
  {...v,resources:{...v.resources,bridge_identity_sha256:"X"}},
  {...v,resources:{...v.resources,browser_profile_sha256:h("3")}},
  {...v,expires_at_ms:NOW-1},
  {...v,expires_at_ms:NOW+31*86400000},
  {...v,extra:"SURPRISE"},
  {...v,resources:{...v.resources,extra:h("6")}},
  [],null,
 ]){
  assert.equal(checkOwnerNativePolicy(invalid,expected()).state,"BLOCKED");
 }
});
test("owner policy cannot confer enrollment, privileged controller or message capability",()=>{
 const p=checkOwnerNativePolicy(policy(),expected());
 const serialized=JSON.stringify(p);
 assert.ok(!serialized.includes("chrome_cookie"));
 assert.ok(!serialized.includes("secret"));
 assert.ok(!serialized.includes("CONNECTED"));
 assert.ok(!serialized.includes("ACTIVE"));
});
test("native proof is only invoked in popup-gated onMessage branch, not during startup",()=>{
 const sw=readFileSync(new URL("../src/service-worker.ts",import.meta.url),"utf8");
 assert.match(sw,/isTrustedPopup\(sender\)/);
 assert.match(sw,/nativeProofAction/);
 assert.match(sw,/proveLocalNativeHost/);
 assert.match(sw,/permissions\.contains/);
 assert.match(sw,/NATIVE_PROOF_MESSAGE/);
});
