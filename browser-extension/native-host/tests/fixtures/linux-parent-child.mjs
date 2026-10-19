// TEST-ONLY subprocess reading piped stdin and using REAL Linux procfs.
// Never registered as a native host or enabled in a browser.
import {witnessLinuxImmediateBrowserParent} from "../../linux-parent-provenance.mjs";
try {
  const chunks=[];
  let length=0;
  for await(const chunk of process.stdin){
    length+=chunk.length;
    if(length>8192)throw Error("TEST_INPUT_TOO_LARGE");
    chunks.push(chunk);
  }
  const config=JSON.parse(Buffer.concat(chunks).toString("utf8"));
  const result=await witnessLinuxImmediateBrowserParent(config);
  process.stdout.write(JSON.stringify(result));
}catch{
  process.stderr.write("LINUX_PARENT_PROVENANCE_UNVERIFIED");
  process.exitCode=1;
}
