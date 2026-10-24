import test from "node:test";
import assert from "node:assert/strict";
import { PassThrough } from "node:stream";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { generateKeyPairSync,createHash,sign } from "node:crypto";
import { mkdtemp,writeFile,rm,chmod,symlink,mkdir,readdir } from "node:fs/promises";
import {createServer} from "node:net";
import {controllerSignedPayload} from "../controller-admission.mjs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  nativeFrameReader,encodeFrame,MAX_FRAME_BYTES,writeFrame,
} from "../framing.mjs";
import {runNativeProofHost,nativeProofMessage,validNativeHostPolicy}
  from "../host.mjs";

const ORIGIN="chrome-extension://"+"a".repeat(32)+"/";
const T=1_790_000_000_000;
const H=n=>n.repeat(64);
const resources=()=>({
  chatgpt_target_sha256:H("1"),
  browser_profile_sha256:H("2"),
  bridge_identity_sha256:H("3"),
});
function identity(){
  const {privateKey,publicKey}=generateKeyPairSync("ec",{namedCurve:"prime256v1"});
  const jwk=publicKey.export({format:"jwk"});
  const deviceKey={crv:"P-256",kty:"EC",x:jwk.x,y:jwk.y};
  const digest=createHash("sha256").update(JSON.stringify(deviceKey)).digest("hex");
  return {privateKey,public_key:deviceKey,keyHash:digest};
}
function fixture(){
  const key=identity();
  const p={
    version:1,allowed_origin:ORIGIN,worker_id:"worker-a",
    public_key_sha256:key.keyHash,profile_binding_sha256:H("4"),
    resources:resources(),expires_at_ms:T+100000,
  };
  const hello={
    type:"HELLO",version:1,worker_id:"worker-a",public_key:key.public_key,
    resources:resources(),client_nonce:H("5"),
  };
  return {key,policy:p,hello};
}
function replyProof(f,challenge){
  const payload=nativeProofMessage({
    origin:ORIGIN,worker_id:f.hello.worker_id,
    public_key_sha256:f.policy.public_key_sha256,
    profile_binding_sha256:f.policy.profile_binding_sha256,
    resources:f.policy.resources,
    client_nonce:f.hello.client_nonce,server_nonce:challenge.server_nonce,
    expires_at_ms:challenge.expires_at_ms,
  });
  return {type:"PROOF",version:1,
    client_nonce:f.hello.client_nonce,server_nonce:challenge.server_nonce,
    device_signature:sign("sha256",Buffer.from(payload),
      {key:f.key.privateKey,dsaEncoding:"ieee-p1363"}).toString("base64url")};
}
async function launch(f,{origin=ORIGIN,now=()=>T,serverNonce=H("6"),timeoutMs=1000,controllerOptions=null}={}){
  const input=new PassThrough(),output=new PassThrough();
  const handle=runNativeProofHost({
    input,output,claimedOrigin:origin,policy:f.policy,now,
    nonce:()=>serverNonce,timeoutMs,controllerOptions,
  });
  const response=nativeFrameReader(output);
  const send=v=>input.write(encodeFrame(v));
  return {handle,response,send,input,output};
}
async function successful(f){
  const s=await launch(f);
  s.send(f.hello);
  const challenge=await s.response.next();
  s.send(replyProof(f,challenge));
  const ok=await s.response.next();
  assert.equal(await s.handle,"LOCAL_PROOF_OK");
  return {challenge,ok};
}
test("genuine P-256 proof yields only a local possession receipt, not device enrollment",async()=>{
  const f=fixture();
  const {challenge,ok}=await successful(f);
  assert.equal(challenge.type,"CHALLENGE");
  assert.equal(challenge.server_nonce,H("6"));
  assert.equal(challenge.profile_binding_sha256,H("4"));
  assert.equal(challenge.expires_at_ms,T+1000);
  assert.deepEqual(ok,{
    type:"LOCAL_PROOF_OK",version:1,worker_id:"worker-a",
    public_key_sha256:f.key.keyHash,
    admission_authority:"NONE",dispatch_authority:"NONE",
  });
  assert.doesNotMatch(JSON.stringify(ok),/token|signature|installation|paired|access/i);
});
test("one-shot post-signature native envelope echoes only scoped read-only proof",async()=>{
  const f=fixture(),s=await launch(f);
  s.send({...f.hello,read_only_probe:true});
  const challenge=await s.response.next();
  s.send(replyProof(f,challenge));
  assert.equal((await s.response.next()).type,"LOCAL_PROOF_OK");
  const ping=await s.response.next();
  assert.equal(ping.type,"LOCAL_READ_ONLY_PING");
  assert.equal(ping.worker_id,f.policy.worker_id);
  assert.equal(ping.profile_binding_sha256,f.policy.profile_binding_sha256);
  s.send(ping);
  assert.deepEqual(await s.response.next(),{
    type:"LOCAL_READ_ONLY_PONG",version:1,worker_id:f.policy.worker_id,
    admission_authority:"NONE",dispatch_authority:"NONE",
    message_send_authority:"NONE",controller_authentication:"NOT_ESTABLISHED",
    external_controller_transport:"NOT_CONNECTED",
  });
  assert.equal(await s.handle,"LOCAL_READ_ONLY_PONG");
});
test("effectful, tampered and extra-key native read-only envelopes fail closed",async()=>{
  for(const change of [
    x=>({...x,type:"SEND_CHATGPT_MESSAGE"}),
    x=>({...x,worker_id:"worker-b"}),
    x=>({...x,proof_binding_sha256:H("e")}),
    x=>({...x,command:"please send"}),
  ]){
    const f=fixture(),s=await launch(f);
    s.send({...f.hello,read_only_probe:true});
    s.send(replyProof(f,await s.response.next()));
    assert.equal((await s.response.next()).type,"LOCAL_PROOF_OK");
    s.send(change(await s.response.next()));
    await assert.rejects(s.handle,/NATIVE_READ_ONLY_ENVELOPE_DENIED/);
    s.input.destroy();
  }
});
test("probe opt-in cannot bypass signed proof or inject arbitrary HELLO fields",async()=>{
  const f=fixture();
  for(const hello of [
    {...f.hello,read_only_probe:false},
    {...f.hello,read_only_probe:true,permission:"dispatch"},
  ]){
    const s=await launch(f);s.send(hello);
    await assert.rejects(s.handle,/NATIVE_HELLO_DENIED/);
    s.input.destroy();
  }
  const s=await launch(f);
  s.send({...f.hello,read_only_probe:true});
  const proof=replyProof(f,await s.response.next());
  s.send({...proof,device_signature:"A".repeat(86)});
  await assert.rejects(s.handle,/NATIVE_PROOF_DENIED/);
  s.input.destroy();
});
test("all pinned policy fields are required; origin and host expiry cannot be invented by a device",async()=>{
  const f=fixture();
  for(const bad of [
    {...f.policy,allowed_origin:"chrome-extension://evil/"},
    {...f.policy,allowed_origin:"https://chatgpt.com/"},
    {...f.policy,worker_id:"worker-b"},
    {...f.policy,public_key_sha256:H("a")},
    {...f.policy,profile_binding_sha256:""},
    {...f.policy,resources:{...resources(),bridge_identity_sha256:"x"}},
    {...f.policy,expires_at_ms:T},
    {...f.policy,expires_at_ms:T+91*86400000},
    {...f.policy,secret:"admin"},
    {},
  ]) {
    // Invalid *shape* refuses initial policy; valid conflicting pins deny HELLO.
    const q=await launch({...f,policy:bad});
    q.send(f.hello);
    await assert.rejects(q.handle);
    q.input.destroy();
  }
  const wrongOrigin=await launch(f,{origin:"chrome-extension://"+"b".repeat(32)+"/"});
  await assert.rejects(wrongOrigin.handle,/NATIVE_POLICY_DENIED/);
});
test("wrong pinned worker, public key or resource fingerprints cannot produce a challenge",async()=>{
  const f=fixture(),different=identity();
  for(const hello of [
    {...f.hello,worker_id:"worker-b"},
    {...f.hello,public_key:different.public_key},
    {...f.hello,resources:{...resources(),chatgpt_target_sha256:H("f")}},
    {...f.hello,client_nonce:"invalid"},
    {...f.hello,origin:ORIGIN},
    {...f.hello,type:"DISPATCH"},
  ]){
    const s=await launch(f);
    s.send(hello);
    await assert.rejects(s.handle,/NATIVE_HELLO_DENIED/);
    s.input.destroy();
  }
});
test("tampered signature, switched nonce or extra PROOF fields fail closed",async()=>{
  const f=fixture();
  for(const modify of [
    (proof)=>({...proof,device_signature:"A".repeat(86)}),
    (proof)=>({...proof,server_nonce:H("e")}),
    (proof)=>({...proof,client_nonce:H("c")}),
    (proof)=>({...proof,device_authenticated:true}),
  ]){
    const s=await launch(f);s.send(f.hello);
    const issued=await s.response.next();
    s.send(modify(replyProof(f,issued)));
    await assert.rejects(s.handle,/NATIVE_PROOF_DENIED/);
    s.input.destroy();
  }
});
test("replaying a proof against a fresh host challenge fails",async()=>{
  const f=fixture();
  const first=await launch(f,{serverNonce:H("6")});first.send(f.hello);
  const challenge=await first.response.next();
  const oldProof=replyProof(f,challenge);first.send(oldProof);
  assert.equal((await first.response.next()).type,"LOCAL_PROOF_OK");
  await first.handle;
  const second=await launch(f,{serverNonce:H("7")});second.send(f.hello);
  assert.equal((await second.response.next()).server_nonce,H("7"));
  second.send(oldProof);
  await assert.rejects(second.handle,/NATIVE_PROOF_DENIED/);
  second.input.destroy();
});
test("truncated, invalid JSON and oversize headers reject without executing a session",async()=>{
  const f=fixture();
  for(const broken of [
    Buffer.from([0xff,0xff,0xff,0x7f]),
    Buffer.from([0x00,0x00,0x00,0x00]),
    Buffer.from([0x04,0x00,0x00,0x00,0x7b]),
    Buffer.concat([Buffer.from([0x01,0x00,0x00,0x00]),Buffer.from("{")]),
  ]){
    const s=await launch(f);
    s.input.write(broken);s.input.end();
    await assert.rejects(s.handle);
  }
});
test("buffering fragmented length prefix and split payload works",async()=>{
  const f=fixture(),s=await launch(f);
  const hello=encodeFrame(f.hello);
  for(let i=0;i<hello.length;i+=3)s.input.write(hello.subarray(i,i+3));
  const challenge=await s.response.next();
  const proof=encodeFrame(replyProof(f,challenge));
  for(let i=0;i<proof.length;i+=7)s.input.write(proof.subarray(i,i+7));
  assert.equal((await s.response.next()).type,"LOCAL_PROOF_OK");
  assert.equal(await s.handle,"LOCAL_PROOF_OK");
});
test("host deadline expires with no proof; does not silently grant authorization",async()=>{
  const f=fixture();let now=T;
  const s=await launch(f,{now:()=>now});
  s.send(f.hello);const challenge=await s.response.next();
  now=challenge.expires_at_ms;
  s.send(replyProof(f,challenge));
  await assert.rejects(s.handle,/NATIVE_PROOF_DENIED/);
  s.input.destroy();
});
test("native executable performs real child-process Chrome wire framing with owner policy",async()=>{
  const f=fixture();
  // This does not install any Chrome native host manifest or browser permissions.
  const root=await mkdtemp(join(tmpdir(),"bke-native-host-test-"));
  const path=join(root,"policy.json");
  const entry=fileURLToPath(new URL("../entry.mjs",import.meta.url));
  const now=Date.now();
  f.policy.expires_at_ms=now+30000;
  try{
    await writeFile(path,JSON.stringify(f.policy),{mode:0o600});
    const child=spawn(process.execPath,[entry,path,ORIGIN],{
      stdio:["pipe","pipe","pipe"],env:{"PATH":process.env.PATH??""},
    });
    const output=nativeFrameReader(child.stdout);
    child.stdin.write(encodeFrame(f.hello));
    const challenge=await output.next();
    assert.equal(challenge.type,"CHALLENGE");
    child.stdin.write(encodeFrame(replyProof(f,challenge)));
    const receipt=await output.next();
    assert.equal(receipt.type,"LOCAL_PROOF_OK");
    child.stdin.end();
    const [exit]=await once(child,"exit");
    assert.equal(exit,0);
  }finally{await rm(root,{recursive:true,force:true});}
});
test("malicious world-writable or symlinked host policy fails before the first frame",async()=>{
  const f=fixture();
  const root=await mkdtemp(join(tmpdir(),"bke-native-host-security-"));
  const path=join(root,"policy.json");
  f.policy.expires_at_ms=Date.now()+30000;
  try{
    await writeFile(path,JSON.stringify(f.policy),{mode:0o600});
    await chmod(path,0o666);
    const entry=fileURLToPath(new URL("../entry.mjs",import.meta.url));
    const child=spawn(process.execPath,[entry,path,ORIGIN],{
      stdio:["pipe","pipe","pipe"],
    });
    const stdout=[];
    child.stdout.on("data",x=>stdout.push(x));
    child.stdin.end();
    const [exit]=await once(child,"exit");
    assert.equal(exit,1);
    assert.equal(Buffer.concat(stdout).length,0);
  }finally{await rm(root,{recursive:true,force:true});}
});
test("frame encoding enforces maximum size and remains little endian",()=>{
  assert.throws(()=>encodeFrame({a:"X".repeat(MAX_FRAME_BYTES)}),/OVERSIZE/);
  const output=encodeFrame({ok:true});
  assert.equal(output.readUInt32LE(0),Buffer.byteLength(JSON.stringify({ok:true})));
});

