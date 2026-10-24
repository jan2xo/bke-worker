import test from "node:test";
import assert from "node:assert/strict";
import {createHash} from "node:crypto";
import {readFileSync} from "node:fs";
import {createLocalReadOnlyEnvelopeGate} from "../local-read-only-controller.mjs";

const sha=x=>createHash("sha256").update("BKE synthetic test: "+x).digest("hex");
const now=1_800_000_000_000;
function fixture(){
 const policy={
  version:1,allowed_origin:"chrome-extension://"+"a".repeat(32)+"/",
  worker_id:"worker-f1",public_key_sha256:sha("P256"),
  profile_binding_sha256:sha("profile"),
  resources:{
   chatgpt_target_sha256:sha("target"),
   browser_profile_sha256:sha("browser"),
   bridge_identity_sha256:sha("bridge"),
  },
  expires_at_ms:now+60000,
 };
 const localReceipt={
  type:"LOCAL_PROOF_OK",version:1,worker_id:policy.worker_id,
  public_key_sha256:policy.public_key_sha256,
  admission_authority:"NONE",dispatch_authority:"NONE",
 };
 const clientNonce=sha("client"),serverNonce=sha("server");
 return {policy,localReceipt,clientNonce,serverNonce};
}
function gate(overrides={}){
 return createLocalReadOnlyEnvelopeGate({
  ...fixture(),clock:()=>now,...overrides,
 });
}
test("one matched typed ping yields ONLY a non-authoritative status, then spends the attempt",()=>{
 const g=gate(),frame=g.proposal;
 const result=g.accept(frame);
 assert.deepEqual(result,{
  state:"LOCAL_READ_ONLY_PONG",worker_id:"worker-f1",
  admission_authority:"NONE",dispatch_authority:"NONE",
  message_send_authority:"NONE",
  controller_authentication:"NOT_ESTABLISHED",
  live_transport:"NOT_CONNECTED",
 });
 assert.equal(g.accept(frame).code,"LOCAL_CONTROL_REPLAY_OR_ALREADY_CONSUMED");
 assert.equal("token" in result,false);
 assert.equal("command" in result,false);
});
test("malformed and effectful envelopes fail closed, even if followed by a valid replay",()=>{
 for(const update of [
  frame=>({...frame,type:"SEND_CHATGPT_MESSAGE"}),
  frame=>({...frame,type:"RUN_JAVASCRIPT"}),
  frame=>({...frame,type:"GITHUB_PR_ASSIGN"}),
  frame=>({...frame,version:2}),
  frame=>({...frame,sequence:2}),
  frame=>({...frame,worker_id:"another-worker"}),
  frame=>({...frame,profile_binding_sha256:sha("other profile")}),
  frame=>({...frame,chatgpt_target_sha256:sha("different tab")}),
  frame=>({...frame,bridge_identity_sha256:sha("other bridge")}),
  frame=>({...frame,client_nonce:sha("old nonce")}),
  frame=>({...frame,server_nonce:sha("old server")}),
  frame=>({...frame,proof_binding_sha256:sha("bad session")}),
  frame=>({...frame,expires_at_ms:frame.expires_at_ms+1}),
  frame=>({...frame,prompt:"secret page or user data"}),
  frame=>({...frame,authorization:"bearer FAKE"}),
  frame=>({type:frame.type}),
  ()=>null,
  ()=>[],
 ]){
  const g=gate(),bad=update(g.proposal);
  assert.equal(g.accept(bad).code,"LOCAL_CONTROL_ENVELOPE_DENIED");
  assert.equal(g.accept(g.proposal).code,"LOCAL_CONTROL_REPLAY_OR_ALREADY_CONSUMED");
 }
});
test("wrong signed-proof receipt worker/key, elevated authority, expired owner policy all reject construction",()=>{
 for(const change of [
  v=>({...v,localReceipt:{...v.localReceipt,worker_id:"other"}}),
  v=>({...v,localReceipt:{...v.localReceipt,public_key_sha256:sha("other")}}),
  v=>({...v,localReceipt:{...v.localReceipt,admission_authority:"ACTIVE"}}),
  v=>({...v,localReceipt:{...v.localReceipt,dispatch_authority:"ACTIVE"}}),
  v=>({...v,localReceipt:{...v.localReceipt,secret:"borrowed"}}),
  v=>({...v,policy:{...v.policy,expires_at_ms:now-1}}),
  v=>({...v,policy:{...v.policy,resources:{...v.policy.resources,chatgpt_target_sha256:"x"}}}),
  v=>({...v,serverNonce:v.clientNonce}),
  v=>({...v,serverNonce:"weak"}),
  v=>({...v,ttlMs:5001}),
  v=>({...v,ttlMs:99}),
 ]){
  const v=fixture();
  assert.throws(()=>createLocalReadOnlyEnvelopeGate({...change(v),clock:()=>now}),
    /LOCAL_CONTROL_PROOF_OR_POLICY_UNVERIFIED/);
 }
});
test("clock expiry and rollback fail; no retry after uncertain state",()=>{
 let time=now;
 const clock=()=>time;
 const g=gate({clock,ttlMs:100});
 time=now+100;
 assert.equal(g.accept(g.proposal).code,"LOCAL_CONTROL_EXPIRED_OR_CLOCK_REWOUND");
 assert.equal(g.accept(g.proposal).code,"LOCAL_CONTROL_REPLAY_OR_ALREADY_CONSUMED");
 time=now;
 const g2=gate({clock,ttlMs:100});
 time=now-1;
 assert.equal(g2.accept(g2.proposal).code,"LOCAL_CONTROL_EXPIRED_OR_CLOCK_REWOUND");
});
test("explicit close aborts the only permitted status attempt",()=>{
 const g=gate();g.close();
 assert.equal(g.accept(g.proposal).code,"LOCAL_CONTROL_REPLAY_OR_ALREADY_CONSUMED");
});
test("read-only gate is reachable only inside the signed native proof host",()=>{
 for(const relative of ["../../src/service-worker.ts","../entry.mjs"]){
  const text=readFileSync(new URL(relative,import.meta.url),"utf8");
  assert.doesNotMatch(text,/createLocalReadOnlyEnvelopeGate|local-read-only-controller/u);
 }
 const verifiedHost=readFileSync(new URL("../host.mjs",import.meta.url),"utf8");
 assert.match(verifiedHost,/createLocalReadOnlyEnvelopeGate/u);
 assert.match(verifiedHost,/matchesProof\(proof/u);
 assert.ok(verifiedHost.indexOf("matchesProof(proof") <
   verifiedHost.lastIndexOf("createLocalReadOnlyEnvelopeGate("));
 const source=readFileSync(new URL("../local-read-only-controller.mjs",import.meta.url),"utf8");
 for(const forbidden of ["fetch(","connectNative(","sendMessage(","eval(","execFile(","spawn("]){
  assert.equal(source.includes(forbidden),false,"forbidden capability "+forbidden);
 }
});
