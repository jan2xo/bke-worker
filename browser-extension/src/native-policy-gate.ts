// Owner-selected LOCAL Chrome native policy input; never an identity or send grant.
// This parser is used only by a trusted extension-popup initiated action.
const HASH=/^[0-9a-f]{64}$/;
const KEYS=["allowed_origin","expires_at_ms","profile_binding_sha256",
 "public_key_sha256","resources","version","worker_id"];
const RESOURCE=["browser_profile_sha256","bridge_identity_sha256",
 "chatgpt_target_sha256"];
const exact=(v:unknown,keys:readonly string[]):v is Record<string,unknown> =>
 v!==null&&typeof v==="object"&&!Array.isArray(v)&&
 Object.keys(v).sort().join(",")===[...keys].sort().join(",");
type Pins={
 chatgpt_target_sha256:string;
 browser_profile_sha256:string;
 bridge_identity_sha256:string;
};
type LocalPolicy={
 state:"LOCAL_POLICY_MATCH_ONLY";
 profileBindingSha256:string;
 resources:Pins;
 pairing_authority:"NONE";
 dispatch_authority:"NONE";
};
type Blocked={state:"BLOCKED";code:string};
const blocked=(code:string):Blocked=>({state:"BLOCKED",code});
export function checkOwnerNativePolicy(
 value:unknown,
 expected:{origin:string;workerId:string;publicKeySha256:string;now:number}
):LocalPolicy|Blocked{
 if(!exact(value,KEYS)||value.version!==1||
    typeof expected?.origin!=="string"||
    !/^chrome-extension:\/\/[a-p]{32}\/$/.test(expected.origin)||
    typeof expected.workerId!=="string"||
    !/^[a-z0-9][a-z0-9-]{0,62}$/.test(expected.workerId)||
    !HASH.test(expected.publicKeySha256)||
    !Number.isSafeInteger(expected.now)||
    expected.now<=0)
  return blocked("NATIVE_POLICY_SCHEMA_INVALID");
 if(value.allowed_origin!==expected.origin||
    value.worker_id!==expected.workerId||
    value.public_key_sha256!==expected.publicKeySha256)
  return blocked("NATIVE_POLICY_IDENTITY_MISMATCH");
 if(!HASH.test(value.profile_binding_sha256 as string)||
    !exact(value.resources,RESOURCE)||
    !RESOURCE.every(k=>HASH.test(value.resources[k] as string))||
    !Number.isSafeInteger(value.expires_at_ms)||
    (value.expires_at_ms as number)<=expected.now||
    (value.expires_at_ms as number)>expected.now+30*86400000)
  return blocked("NATIVE_POLICY_PINS_OR_EXPIRY_INVALID");
 const resources=value.resources as Pins;
 const hashes=[expected.publicKeySha256,value.profile_binding_sha256,
  ...RESOURCE.map(k=>resources[k as keyof Pins])];
 if(new Set(hashes).size!==hashes.length)
  return blocked("NATIVE_POLICY_DUPLICATE_PINS");
 return Object.freeze({
  state:"LOCAL_POLICY_MATCH_ONLY",
  profileBindingSha256:value.profile_binding_sha256 as string,
  resources:Object.freeze({
   chatgpt_target_sha256:resources.chatgpt_target_sha256,
   browser_profile_sha256:resources.browser_profile_sha256,
   bridge_identity_sha256:resources.bridge_identity_sha256,
  }),
  pairing_authority:"NONE",dispatch_authority:"NONE",
 });
}