test("symlinked policy is rejected even when target file is owner-readable",async()=>{
  const f=fixture(),root=await mkdtemp(join(tmpdir(),"bke-native-symlink-test-"));
  f.policy.expires_at_ms=Date.now()+30000;
  try {
    const target=join(root,"real-policy.json"),link=join(root,"policy-link.json");
    await writeFile(target,JSON.stringify(f.policy),{mode:0o600});
    await symlink(target,link);
    const entry=fileURLToPath(new URL("../entry.mjs",import.meta.url));
    const child=spawn(process.execPath,[entry,link,ORIGIN],{stdio:["pipe","pipe","pipe"]});
    const stdout=[];child.stdout.on("data",b=>stdout.push(b));
    child.stdin.end();
    const [exit]=await once(child,"exit");
    assert.equal(exit,1);
    assert.equal(Buffer.concat(stdout).length,0);
  }finally{await rm(root,{recursive:true,force:true});}
});

test("explicit controller probe denies missing owner provisioning after local cryptographic proof",async()=>{
  const f=fixture(),s=await launch(f);
  s.send({...f.hello,read_only_probe:true,controller_probe:true});
  const challenge=await s.response.next();s.send(replyProof(f,challenge));
  assert.equal((await s.response.next()).type,"LOCAL_PROOF_OK");
  const ping=await s.response.next();s.send(ping);
  assert.equal((await s.response.next()).type,"LOCAL_READ_ONLY_PONG");
  await assert.rejects(s.handle,/NATIVE_CONTROLLER_NOT_PROVISIONED/);
  s.input.destroy();
});
test("separately signed Unix controller is verified only after signed native and strict read-only proof",async()=>{
  const root=await mkdtemp(join(tmpdir(),"bke-host-controller-"));
  const fenceDir=join(root,"fences"),socketPath=join(root,"controller.sock");
  await mkdir(fenceDir,{mode:0o700});
  const {publicKey,privateKey}=generateKeyPairSync("ed25519");
  const principal={controller_id:"controller-a",public_key:publicKey.export({format:"jwk"})};
  const server=createServer(async socket=>{
    try{
      const challenge=await nativeFrameReader(socket,4096).next();
      const frame={
        type:"CONTROLLER_AUTH_READ_ONLY",version:1,controller_id:principal.controller_id,
        worker_id:challenge.worker_id,profile_binding_sha256:challenge.profile_binding_sha256,
        browser_profile_sha256:challenge.browser_profile_sha256,
        chatgpt_target_sha256:challenge.chatgpt_target_sha256,
        bridge_identity_sha256:challenge.bridge_identity_sha256,
        client_nonce:challenge.client_nonce,server_nonce:challenge.server_nonce,
        challenge_nonce:challenge.challenge_nonce,
        issued_at_ms:challenge.issued_at_ms,expires_at_ms:challenge.expires_at_ms,
        signature:sign(null,Buffer.from(controllerSignedPayload(challenge,principal.controller_id)),
          privateKey).toString("base64url"),
      };
      await writeFrame(socket,frame);socket.end();
    }catch{socket.destroy();}
  });
  try{
    server.listen(socketPath);await once(server,"listening");
    const f=fixture(),s=await launch(f,{controllerOptions:{principal,socketPath,fenceDir}});
    s.send({...f.hello,read_only_probe:true,controller_probe:true});
    s.send(replyProof(f,await s.response.next()));
    assert.equal((await s.response.next()).type,"LOCAL_PROOF_OK");
    s.send(await s.response.next());
    assert.equal((await s.response.next()).type,"LOCAL_READ_ONLY_PONG");
    assert.deepEqual(await s.response.next(),{
      type:"CONTROLLER_AUTH_READ_ONLY_ACK",version:1,
      worker_id:f.policy.worker_id,controller_id:principal.controller_id,
      principal_authentication:"ED25519_SIGNATURE_VERIFIED",
      github_assignment:"NOT_VERIFIED",chatgpt_target_attestation:"NOT_PROVEN",
      scope_fencing:"LOCAL_PERSISTENT_OWNER_RECOVERY_REQUIRED",
      dispatch_authority:"NONE",message_send_authority:"NONE",
    });
    assert.equal(await s.handle,"CONTROLLER_AUTH_READ_ONLY");
    assert.equal((await readdir(fenceDir)).length,4);
    const again=await launch(f,{controllerOptions:{principal,socketPath,fenceDir}});
    again.send({...f.hello,read_only_probe:true,controller_probe:true});
    again.send(replyProof(f,await again.response.next()));
    assert.equal((await again.response.next()).type,"LOCAL_PROOF_OK");
    again.send(await again.response.next());
    assert.equal((await again.response.next()).type,"LOCAL_READ_ONLY_PONG");
    await assert.rejects(again.handle,/FENCE_CONFLICT_OR_IO_UNCERTAIN/);
    again.input.destroy();
  }finally{
    await new Promise(resolve=>server.close(resolve));
    await rm(root,{recursive:true,force:true});
  }
});
test("controller HELLO cannot skip read-only opt-in or P-256 signature",async()=>{
  const f=fixture();
  for(const hello of [
    {...f.hello,controller_probe:true},
    {...f.hello,read_only_probe:false,controller_probe:true},
    {...f.hello,read_only_probe:true,controller_probe:false},
  ]){
    const s=await launch(f);s.send(hello);
    await assert.rejects(s.handle,/NATIVE_HELLO_DENIED/);s.input.destroy();
  }
  const s=await launch(f);
  s.send({...f.hello,read_only_probe:true,controller_probe:true});
  const challenge=await s.response.next();
  s.send({...replyProof(f,challenge),device_signature:"A".repeat(86)});
  await assert.rejects(s.handle,/NATIVE_PROOF_DENIED/);s.input.destroy();
});

