import test from "node:test";
import assert from "node:assert/strict";
import {webcrypto} from "node:crypto";
import {readFileSync} from "node:fs";
import {mkdtemp,writeFile,rm} from "node:fs/promises";
import {spawn} from "node:child_process";
import {once} from "node:events";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {fileURLToPath} from "node:url";
import {createDeviceIdentityBridge,canonicalNativeProofMessage}
  from "../dist/device-identity.js";
import {NATIVE_HOST_NAME,proveLocalNativeHost}
  from "../dist/native-proof-client.js";
import {nativeProofMessage}
  from "../native-host/host.mjs";
import {encodeFrame}
  from "../native-host/framing.mjs";

const ORIGIN="chrome-extension://"+"a".repeat(32)+"/";
const H=n=>n.repeat(64);
const resources=()=>({
  chatgpt_target_sha256:H("1"),browser_profile_sha256:H("2"),bridge_identity_sha256:H("3"),
});
const profile=H("4");
function store(){
  let state;
  let gate=Promise.resolve(),failed=false;
  return {
    failNext:false,
    async atomic(f){
      let release;const next=new Promise(x=>release=x),previous=gate;
      gate=next;await previous;let draft=state===undefined?undefined:structuredClone(state);
      try {
        const out=await f({
          get:async()=>draft===undefined?undefined:structuredClone(draft),
          put:async(v)=>{if(this.failNext){this.failNext=false;throw Error("storage offline");}
            draft=structuredClone(v);},
        });
        state=draft;return out;
      }finally{release();}
    },
    inspect:()=>state,
  };
}
async function fixture(){
  const db=store(),clock=()=>Date.now();
  const identity=createDeviceIdentityBridge({store:db,cryptoImpl:webcrypto,now:clock});
  const key=await identity.initialize("worker-a");
  assert.equal(key.state,"READY");
  return {db,clock,identity,key};
}
function challenge(f,nonce=H("6"),overrides={}){
  return {origin:ORIGIN,worker_id:"worker-a",public_key_sha256:f.key.public_key_sha256,
    profile_binding_sha256:profile,resources:resources(),client_nonce:H("5"),
    server_nonce:nonce,expires_at_ms:Date.now()+10000,...overrides};
}
class FakePort{
  constructor(next,disconnect=()=>{}){
    this.sent=[];this.connected=true;this.next=next;this.disconnectFn=disconnect;
    this.messages=new Set();this.disconnects=new Set();
    this.onMessage={
      addListener:f=>this.messages.add(f),removeListener:f=>this.messages.delete(f),
    };
    this.onDisconnect={
      addListener:f=>this.disconnects.add(f),removeListener:f=>this.disconnects.delete(f),
    };
  }
  emit(msg){for(const l of [...this.messages])l(msg);}
  postMessage(msg){
    this.sent.push(msg);
    this.next(msg,this);
  }
  disconnect(){this.connected=false;this.disconnectFn();}
  closed(){for(const l of [...this.disconnects])l();}
}
function mockedRuntime(port,origin=ORIGIN){
  return {getURL:()=>origin,connectNative:name=>{
    assert.equal(name,NATIVE_HOST_NAME);
    return port;
  }};
}
function scriptedPort(f,{message,reply,disconnect}={}){
  return new FakePort((sent,port)=>{
    if(sent.type==="HELLO"){
      if(disconnect){queueMicrotask(()=>port.closed());return;}
      const response={type:"CHALLENGE",version:1,
        client_nonce:sent.client_nonce,server_nonce:H("6"),
        profile_binding_sha256:profile,expires_at_ms:Date.now()+8000};
      queueMicrotask(()=>port.emit(message?.(response)??response));
    }
    if(sent.type==="PROOF"){
      queueMicrotask(()=>port.emit(reply?.({
        type:"LOCAL_PROOF_OK",version:1,worker_id:"worker-a",
        public_key_sha256:f.key.public_key_sha256,
        admission_authority:"NONE",dispatch_authority:"NONE",
      })??{type:"LOCAL_PROOF_OK",version:1,worker_id:"worker-a",
        public_key_sha256:f.key.public_key_sha256,
        admission_authority:"NONE",dispatch_authority:"NONE"}));
    }
  });
}
const execute=(f,port,opts={})=>proveLocalNativeHost({
  identity:f.identity,runtime:mockedRuntime(port),workerId:"worker-a",
  resources:resources(),profileBindingSha256:profile,
  cryptoImpl:webcrypto,clock:f.clock,timeoutMs:10_000,...opts,
});
test("native signer matches PR #106 exact domain-separated message and nonexportable key",async()=>{
  const f=await fixture();const x=challenge(f),signed=await f.identity.signNativeProof("worker-a",x);
  assert.equal(signed.state,"SIGNED");
  const proof=canonicalNativeProofMessage(x);
  assert.equal(proof,nativeProofMessage(x));
  const pk=await webcrypto.subtle.importKey("jwk",f.key.public_key,
    {name:"ECDSA",namedCurve:"P-256"},false,["verify"]);
  assert.equal(await webcrypto.subtle.verify({name:"ECDSA",hash:"SHA-256"},pk,
    Buffer.from(signed.device_signature,"base64url"),new TextEncoder().encode(proof)),true);
  assert.equal(f.db.inspect().private_key.extractable,false);
  assert.equal((await f.identity.signNativeProof("worker-a",x)).code,"IDENTITY_CHALLENGE_REPLAY");
});
test("separate concurrent native signers spend the same server nonce once",async()=>{
  const f=await fixture(),x=challenge(f);
  const [a,b]=await Promise.all([
    f.identity.signNativeProof("worker-a",x),f.identity.signNativeProof("worker-a",x),
  ]);
  assert.equal([a,b].filter(y=>y.state==="SIGNED").length,1);
  assert.equal([a,b].filter(y=>y.code==="IDENTITY_CHALLENGE_REPLAY").length,1);
});
test("malformed native proof cannot sign or spend nonce",async()=>{
  const f=await fixture(),x=challenge(f);
  const invalid=[
    {...x,worker_id:"worker-b"},{...x,origin:"https://chatgpt.com/"},
    {...x,public_key_sha256:"a"},{...x,client_nonce:x.server_nonce},
    {...x,profile_binding_sha256:"x"},
    {...x,resources:{...x.resources,bridge_identity_sha256:"x"}},
    {...x,expires_at_ms:Date.now()+20000},{...x,expires_at_ms:Date.now()-1000},
    {...x,approved:true},{...x,server_nonce:"invalid"},null,[],
  ];
  for(const wrong of invalid){
    assert.equal((await f.identity.signNativeProof("worker-a",wrong)).code,
      "IDENTITY_NATIVE_CHALLENGE_REJECTED");
  }
  assert.equal(f.db.inspect().used.length,0);
});
test("native key fingerprint tampering and storage errors never return a signature",async()=>{
  const f=await fixture();
  assert.equal((await f.identity.signNativeProof("worker-a",
    challenge(f,H("6"),{public_key_sha256:H("a")}))).code,"IDENTITY_NATIVE_KEY_MISMATCH");
  const other=challenge(f,H("7"));f.db.failNext=true;
  assert.equal((await f.identity.signNativeProof("worker-a",other)).code,
    "IDENTITY_STORAGE_UNAVAILABLE");
});
test("strict local receipt is accepted but conveys no enrollment/dispatch capability",async()=>{
  const f=await fixture(),port=scriptedPort(f);
  const out=await execute(f,port);
  assert.deepEqual(out,{
    state:"LOCAL_PROOF_OK",worker_id:"worker-a",
    public_key_sha256:f.key.public_key_sha256,
    admission_authority:"NONE",dispatch_authority:"NONE",
  });
  assert.deepEqual(port.sent.map(x=>x.type),["HELLO","PROOF"]);
  assert.equal(port.connected,false);
  assert.doesNotMatch(JSON.stringify(out),/private_key|ghs_|token|installation/i);
});
test("host challenge nonce, clock, profile and schema tamper fails closed BEFORE signing",async()=>{
  for(const change of [
    c=>({...c,client_nonce:H("f")}),
    c=>({...c,server_nonce:c.client_nonce}),
    c=>({...c,profile_binding_sha256:H("f")}),
    c=>({...c,expires_at_ms:Date.now()+20000}),
    c=>({...c,expires_at_ms:Date.now()-1}),
    c=>({...c,host_authenticated:true}),
    c=>({...c,type:"DISPATCH"}),
    c=>({...c,version:2}),
  ]){
    const f=await fixture(),port=scriptedPort(f,{message:change});
    const result=await execute(f,port);
    assert.equal(result.code,"NATIVE_CLIENT_CHALLENGE_DENIED");
    assert.deepEqual(port.sent.map(x=>x.type),["HELLO"]);
    assert.equal(f.db.inspect().used.length,0);
    assert.equal(port.connected,false);
  }
});
test("fake elevated receipt, wrong key or worker cannot provide authority",async()=>{
  const transforms=[
    r=>({...r,admission_authority:"ACTIVE"}),
    r=>({...r,dispatch_authority:"ACTIVE"}),
    r=>({...r,worker_id:"worker-b"}),
    r=>({...r,public_key_sha256:H("a")}),
    r=>({...r,token:"fake"}),
    r=>({...r,version:2}),
  ];
  for(const reply of transforms){
    const f=await fixture(),port=scriptedPort(f,{reply});
    const result=await execute(f,port);
    assert.equal(result.code,"NATIVE_CLIENT_RECEIPT_DENIED");
    assert.equal(port.connected,false);
  }
});
test("mismatched worker/profile, absent host capability or disconnected port fails closed",async()=>{
  const f=await fixture();
  const p=scriptedPort(f);
  assert.equal((await execute(f,p,{workerId:"worker-b"})).code,"NATIVE_CLIENT_IDENTITY_UNAVAILABLE");
  assert.equal((await execute(f,p,{profileBindingSha256:"invalid"})).code,"NATIVE_CLIENT_CONFIG_INVALID");
  assert.equal((await execute(f,p,{runtime:{getURL:()=>ORIGIN,connectNative:()=>{throw Error("permission denied");}}})).code,
    "NATIVE_CLIENT_HOST_UNAVAILABLE");
  const gone=scriptedPort(f,{disconnect:true});
  assert.equal((await execute(f,gone)).code,"NATIVE_CLIENT_OUTCOME_UNCERTAIN");
  assert.equal(gone.connected,false);
});
test("native client remains unwired from Chrome MV3 service worker, popup and manifest",()=>{
  const sw=readFileSync(new URL("../src/service-worker.ts",import.meta.url),"utf8");
  const popup=readFileSync(new URL("../src/popup.ts",import.meta.url),"utf8");
  const manifest=JSON.parse(readFileSync(new URL("../manifest.json",import.meta.url),"utf8"));
  assert.deepEqual(manifest.permissions,["storage"]);
  assert.doesNotMatch(sw,/native-proof-client|connectNative|signNativeProof/);
  assert.doesNotMatch(popup,/native-proof-client|connectNative|signNativeProof/);
  assert.doesNotMatch(JSON.stringify(manifest),/nativeMessaging/);
});

