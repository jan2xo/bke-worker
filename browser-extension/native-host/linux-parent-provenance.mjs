// Linux-only KERNEL process-executable witness. SOURCE ONLY, UNWIRED.
// Shows which running binary immediately launched this host; NOT Chrome,
// browser-profile, ChatGPT-session, enrollment or dispatch authorization.
import {statfs,readFile,readlink,realpath,lstat,open} from "node:fs/promises";
import {constants} from "node:fs";
import {createHash} from "node:crypto";
import {dirname,isAbsolute,resolve} from "node:path";

const PROC_MAGIC=0x9fa0;
const SHA=/^[a-f0-9]{64}$/u;
const MAX_BINARY=512*1024*1024;
const MAX_PROOF_MS=15000;
const reject=()=>{throw Error("LINUX_PARENT_PROVENANCE_UNVERIFIED");};

const canonical=p=>typeof p==="string"&&isAbsolute(p)&&resolve(p)===p&&
  !p.includes("\0")&&!p.includes("//")&&!p.includes("/./")&&!p.includes("/../");

// Parsed from kernel /proc/PID/stat, not caller-provided pid/command line.
// The comm field is enclosed in parentheses and may itself include spaces,
// parentheses and process-controlled text. Use its final closing delimiter.
export function parseLinuxProcStat(raw){
  if(typeof raw!=="string"||raw.length>8192||!/^\d+ \(/u.test(raw))return null;
  const end=raw.lastIndexOf(") ");
  if(end<0)return null;
  const pid=raw.slice(0,raw.indexOf(" ("));
  const fields=raw.slice(end+2).trim().split(/\s+/u);
  if(fields.length<20||!/^\d+$/u.test(pid)||!/^\d+$/u.test(fields[1])||
    !/^\d+$/u.test(fields[19])||
    !Number.isSafeInteger(Number(pid))||Number(pid)<1||
    !Number.isSafeInteger(Number(fields[1]))||Number(fields[1])<0||
    !/^[RSDZTWXIKP]$/u.test(fields[0]))return null;
  return Object.freeze({pid:Number(pid),ppid:Number(fields[1]),start_ticks:fields[19]});
}
function parseUid(status){
  if(typeof status!=="string"||status.length>131072)return null;
  const match=/^Uid:\s+(\d+)\s+(\d+)\s+(\d+)\s+(\d+)\s*$/mu.exec(status);
  if(!match)return null;
  const nums=match.slice(1).map(Number);
  return nums.every(Number.isSafeInteger)&&nums.every(n=>n===nums[0])?nums[0]:null;
}
async function sourceProcess(pid){
  if(!Number.isSafeInteger(pid)||pid<1)reject();
  const stat=parseLinuxProcStat(await readFile(`/proc/${pid}/stat`,"utf8"));
  if(!stat||stat.pid!==pid)reject();
  const uid=parseUid(await readFile(`/proc/${pid}/status`,"utf8"));
  if(uid===null)reject();
  const exe=await readlink(`/proc/${pid}/exe`);
  if(!canonical(exe)||exe.endsWith(" (deleted)"))reject();
  return Object.freeze({...stat,uid,exe});
}
function sameProcess(a,b){
  return a.pid===b.pid&&a.ppid===b.ppid&&a.start_ticks===b.start_ticks&&
    a.uid===b.uid&&a.exe===b.exe;
}
async function trustedPathDirectories(path,uid){
  let at=dirname(path);
  for(let steps=0;steps<64;steps++){
    const st=await lstat(at);
    if(!st.isDirectory()||st.isSymbolicLink()||
      (st.uid!==0&&st.uid!==uid)||(st.mode&0o022)!==0)reject();
    if(at==="/")return;
    at=dirname(at);
  }
  reject();
}
async function runningExeDigest(pid,uid,started){
  const procPath=`/proc/${pid}/exe`;
  const h=await open(procPath,constants.O_RDONLY);
  try{
    const before=await h.stat();
    if(!before.isFile()||before.size<1||before.size>MAX_BINARY||
       (before.uid!==uid&&before.uid!==0)||
       (before.mode&0o022)!==0||(before.mode&0o111)===0)reject();
    const hash=createHash("sha256");
    let total=0;
    for await (const bytes of h.createReadStream({autoClose:false,highWaterMark:65536})){
      total+=bytes.length;
      if(total>MAX_BINARY||Date.now()-started>MAX_PROOF_MS)reject();
      hash.update(bytes);
    }
    const after=await h.stat();
    if(total!==before.size||after.size!==before.size||
      after.dev!==before.dev||after.ino!==before.ino||
      after.mtimeMs!==before.mtimeMs||after.ctimeMs!==before.ctimeMs)reject();
    return hash.digest("hex");
  }finally{await h.close();}
}

/**
 * Host-controlled policy only. No process ID, /proc root, witness callbacks or
 * argv strings accepted: self/parent are discovered directly from the kernel.
 * Owner must separately pin Chrome executable path/SHA; this function cannot
 * establish a Chrome extension, browser profile or authenticated session.
 */
export async function witnessLinuxImmediateBrowserParent({
  ownerPinnedBrowserExecutablePath,
  ownerPinnedBrowserExecutableSha256,
  ownerPinnedHostExecutablePath,
  expectedUid,
}={}){
  try{
    if(process.platform!=="linux"||typeof process.getuid!=="function"||
      !canonical(ownerPinnedBrowserExecutablePath)||
      !canonical(ownerPinnedHostExecutablePath)||
      typeof ownerPinnedBrowserExecutableSha256!=="string"||
      !SHA.test(ownerPinnedBrowserExecutableSha256)||
      !Number.isSafeInteger(expectedUid)||expectedUid!==process.getuid())reject();
    const started=Date.now();
    const fs=await statfs("/proc");
    if(Number(fs.type)!==PROC_MAGIC)reject();
    if(ownerPinnedHostExecutablePath!==await realpath(process.execPath)||
      ownerPinnedBrowserExecutablePath!==await realpath(ownerPinnedBrowserExecutablePath))reject();
    await trustedPathDirectories(ownerPinnedBrowserExecutablePath,expectedUid);
    const self=await sourceProcess(process.pid);
    if(self.uid!==expectedUid||self.exe!==ownerPinnedHostExecutablePath||
       self.ppid<2||self.ppid===self.pid)reject();
    const parent=await sourceProcess(self.ppid);
    if(parent.uid!==expectedUid||parent.exe!==ownerPinnedBrowserExecutablePath||
      parent.ppid===parent.pid)reject();
    const digest=await runningExeDigest(parent.pid,expectedUid,started);
    if(digest!==ownerPinnedBrowserExecutableSha256)reject();
    const afterParent=await sourceProcess(parent.pid);
    const afterSelf=await sourceProcess(process.pid);
    if(!sameProcess(parent,afterParent)||!sameProcess(self,afterSelf)||
      Date.now()-started>MAX_PROOF_MS)reject();
    return Object.freeze({
      state:"NATIVE_PARENT_EXECUTABLE_MATCHED",
      browser_session_authority:"NONE",profile_authority:"NONE",
      device_admission_authority:"NONE",dispatch_authority:"NONE",
    });
  }catch{reject();}
}
