// F1-03 non-deployable local transport primitive. Host integration requires
// a separately certified P-256 proof and owner-pinned controller configuration.
// Unix-domain socket is only a carrier: Ed25519 signature is the principal.
import {createConnection} from 'node:net';
import {lstat,realpath} from 'node:fs/promises';
import {dirname} from 'node:path';
import {nativeFrameReader,writeFrame} from './framing.mjs';
import {createControllerChallenge} from './controller-admission.mjs';

function deny(){throw Error('CONTROLLER_SOCKET_DENIED');}
export async function authenticatedReadOnlyControllerTransport({
  socketPath,scope,principal,clientNonce,serverNonce,fenceDir,
  clock=()=>Date.now(),nonce,timeoutMs=3000,
}={}){
  if(typeof process.getuid!=='function'||typeof socketPath!=='string'||
     !socketPath.startsWith('/')||socketPath.includes('\0')||
     socketPath.includes('//')||/(?:^|\/)\.\.?(?:\/|$)/u.test(socketPath)||
     !Number.isSafeInteger(timeoutMs)||timeoutMs<100||timeoutMs>5000)deny();
  let parent,st;
  try{
    parent=dirname(socketPath);
    const p=await lstat(parent);
    st=await lstat(socketPath);
    if(await realpath(parent)!==parent||await realpath(socketPath)!==socketPath||
       !p.isDirectory()||p.isSymbolicLink()||p.uid!==process.getuid()||
       (p.mode&0o077)!==0||!st.isSocket()||st.isSymbolicLink()||
       st.uid!==process.getuid())deny();
  }catch{deny();}
  const gate=createControllerChallenge({scope,principal,clientNonce,serverNonce,
    clock,nonce,ttlMs:timeoutMs});
  // One bounded attempt. No retries on timeout, broken pipe or MV3 suspension.
  const sock=createConnection({path:socketPath,allowHalfOpen:false});
  sock.on('error',()=>{}); // never print OS/private socket paths
  let timer;
  const deadline=new Promise((_,reject)=>{
    timer=setTimeout(()=>{sock.destroy();reject(Error('CONTROLLER_SOCKET_TIMEOUT'));},timeoutMs);
  });
  const work=(async()=>{
    await new Promise((resolve,reject)=>{
      if(sock.destroyed)return reject(Error('CONTROLLER_SOCKET_UNAVAILABLE'));
      sock.once('connect',resolve);sock.once('error',reject);
    });
    await writeFrame(sock,gate.challenge);
    const read=nativeFrameReader(sock,4096);
    try{
      const reply=await read.next();
      // Successful crypto alone is insufficient: durable local resource locks
      // must commit before any authenticated read-only result is returned.
      return await gate.accept(reply,{fenceDir});
    }finally{read.close();}
  })();
  try{return await Promise.race([work,deadline]);}
  finally{clearTimeout(timer);gate.close();sock.destroy();}
}