// Genuine Node host subprocess with Chrome binary framing, driven through an
// injected runtime port. NOT an installed/authorized Chrome extension.
test("real PR #106 host child-process P-256 handshake matches TypeScript native client",async()=>{
  const f=await fixture(),root=await mkdtemp(join(tmpdir(),"bke-native-proof-client-"));
  const policyPath=join(root,"policy.json");
  const now=Date.now();
  const policy={
    version:1,allowed_origin:ORIGIN,worker_id:"worker-a",
    public_key_sha256:f.key.public_key_sha256,
    profile_binding_sha256:profile,resources:resources(),
    expires_at_ms:now+40_000,
  };
  const entry=fileURLToPath(new URL("../native-host/entry.mjs",import.meta.url));
  let child;
  try {
    await writeFile(policyPath,JSON.stringify(policy),{mode:0o600});
    child=spawn(process.execPath,[entry,policyPath,ORIGIN],{
      stdio:["pipe","pipe","pipe"],env:{PATH:process.env.PATH??""},
    });
    const exits=once(child,"exit");
    let buf=Buffer.alloc(0),port;
    const messages=new Set(),disconnects=new Set();
    const pending=[];
    const incoming=x=>{
      for(const fn of [...messages])fn(x);
    };
    child.stdout.on("data",chunk=>{
      buf=Buffer.concat([buf,chunk]);
      while(buf.length>=4){
        const len=buf.readUInt32LE(0);
        if(len===0||len>16384)throw Error("BAD_TEST_FRAME");
        if(buf.length<len+4)break;
        const parsed=JSON.parse(buf.subarray(4,len+4).toString("utf8"));
        buf=buf.subarray(len+4);
        incoming(parsed);
      }
    });
    child.on("exit",()=>{for(const fn of [...disconnects])fn();});
    port={
      postMessage:x=>child.stdin.write(encodeFrame(x)),
      disconnect:()=>{try{child.stdin.end();}catch{}},
      onMessage:{addListener:fn=>messages.add(fn),removeListener:fn=>messages.delete(fn)},
      onDisconnect:{addListener:fn=>disconnects.add(fn),removeListener:fn=>disconnects.delete(fn)},
    };
    const result=await execute(f,port);
    assert.equal(result.state,"LOCAL_PROOF_OK",JSON.stringify(result));
    assert.equal(result.admission_authority,"NONE");
    assert.equal(result.dispatch_authority,"NONE");
    const [exit]=await exits;
    assert.equal(exit,0);
  }finally{
    if(child&&!child.killed)child.kill();
    await rm(root,{recursive:true,force:true});
  }
});
