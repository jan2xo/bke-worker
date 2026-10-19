import test from "node:test";
import assert from "node:assert/strict";
import {generateKeyPairSync,verify,createPublicKey} from "node:crypto";
import {readFileSync} from "node:fs";
import {createPrivatePeerEvidenceSigner,canonicalPrivatePeerEvidence,PRIVATE_PEER_ATTESTOR_AUDIENCE}
  from "../private-peer-attestor.mjs";

const H=n=>n.repeat(64);
const AT=Date.now();
const NONCE=Buffer.alloc(32,0x1a).toString("base64url");
const OTHER=Buffer.alloc(32,0x2b).toString("base64url");
const LINK=Object.freeze({private_local_port:true});
function pins(){
 return {source:"DESKTOP_EXTENSION_NATIVE",worker_id:"worker-a",
  identity_public_key_sha256:H("1"),chatgpt_target_sha256:H("3"),
  browser_profile_sha256:H("4"),bridge_identity_sha256:H("5")};
}
function binding(){
 return {audience:"bke-command-center/preproduction/native-device-admission/v1",
  source:"DESKTOP_EXTENSION_NATIVE",worker_id:"worker-a",
  identity_public_key_sha256:H("1"),session_binding_sha256:H("2"),
  chatgpt_target_sha256:H("3"),browser_profile_sha256:H("4"),
  bridge_identity_sha256:H("5"),expires_at_ms:AT+20000};
}
const request=(nonce=NONCE)=>({version:1,request_nonce:nonce});
const keys=()=>generateKeyPairSync("ec",{namedCurve:"prime256v1"});
function fixture(overrides={}){
 const {privateKey,publicKey}=keys();let now=AT,inspected=0;
 let peer=async link=>{assert.equal(link,LINK);inspected++;return binding();};
 const make=(options={})=>createPrivatePeerEvidenceSigner({
  attestorKey:privateKey,ownerPins:pins(),
  inspectTrustedPeer:link=>peer(link),clock:()=>now,...options});
 return {privateKey,publicKey,make,inspected:()=>inspected,
  clock:x=>{now=x;},peer:f=>{peer=f;}};
}

test("real P-256 signer interoperates with CC #57 exact canonical array and signature",async()=>{
 const f=fixture();const sign=f.make(),envelope=await sign(LINK,request());
 assert.deepEqual(Object.keys(envelope).sort(),["binding","request_nonce","signature","version"]);
 assert.deepEqual(envelope.binding,binding());
 assert.equal(PRIVATE_PEER_ATTESTOR_AUDIENCE,"bke-command-center/private-native-peer-attestor/v1");
 const expected=JSON.stringify([
  "bke-command-center/private-native-peer-attestor/v1",1,NONCE,
  "bke-command-center/preproduction/native-device-admission/v1",
  "DESKTOP_EXTENSION_NATIVE","worker-a",H("1"),H("2"),H("3"),H("4"),H("5"),AT+20000,
 ]);
 assert.equal(canonicalPrivatePeerEvidence(NONCE,binding()),expected);
 assert.equal(verify("sha256",Buffer.from(expected),{key:f.publicKey,dsaEncoding:"ieee-p1363"},
   Buffer.from(envelope.signature,"base64url")),true);
 const wrongKey=keys();
 assert.equal(verify("sha256",Buffer.from(expected),{key:wrongKey.publicKey,dsaEncoding:"ieee-p1363"},
   Buffer.from(envelope.signature,"base64url")),false);
 assert.equal(f.inspected(),1);
 assert.equal(envelope.admission_authority,undefined);
 assert.equal(envelope.dispatch_authority,undefined);
 assert.equal(envelope.binding.pairing_authority,undefined);
 assert.equal(Object.isFrozen(envelope),true);
 await assert.rejects(sign(LINK,request()),/REQUEST_DENIED/);
 const second=await sign(LINK,request(OTHER));
 assert.equal(second.request_nonce,OTHER);
});

test("replay, non-canonical nonce, malformed challenge, and input smuggling fail before inspector",async()=>{
 const f=fixture(),sign=f.make();
 for(const invalid of [
  {version:1,request_nonce:"abc"},
  {version:2,request_nonce:NONCE},
  {version:1,request_nonce:NONCE,approved:true},
  {version:1,request_nonce:NONCE.slice(0,42)+"="},
  // Last Base64URL sextet must have canonical zero unused pad bits.\n  {version:1,request_nonce:NONCE.slice(0,-1)+"B"},
  null,
 ]){
  await assert.rejects(sign(LINK,invalid),/REQUEST_DENIED/);
 }
 await assert.rejects(sign(null,request()),/REQUEST_DENIED/);
 assert.equal(f.inspected(),0);
});

