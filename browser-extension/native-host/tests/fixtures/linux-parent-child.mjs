// TEST-ONLY subprocess exercising REAL Linux procfs. Never installed in host.
import {readFile} from "node:fs/promises";
import {witnessLinuxImmediateBrowserParent} from "../../linux-parent-provenance.mjs";
try {
  const json=await readFile("/dev/stdin","utf8");
  const config=JSON.parse(json);
  const result=await witnessLinuxImmediateBrowserParent(config);
  process.stdout.write(JSON.stringify(result));
}catch{
  process.stderr.write("LINUX_PARENT_PROVENANCE_UNVERIFIED");
  process.exitCode=1;
}
