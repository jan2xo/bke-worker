// TEST-ONLY subprocess exercising REAL Linux procfs. Never installed in host.
import {readFile} from "node:fs/promises";
import {witnessLinuxImmediateBrowserParent} from "../../linux-parent-provenance.mjs";
try {
  const json=await readFile("/dev/stdin","utf8");
  const config=JSON.parse(json);
  const result=await witnessLinuxImmediateBrowserParent(config);
  process.stdout.write(JSON.stringify(result));
}catch{
  if(process.env.BKE_PRIVATE_PROC_TEST_DIAGNOSTICS==="1"){
    try{
      const {statfs,readlink,realpath,lstat,readFile}=await import("node:fs/promises");
      const {dirname}=await import("node:path");
      const expected=await realpath(process.execPath);
      const parentExe=await readlink("/proc/"+process.ppid+"/exe");
      let at=dirname(expected),unsafeDir=false,dirs=0;
      while(at!=="/"&&dirs<60){
        const st=await lstat(at);if((st.mode&0o022)!==0)unsafeDir=true;
        at=dirname(at);dirs++;
      }
      const ps=await readFile("/proc/"+process.ppid+"/status","utf8");
      const puid=ps.match(/^Uid:.*$/m)?.[0]?.replace(/\d/g,"#");
      process.stderr.write(JSON.stringify({
        procfs:(await statfs("/proc")).type===0x9fa0,
        selfExeMatches:(await readlink("/proc/self/exe"))===expected,
        parentExeMatches:parentExe===expected,
        parentUidShape:Boolean(puid),
        unsafeExecutableAncestor:unsafeDir,
        parentStatusValid:Boolean(ps.match(/^Uid:.*$/m)),
      }));
    }catch{process.stderr.write("DEBUG_UNAVAILABLE");}
  }else process.stderr.write("LINUX_PARENT_PROVENANCE_UNVERIFIED");
  process.exitCode=1;
}