test("invalid owner keys or policy cannot create a signer",()=>{
 const f=fixture();
 for(const extra of [{ownerPins:{...pins(),trusted:true}},{ownerPins:{...pins(),worker_id:"worker-b" + "@"}},
  {attestorKey:createPublicKey(f.privateKey)},{inspectTrustedPeer:null},
  {timeoutMs:0},{maxNonces:1000}]){
  assert.throws(()=>f.make(extra),/NOT_CONFIGURED/);
 }
});

test("altered worker, identity, profile, bridge, target or unsigned privilege fail closed",async()=>{
 const mutations=[
  v=>({...v,worker_id:"worker-b"}),
  v=>({...v,identity_public_key_sha256:H("a")}),
  v=>({...v,browser_profile_sha256:H("a")}),
  v=>({...v,bridge_identity_sha256:H("a")}),
  v=>({...v,chatgpt_target_sha256:H("a")}),
  v=>({...v,session_binding_sha256:"not-a-hash"}),
  v=>({...v,source:"CHATGPT_CONTENT_SCRIPT"}),
  v=>({...v,audience:"other"}),
  v=>({...v,dispatch_authority:"YES"}),
  v=>({...v,expires_at_ms:AT+30001}),
  v=>({...v,expires_at_ms:AT}),
 ];
 for(const mutation of mutations){
  const f=fixture();f.peer(async()=>mutation(binding()));
  const sign=f.make();
  await assert.rejects(sign(LINK,request()),/NATIVE_ATTESTOR_BLOCKED/);
  await assert.rejects(sign(LINK,request()),/REQUEST_DENIED/);
 }
});

test("concurrent attempt fails closed instead of sharing an in-flight private session",async()=>{
 const f=fixture();
 let release;const gate=new Promise(res=>{release=res;});
 f.peer(async()=>{await gate;return binding();});
 const sign=f.make(),first=sign(LINK,request());
 await assert.rejects(sign(LINK,request(OTHER)),/REQUEST_DENIED/);
 release();const result=await first;
 assert.equal(result.binding.worker_id,"worker-a");
});

test("mutating inspector data after release never changes the signed snapshot",async()=>{
 const f=fixture();const mutable=binding();
 f.peer(async()=>mutable);
 const sign=f.make(),res=await sign(LINK,request());
 mutable.worker_id="attacker";mutable.session_binding_sha256=H("f");
 assert.equal(res.binding.worker_id,"worker-a");
 assert.equal(res.binding.session_binding_sha256,H("2"));
});

test("expired, failed and timed-out inspector fail closed, with no retry",async()=>{
 const expired=fixture();expired.clock(AT+30_001);
 await assert.rejects(expired.make()(LINK,request()),/NATIVE_ATTESTOR_BLOCKED/);
 const outage=fixture();let calls=0;
 outage.peer(async()=>{calls++;throw Error("do not leak private browser profile");});
 await assert.rejects(outage.make()(LINK,request()),/NATIVE_ATTESTOR_BLOCKED/);
 assert.equal(calls,1);
 const hang=fixture();let hits=0;
 hang.peer(()=>{hits++;return new Promise(()=>{});});
 const sign=hang.make({timeoutMs:100});
 await assert.rejects(sign(LINK,request()),/NATIVE_ATTESTOR_BLOCKED/);
 assert.equal(hits,1);
 await assert.rejects(sign(LINK,request()),/REQUEST_DENIED/);
});

test("bounded lifetime refuses signing after nonce budget consumed",async()=>{
 const f=fixture(),sign=f.make({maxNonces:1});
 await sign(LINK,request());
 await assert.rejects(sign(LINK,request(OTHER)),/REQUEST_DENIED/);
});

test("source remains dormant: no Chrome host invocation, no manifest grant or installer changes",()=>{
 const entry=readFileSync(new URL("../entry.mjs",import.meta.url),"utf8");
 const host=readFileSync(new URL("../host.mjs",import.meta.url),"utf8");
 const manifest=readFileSync(new URL("../../manifest.json",import.meta.url),"utf8");
 const installer=readFileSync(new URL("../../../scripts/prepare-chrome-native-host.sh",import.meta.url),"utf8");
 for(const source of [entry,host,installer]){
  assert.doesNotMatch(source,/createPrivatePeerEvidenceSigner|private-peer-attestor/u);
 }
 assert.doesNotMatch(manifest,/"nativeMessaging"/u);
 assert.deepEqual(JSON.parse(manifest).permissions,["storage"]);
});
