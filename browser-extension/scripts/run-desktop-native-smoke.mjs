import { spawnSync } from "node:child_process";
import { mkdir, rename, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

const extensionRoot = fileURLToPath(new URL("../", import.meta.url));
const repositoryRoot = resolve(extensionRoot, "..");
const testFile = join(extensionRoot, "tests", "desktop-native-integration-smoke.test.mjs");

function argument(name) {
  const index = process.argv.indexOf(name);
  if (index < 0) return null;
  const value = process.argv[index + 1];
  if (!value || value.startsWith("--")) throw new Error(name.toUpperCase().replaceAll("-", "_") + "_VALUE_REQUIRED");
  return value;
}

const suppliedReport = argument("--report");
const reportPath = resolve(suppliedReport || join(
  process.env.RUNNER_TEMP || tmpdir(),
  "bke-desktop-native-smoke-report.json",
));
const started = new Date().toISOString();
const nodeMajor = Number(process.versions.node.split(".")[0]);
let sourceSha = "UNAVAILABLE";
let sourceRef = "UNAVAILABLE";
const rev = spawnSync("git", ["rev-parse", "HEAD"], { cwd: repositoryRoot, encoding: "utf8" });
if (rev.status === 0) sourceSha = rev.stdout.trim();
const branch = spawnSync("git", ["branch", "--show-current"], { cwd: repositoryRoot, encoding: "utf8" });
if (branch.status === 0) sourceRef = branch.stdout.trim() || "DETACHED";

const safeEnv = {
  PATH: process.env.PATH || "",
  HOME: process.env.HOME || "",
  TMPDIR: process.env.TMPDIR || "",
  TEMP: process.env.TEMP || "",
  TMP: process.env.TMP || "",
  SYSTEMROOT: process.env.SYSTEMROOT || "",
  LANG: process.env.LANG || "C",
};
const run = nodeMajor >= 22
  ? spawnSync(process.execPath, ["--test", "--test-reporter=tap", testFile], {
      cwd: extensionRoot,
      encoding: "utf8",
      env: safeEnv,
      timeout: 120_000,
      maxBuffer: 8 * 1024 * 1024,
    })
  : { status: 1, signal: null, stdout: "", stderr: "NODE_22_OR_NEWER_REQUIRED" };

const output = String(run.stdout || "");
const passedNames = [];
const failedNames = [];
for (const line of output.split(/\r?\n/)) {
  let match = /^\s*ok\s+\d+\s+-\s+(.+?)\s*$/.exec(line);
  if (match) passedNames.push(match[1]);
  match = /^\s*not ok\s+\d+\s+-\s+(.+?)\s*$/.exec(line);
  if (match) failedNames.push(match[1]);
}
const number = (label) => {
  const match = new RegExp("^# " + label + " (\\d+)\\s*$", "m").exec(output);
  return match ? Number(match[1]) : null;
};
const total = number("tests");
const reportedPass = number("pass");
const reportedFail = number("fail");
const summaryPresent = total !== null && reportedPass !== null && reportedFail !== null;
const suitePass = run.status === 0 && summaryPresent &&
  total > 0 && reportedPass === total && reportedFail === 0 &&
  passedNames.length >= reportedPass && failedNames.length === 0;
const ended = new Date().toISOString();

const report = {
  schema_version: 1,
  suite: "bke.desktop-native-integration-smoke",
  status: suitePass ? "PASS" : "FAIL",
  started_at: started,
  finished_at: ended,
  source: {
    repository: "jan2xo/bke-worker",
    ref: sourceRef,
    sha: sourceSha,
    node_version: process.version,
    platform: process.platform,
    architecture: process.arch,
  },
  counts: {
    tests_reported: total,
    passed_reported: reportedPass,
    failed_reported: reportedFail,
    passed_names: passedNames,
    failed_names: failedNames,
    process_exit_code: run.status ?? null,
    process_signal: run.signal ?? null,
  },
  evidence_boundary: {
    native_host: "REAL_NODE_CHILD_PROCESS",
    message_transport: "CHROME_NATIVE_MESSAGING_FRAME_FORMAT_OVER_STDIO",
    extension_runtime: "INJECTED_TEST_ADAPTER_NOT_REAL_CHROME",
    device_key: "DISPOSABLE_WEBCRYPTO_P256_IDENTITY; PRIVATE_KEY_NOT_EXPORTED",
    installation_integrity: "SEPARATE_PR110_WITNESS_NOT_EQUIVALENT_TO_SESSION_AUTHENTICATION",
    process_provenance: "SEPARATE_PR111_LINUX_PARENT_WITNESS_NOT_PROVEN_BY_THIS_SUITE",
    authenticated_browser_session: "NOT_PROVEN",
    command_center_admission_authority: "NONE",
    dispatch_authority: "NONE",
    real_chrome_acceptance: "NOT_RUN",
    real_chrome_reason: "The checked-in Manifest V3 still intentionally omits nativeMessaging, and this source-only intent does not register a host or alter browser permissions.",
  },
};
const content = JSON.stringify(report, null, 2) + "\n";
await mkdir(dirname(reportPath), { recursive: true });
const temporary = reportPath + "." + process.pid + ".tmp";
await writeFile(temporary, content, { mode: 0o600 });
await rename(temporary, reportPath);

console.log("BKE_DESKTOP_NATIVE_SMOKE=" + report.status);
console.log("BKE_DESKTOP_NATIVE_SMOKE_SOURCE_SHA=" + sourceSha);
console.log("BKE_DESKTOP_NATIVE_SMOKE_REPORT=" + reportPath);
console.log("BKE_REAL_CHROME_ACCEPTANCE=NOT_RUN");
if (!suitePass) {
  if (run.error) console.error("Harness error: " + run.error.message);
  if (run.stderr) console.error(String(run.stderr).slice(0, 4000));
  if (output) console.error(output.slice(0, 16_000));
  if (!summaryPresent) console.error("TAP_SUMMARY_MISSING");
  process.exitCode = 1;
}