test("real entry requires exact owner-reviewed controller config bytes before reading Chrome frames",async()=>{
  const f=fixture(),dir=await mkdtemp(join(tmpdir(),"bke-entry-controller-pin-"));
  const policy=join(dir,"owner-policy.json"),config=join(dir,"controller-config.json");
  const entry=fileURLToPath(new URL("../entry.mjs",import.meta.url));
  f.policy.expires_at_ms=Date.now()+30000;
  try{
    await writeFile(policy,JSON.stringify(f.policy),{mode:0o600});
    const bytes=Buffer.from('{"enabled":false,"version":1}\n');
    await writeFile(config,bytes,{mode:0o600});
    const digest=createHash("sha256").update(bytes).digest("hex");
    for(const expectedHash of [H("b"),"invalid"]){
      const child=spawn(process.execPath,[entry,policy,ORIGIN,expectedHash],{
        stdio:["pipe","pipe","pipe"]});
      const output=[];child.stdout.on("data",x=>output.push(x));child.stdin.end();
      const [code]=await once(child,"exit");
      assert.equal(code,1);assert.equal(Buffer.concat(output).length,0);
    }
    const child=spawn(process.execPath,[entry,policy,ORIGIN,digest],{
      stdio:["pipe","pipe","pipe"]});
    const wire=nativeFrameReader(child.stdout);
    child.stdin.write(encodeFrame(f.hello));
    const challenge=await wire.next();
    child.stdin.write(encodeFrame(replyProof(f,challenge)));
    assert.equal((await wire.next()).type,"LOCAL_PROOF_OK");
    child.stdin.end();
    assert.equal((await once(child,"exit"))[0],0);
  }finally{await rm(dir,{recursive:true,force:true});}
});
