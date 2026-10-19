import test from "node:test";
import assert from "node:assert/strict";
import { webcrypto } from "node:crypto";
import { readFileSync } from "node:fs";
import {
  DEVICE_CHALLENGE_AUDIENCE,canonicalDeviceChallenge,createDeviceIdentityBridge,
  publicIdentitySummary,
} from "../dist/device-identity.js";

const sha = n => n.repeat(64);
const proposal = worker => ({
  installation_id:"51",worker_id:worker,proposal_sha256:sha("a"),
  subject_sha256:sha("b"),nonce:sha("c"),
  expires_at_ms:2_030_000,
});
const cryptoImpl=webcrypto;
function store() {
  let record,queue=Promise.resolve(),writes=0;
  const result={
    failWrites:false,
    async atomic(operation) {
      let release;
      const next=new Promise(ok=>{release=ok;});
      const previous=queue;queue=next;
      await previous;
      const original=record===undefined?undefined:structuredClone(record);
      let draft=original;
      try {
        const answer=await operation({
          async get(){return draft===undefined?undefined:structuredClone(draft);},
          async put(value){
            if(result.failWrites)throw Error("storage provider secret");
            draft=structuredClone(value);writes++;
          },
        });
        record=draft;
        return answer;
      }finally{release();}
    },
    inspect:()=>record,
    corrupt:async value=>{record=value;},
    writes:()=>writes,
  };
  return result;
}
function bridge(storage,clock=()=>2_000_000,crypto=cryptoImpl){
  return createDeviceIdentityBridge({store:storage,cryptoImpl:crypto,now:clock});
}
test("explicit local identity creates nonextractable P-256 key without client-facing private material",async()=>{
  const db=store(),b=bridge(db);
  assert.deepEqual(await publicIdentitySummary(b,"worker-a"),{state:"NOT_PROVISIONED"});
  const created=await b.initialize("worker-a");
  assert.equal(created.state,"READY");
  assert.equal(created.worker_id,"worker-a");
  assert.equal(created.public_key.crv,"P-256");
  assert.equal(created.public_key.kty,"EC");
  assert.match(created.public_key_sha256,/^[a-f0-9]{64}$/);
  assert.equal(created.private_key,undefined);
  const stored=db.inspect();
  assert.equal(stored.private_key.type,"private");
  assert.equal(stored.private_key.extractable,false);
  await assert.rejects(
    () => webcrypto.subtle.exportKey("jwk",stored.private_key),
    /extractable|InvalidAccess|cannot/i,
  );
  assert.equal((await publicIdentitySummary(b,"worker-a")).state,"PROVISIONED");
  assert.equal((await publicIdentitySummary(b,"worker-a")).public_key_sha256,
    created.public_key_sha256);
});
test("P-256 sign matches Command Center PR #55 exactly, no arbitrary-message signature",async()=>{
  const b=bridge(store());const identity=await b.initialize("worker-a");
  const c=proposal("worker-a");
  const signed=await b.sign("worker-a",c);
  assert.equal(signed.state,"SIGNED");
  assert.match(signed.device_signature,/^[A-Za-z0-9_-]{86}$/);
  const expected=JSON.stringify([DEVICE_CHALLENGE_AUDIENCE,"prepare","51",
    "worker-a",sha("a"),sha("b"),sha("c"),2_030_000]);
  assert.equal(canonicalDeviceChallenge(c),expected);
  const verifier=await webcrypto.subtle.importKey("jwk",identity.public_key,
    {name:"ECDSA",namedCurve:"P-256"},false,["verify"]);
  const raw=Buffer.from(signed.device_signature,"base64url");
  assert.equal(raw.length,64);
  assert.equal(await webcrypto.subtle.verify({name:"ECDSA",hash:"SHA-256"},
    verifier,raw,new TextEncoder().encode(expected)),true);
  const mismatched=expected.replace("worker-a","worker-b");
  assert.equal(await webcrypto.subtle.verify({name:"ECDSA",hash:"SHA-256"},
    verifier,raw,new TextEncoder().encode(mismatched)),false);
});
test("identity can never silently switch worker IDs within one extension profile",async()=>{
  const db=store(),b=bridge(db);const first=await b.initialize("worker-a");
  assert.equal((await b.initialize("worker-b")).code,"IDENTITY_WORKER_MISMATCH");
  assert.equal((await b.read("worker-b")).code,"IDENTITY_WORKER_MISMATCH");
  assert.equal((await b.sign("worker-b",proposal("worker-b"))).code,"IDENTITY_WORKER_MISMATCH");
  assert.equal((await b.read("worker-a")).public_key_sha256,first.public_key_sha256);
  assert.equal(db.writes(),1);
});
test("simultaneous identity initialization converges on first committed nonextractable key",async()=>{
  const db=store(),a=bridge(db),b=bridge(db);
  const [one,two]=await Promise.all([a.initialize("worker-a"),b.initialize("worker-a")]);
  assert.equal(one.state,"READY");
  assert.equal(two.state,"READY");
  assert.equal(one.public_key_sha256,two.public_key_sha256);
  assert.equal(db.writes(),1);
});
test("two concurrent sign attempts for one nonce allow ONE result and spend the nonce",async()=>{
  const b=bridge(store());await b.initialize("worker-a");
  const c=proposal("worker-a");
  const [one,two]=await Promise.all([b.sign("worker-a",c),b.sign("worker-a",c)]);
  assert.equal([one,two].filter(x=>x.state==="SIGNED").length,1);
  assert.equal([one,two].filter(x=>x.code==="IDENTITY_CHALLENGE_REPLAY").length,1);
  assert.equal((await b.sign("worker-a",c)).code,"IDENTITY_CHALLENGE_REPLAY");
});
test("expired, too far future, malformed or cross-worker challenges never spend a nonce",async()=>{
  const db=store(),b=bridge(db);await b.initialize("worker-a");
  const before=db.inspect().used.length;
  const base=proposal("worker-a");
  const invalid=[
    {...base,expires_at_ms:2_000_000},
    {...base,expires_at_ms:2_030_001},
    {...base,expires_at_ms:1_999_999},
    {...base,installation_id:"0"},
    {...base,installation_id:"-1"},
    {...base,worker_id:"worker-b"},
    {...base,proposal_sha256:"x".repeat(64)},
    {...base,subject_sha256:"Z".repeat(64)},
    {...base,nonce:"c"},
    {...base,extra:true},
    {},null,"not a challenge",Array(6).fill("a"),
  ];
  for (const value of invalid) assert.equal(
    (await b.sign("worker-a",value)).code,"IDENTITY_CHALLENGE_REJECTED",
  );
  assert.equal(db.inspect().used.length,before);
});
test("nonce becomes unavailable when signing expires during crypto, with no signature returned",async()=>{
  const db=store();let now=2_000_000;
  const b=bridge(db,()=>{now+=20_000;return now;});
  await b.initialize("worker-a");
  const c=proposal("worker-a");
  // First now=2,020,000: expires in 10s. Second now=2,040,000: expired.
  assert.equal((await b.sign("worker-a",c)).code,"IDENTITY_CHALLENGE_EXPIRED");
  assert.equal(db.inspect().used.length,1);
});
test("storage read/write failures, corrupt profiles and mismatched keypairs all deny signing",async()=>{
  const db=store(),b=bridge(db);await b.initialize("worker-a");
  db.failWrites=true;
  assert.equal((await b.sign("worker-a",proposal("worker-a"))).code,"IDENTITY_STORAGE_UNAVAILABLE");
  db.failWrites=false;
  const orig=db.inspect();
  await db.corrupt({...orig,public_key:{crv:"P-256",kty:"EC",x:"invalid",y:"invalid"}});
  assert.equal((await b.sign("worker-a",proposal("worker-a"))).code,"IDENTITY_STORAGE_CORRUPT");
  await db.corrupt({...orig,private_key:"sensitive-string"});
  assert.equal((await b.read("worker-a")).code,"IDENTITY_STORAGE_CORRUPT");
  await db.corrupt({...orig,used:[{nonce:sha("c"),expires_at_ms:2_030_000},
    {nonce:sha("c"),expires_at_ms:2_030_000}]});
  assert.equal((await b.sign("worker-a",proposal("worker-a"))).code,"IDENTITY_STORAGE_CORRUPT");
});
test("a read-only device identity summary never returns P-256 private keys",async()=>{
  const db=store(),b=bridge(db);
  await b.initialize("worker-a");
  const visible=await publicIdentitySummary(b,"worker-a");
  assert.deepEqual(Object.keys(visible).sort(),["public_key_sha256","state","worker_id"]);
  assert.doesNotMatch(JSON.stringify(visible),/private_key|chrome|secret|token/);
});
test("different browser-profile stores have independent private keys and nonce history",async()=>{
  const a=bridge(store()),b=bridge(store());
  const [one,two]=await Promise.all([a.initialize("worker-a"),b.initialize("worker-a")]);
  assert.notEqual(one.public_key_sha256,two.public_key_sha256);
  assert.equal((await a.sign("worker-a",proposal("worker-a"))).state,"SIGNED");
  assert.equal((await b.sign("worker-a",proposal("worker-a"))).state,"SIGNED");
});
test("probe-only extension never exposes signing through popup/content script or network",()=>{
  const manifest=JSON.parse(readFileSync(new URL("../manifest.json",import.meta.url),"utf8"));
  const sw=readFileSync(new URL("../src/service-worker.ts",import.meta.url),"utf8");
  const cs=readFileSync(new URL("../src/content-script.ts",import.meta.url),"utf8");
  const popup=readFileSync(new URL("../src/popup.ts",import.meta.url),"utf8");
  assert.deepEqual(manifest.permissions,["storage"]);
  assert.deepEqual(manifest.host_permissions,["https://chatgpt.com/*"]);
  assert.doesNotMatch(sw,/\.sign\(|bke\.device\.identity\.sign|new WebSocket|connectNative/);
  assert.doesNotMatch(cs,/device-identity|signChallenge|private_key/);
  assert.doesNotMatch(popup,/\.sign\(|device_signature|private_key|new WebSocket/);
  assert.match(sw,/isTrustedPopup\(sender\)/);
  assert.match(sw,/IDENTITY_SENDER_REJECTED/);
});

test("ChatGPT content-script sender cannot overwrite popup-owned worker configuration",()=>{
  const sw=readFileSync(new URL("../src/service-worker.ts",import.meta.url),"utf8");
  for(const marker of ["GET_CONFIG_MESSAGE","SET_CONFIG_MESSAGE"]){
    assert.match(sw,new RegExp(
      "if \\(type === "+marker+"\\) \\{\\s*if \\(!isTrustedPopup\\(sender\\)\\)",
    ));
  }
  assert.match(sw,/CONFIG_SENDER_REJECTED/);
});
