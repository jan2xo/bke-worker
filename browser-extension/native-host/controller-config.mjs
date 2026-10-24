// Owner-pinned *PUBLIC* controller credentials. A Chrome message or
// LOCAL_PROOF_OK receipt must never nominate its own controller principal.
// The source-pinned launcher supplies the expected SHA-256 of these bytes.
import {createHash,createPublicKey} from 'node:crypto';
import {open,lstat,realpath} from 'node:fs/promises';
import {constants} from 'node:fs';
import {dirname,resolve} from 'node:path';
import {validNativeHostPolicy} from './host.mjs';
const HASH=/^[0-9a-f]{64}$/u;
const BASE=['bridge_identity_sha256','browser_profile_sha256','chatgpt_target_sha256'];
const ROOT=['allowed_origin','controller_id','enabled','fence_dir','profile_binding_sha256',
 'public_key','resources','socket_path','version','worker_id'];
const OFF=['enabled','version'];
const exact=(x,keys)=>x!==null&&typeof x==='object'&&!Array.isArray(x)&&
 Object.keys(x).sort().join(',')===keys.slice().sort().join(',');
function pathSafe(p){
 return typeof p==='string'&&p.startsWith('/')&&resolve(p)===p&&
  !p.includes('//')&&!p.includes('\0')&&
  !/(?:^|\/)\.\.?(?:\/|$)/u.test(p);
}
export function validateReviewedControllerConfig(value,policy,now=Date.now()){
 if(!validNativeHostPolicy(policy,now))throw Error('CONTROLLER_CONFIG_POLICY_DENIED');
 if(exact(value,OFF)&&value.version===1&&value.enabled===false)return null;
 if(!exact(value,ROOT)||value.version!==1||value.enabled!==true||
    value.allowed_origin!==policy.allowed_origin||
    value.worker_id!==policy.worker_id||
    value.profile_binding_sha256!==policy.profile_binding_sha256||
    !exact(value.resources,BASE)||
    BASE.some(k=>value.resources[k]!==policy.resources[k])||
    typeof value.controller_id!=='string'||
    !/^[a-z0-9][a-z0-9-]{0,62}$/u.test(value.controller_id)||
    !pathSafe(value.socket_path)||!pathSafe(value.fence_dir)||
    value.fence_dir===value.socket_path||
    !exact(value.public_key,['crv','kty','x'])||
    value.public_key.kty!=='OKP'||value.public_key.crv!=='Ed25519'||
    typeof value.public_key.x!=='string'||!/^[A-Za-z0-9_-]{43}$/u.test(value.public_key.x))
    throw Error('CONTROLLER_CONFIG_SCOPE_OR_PRINCIPAL_DENIED');
 try{
   const key=createPublicKey({format:'jwk',key:value.public_key});
   if(key.asymmetricKeyType!=='ed25519'||key.export({format:'jwk'}).x!==value.public_key.x)
     throw Error('not ed25519');
 }catch{throw Error('CONTROLLER_CONFIG_PRINCIPAL_DENIED');}
 return Object.freeze({
  principal:Object.freeze({controller_id:value.controller_id,public_key:Object.freeze({...value.public_key})}),
  socketPath:value.socket_path,fenceDir:value.fence_dir,
 });
}
export async function readPinnedControllerConfig({path,expectedSha256,policy,now=Date.now()}={}){
 if(!pathSafe(path)||typeof expectedSha256!=='string'||!HASH.test(expectedSha256)||
    typeof process.getuid!=='function'||!constants.O_NOFOLLOW)
   throw Error('CONTROLLER_CONFIG_PROVENANCE_DENIED');
 // Reject symlinked or shared parents, not merely a no-follow final file.
 let parent;try{
  parent=await lstat(dirname(path));
  if(await realpath(dirname(path))!==dirname(path)||parent.isSymbolicLink()||
     !parent.isDirectory()||parent.uid!==process.getuid()||
     (parent.mode&0o077)!==0)
    throw Error('bad parent');
 }catch{throw Error('CONTROLLER_CONFIG_PARENT_DENIED');}
 let fd;
 try{
  fd=await open(path,constants.O_RDONLY|constants.O_NOFOLLOW);
  const stat=await fd.stat();
  if(!stat.isFile()||stat.uid!==process.getuid()||(stat.mode&0o077)!==0||
     stat.size<8||stat.size>4096||stat.nlink!==1)
    throw Error('bad file');
  const bytes=await fd.readFile();
  if(createHash('sha256').update(bytes).digest('hex')!==expectedSha256)
    throw Error('changed file');
  let data;try{data=JSON.parse(bytes.toString('utf8'));}
  catch{throw Error('bad json');}
  return validateReviewedControllerConfig(data,policy,now);
 }catch{throw Error('CONTROLLER_CONFIG_INTEGRITY_DENIED');}
 finally{if(fd)await fd.close().catch(()=>{});}
}
export function controllerConfigDigest(bytes){
 return createHash('sha256').update(bytes).digest('hex');
}
