#!/usr/bin/env node
// Native host process. Chrome-standard length-framed stdin/stdout ONLY.
// NOT registered in Chrome: operator-controlled native manifest/OS origin
// authorization and server-side host attestation are separate acceptance.
import { open,constants } from "node:fs/promises";
import { isAbsolute, resolve,join,dirname } from "node:path";
import {readPinnedControllerConfig} from "./controller-config.mjs";
import { fileURLToPath } from "node:url";
import { runNativeProofHost } from "./host.mjs";

async function readOwnerPinnedPolicy(path) {
  if(typeof path!=="string"||!isAbsolute(path)||path.includes("\0"))
    throw Error("NATIVE_POLICY_PATH_INVALID");
  // Policy is not a secret, but MUST NOT be writable by other OS accounts
  // (it pins worker ID, extension origin, public key and target fingerprints).
  if(typeof process.getuid!=="function"||!constants.O_NOFOLLOW)
    throw Error("NATIVE_OS_POLICY_NOT_CERTIFIED");
  const handle=await open(path,constants.O_RDONLY|constants.O_NOFOLLOW);
  try{
    const info=await handle.stat();
    if(!info.isFile()||info.size<8||info.size>4096||
      (info.mode&0o022)!==0||
      info.uid!==process.getuid())
      throw Error("NATIVE_POLICY_OWNER_INVALID");
    const raw=await handle.readFile({encoding:"utf8"});
    return JSON.parse(raw);
  }finally{await handle.close();}
}

export async function main(args=process.argv.slice(2)) {
  if(args.length!==2&&args.length!==3)throw Error("NATIVE_INVOCATION_DENIED");
  const [policyPath,claimedOrigin,expectedControllerConfigSha256]=args;
  const policy=await readOwnerPinnedPolicy(policyPath);
  // Only the installed, hash-pinned launcher can specify this digest.
  // Browser-origin argv is never a controller principal or approval.
  // Without the third pinned argument, the ordinary source smoke remains
  // local-only and any controller_probe is explicitly denied.
  const controllerOptions=expectedControllerConfigSha256===undefined?null:
    await readPinnedControllerConfig({
      path:join(dirname(policyPath),"controller-config.json"),
      expectedSha256:expectedControllerConfigSha256,policy,
    });
  return runNativeProofHost({
    input:process.stdin,output:process.stdout,policy,claimedOrigin,
    controllerOptions,
  });
}

if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  main().then(()=>{process.exitCode=0;},
    ()=>{
      // Never emit policy, frame, URL, key or stack to stderr/logging;
      // authentication failure is a bounded nonzero exit only.
      process.exitCode=1;
      process.stdin.destroy();
    });
}
