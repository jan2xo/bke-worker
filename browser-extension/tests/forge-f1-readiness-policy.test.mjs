import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { evaluateF1DesktopReadiness } from "../scripts/forge-f1-readiness-policy.mjs";

const head = "a".repeat(40);
const extensionId = "a".repeat(32);
const extensionOrigin = "chrome-extension://" + extensionId + "/";
const sha256 = "b".repeat(64);

function fixture() {
  return {
    readinessSessionId: "c".repeat(24),
    repository: {
      origin: "https://github.com/jan2xo/bke-worker.git",
      branch: "main", headSha: head, remoteMainSha: head, clean: true,
    },
    sourceSmoke: { status: "PASS", sourceSha: head },
    browser: {
      installed: true, platform: "Darwin", name: "Google Chrome",
      version: "130.0.0.0", binarySha256: sha256,
      nodeVersion: "v22.14.0", nodeBinarySha256: "d".repeat(64),
    },
    profile: {
      path: "/Users/test/.bke-worker/f1/chrome-profile", pathCanonical: true,
      exists: true, ownerMatches: true, privateMode: true, dedicated: true,
      activeProcess: true, exclusiveOwnerAttested: true,
    },
    extension: {
      id: extensionId, version: "0.1.0", manifestVersion: 3, matchCount: 1,
      enabled: true, path: "/Users/test/source/browser-extension",
      pathMatches: true, versionMatches: true,
      permissions: ["storage", "webNavigation"], optionalPermissions: ["nativeMessaging"],
      hostPermissions: ["https://chatgpt.com/*"], nativeMessagingPermission: "NOT_CHECKED",
    },
    nativeHost: {
      status: "VERIFIED_REGISTRATION_ONLY", name: "bke.worker.desktop",
      origin: extensionOrigin, policyVerified: true,
    },
    chatgpt: { targetCount: 1, exclusivityAttested: true, authenticatedAndIdle: true },
    safety: {
      messageSendAttempted: false, profileSecretsRead: false,
      otherProfilesTouched: false, credentialsWritten: false,
    },
  };
}

const codes = (input) => evaluateF1DesktopReadiness(input).blocker_codes;

test("complete owner-attested evidence yields readiness but no worker or send authority", () => {
  const report = evaluateF1DesktopReadiness(fixture());
  assert.equal(report.source_status, "SOURCE_SMOKE_PASS");
  assert.equal(report.real_chrome_status, "REAL_CHROME_READY");
  assert.deepEqual(report.blocker_codes, []);
  assert.equal(report.authority.worker_assignment, "UNENROLLED");
  assert.equal(report.authority.message_send_authority, "NONE");
  assert.equal(report.chatgpt.conversation_id, "NOT_CREATED_NO_SEND_OCCURRED");
  assert.equal(report.extension.native_messaging_permission, "NOT_CHECKED");
  assert.equal(report.extension.native_messaging_optional_declared, true);
  assert.equal(report.extension.identity_evidence_source, "OWNER_VISUAL_ATTESTATION");
  assert.equal(report.extension.loaded_enabled_from_canonical_source_owner_attested, true);
  assert.equal(report.native_host.live_chrome_connection, "NOT_TESTED");
});

test("source-only pass remains distinct from missing real Chrome readiness", () => {
  const e = fixture(); e.browser.installed = false;
  const r = evaluateF1DesktopReadiness(e);
  assert.equal(r.source_status, "SOURCE_SMOKE_PASS");
  assert.equal(r.real_chrome_status, "BLOCKED");
  assert.ok(r.blocker_codes.includes("GOOGLE_CHROME_NOT_FOUND"));
});

test("stale checkout and smoke from another SHA fail closed", () => {
  const e = fixture(); e.repository.remoteMainSha = "e".repeat(40); e.sourceSmoke.sourceSha = "f".repeat(40);
  const r = evaluateF1DesktopReadiness(e);
  assert.equal(r.source_status, "SOURCE_SMOKE_BLOCKED");
  assert.ok(r.blocker_codes.includes("STALE_CHECKOUT"));
  assert.ok(r.blocker_codes.includes("SOURCE_SMOKE_SHA_MISMATCH"));
});

test("wrong origin and branch fail closed", () => {
  const e = fixture(); e.repository.origin = "https://example.invalid/fake.git"; e.repository.branch = "feature/f1";
  assert.ok(codes(e).includes("REPOSITORY_ORIGIN_UNTRUSTED"));
  assert.ok(codes(e).includes("CHECKOUT_NOT_MAIN"));
});

test("dirty checkout blocks readiness", () => {
  const e = fixture(); e.repository.clean = false;
  assert.ok(codes(e).includes("CHECKOUT_DIRTY"));
});

test("default/shared profile cannot qualify as isolated", () => {
  const e = fixture(); e.profile.dedicated = false; e.profile.exclusiveOwnerAttested = false;
  assert.ok(codes(e).includes("PROFILE_NOT_ISOLATED"));
  assert.ok(codes(e).includes("PROFILE_EXCLUSIVITY_NOT_ATTESTED"));
});

test("zero or duplicate ChatGPT targets fail closed", () => {
  for (const count of [0, 2, "1"]) {
    const e = fixture(); e.chatgpt.targetCount = count;
    assert.ok(codes(e).includes("CHATGPT_TARGET_COUNT_NOT_ONE"));
  }
});

test("unsafe/noncanonical profile path fails closed without serializing the raw path", () => {
  const e = fixture(); e.profile.path = "/Users/test/../Default"; e.profile.pathCanonical = false;
  const r = evaluateF1DesktopReadiness(e);
  assert.ok(r.blocker_codes.includes("PROFILE_PATH_UNSAFE"));
  assert.ok(r.blocker_codes.includes("PROFILE_PATH_NOT_CANONICAL"));
  assert.equal(JSON.stringify(r).includes("/Users/test/../Default"), false);
  assert.equal(JSON.stringify(r).includes("/Users/test/.bke-worker"), false);
});

test("missing, duplicate, disabled, wrong-source and version-mismatched extension fail closed", () => {
  const cases = [
    [e => e.extension.matchCount = 0, "EXTENSION_MISSING_OR_DUPLICATE"],
    [e => e.extension.matchCount = 2, "EXTENSION_MISSING_OR_DUPLICATE"],
    [e => e.extension.pathMatches = false, "EXTENSION_SOURCE_PATH_MISMATCH"],
    [e => e.extension.enabled = false, "EXTENSION_NOT_ENABLED"],
    [e => e.extension.versionMatches = false, "EXTENSION_VERSION_MISMATCH"],
  ];
  for (const [mutate, code] of cases) { const e = fixture(); mutate(e); assert.ok(codes(e).includes(code)); }
});

test("invalid extension IDs and permission drift fail closed", () => {
  const e = fixture(); e.extension.id = "z".repeat(32); e.nativeHost.origin = "chrome-extension://" + "z".repeat(32) + "/";
  assert.ok(codes(e).includes("EXTENSION_ID_INVALID_OR_MISSING"));
  const p = fixture(); p.extension.permissions = ["storage", "nativeMessaging"]; p.extension.nativeMessagingPermission = true;
  assert.ok(codes(p).includes("EXTENSION_PERMISSION_BOUNDARY_DRIFT"));
  assert.ok(codes(p).includes("NATIVE_MESSAGING_PERMISSION_EVIDENCE_INVALID"));
  for (const optional of [[], ["nativeMessaging", "debugger"], ["cookies"]]) {
    const drift = fixture(); drift.extension.optionalPermissions = optional;
    assert.ok(codes(drift).includes("EXTENSION_OPTIONAL_PERMISSION_BOUNDARY_DRIFT"));
  }
  const absentClaim = fixture(); absentClaim.extension.nativeMessagingPermission = false;
  assert.ok(codes(absentClaim).includes("NATIVE_MESSAGING_PERMISSION_EVIDENCE_INVALID"));
});

test("unsupported OS/browser versions and malformed runtime digests fail closed", () => {
  const os = fixture(); os.browser.platform = "FreeBSD"; assert.ok(codes(os).includes("UNSUPPORTED_OPERATING_SYSTEM"));
  const browser = fixture(); browser.browser.name = "Chromium"; assert.ok(codes(browser).includes("UNTRUSTED_OR_UNSUPPORTED_BROWSER"));
  const old = fixture(); old.browser.version = "115.0.0.0"; assert.ok(codes(old).includes("CHROME_VERSION_UNSUPPORTED"));
  const hash = fixture(); hash.browser.binarySha256 = "not-a-sha"; assert.ok(codes(hash).includes("CHROME_RUNTIME_SHA_INVALID"));
  const node = fixture(); node.browser.nodeVersion = "v18.0.0"; assert.ok(codes(node).includes("NODE_RUNTIME_UNSUPPORTED"));
});

test("native host identity, extension origin and owner policy must match", () => {
  const name = fixture(); name.nativeHost.name = "different.host"; assert.ok(codes(name).includes("NATIVE_HOST_IDENTITY_MISMATCH"));
  const origin = fixture(); origin.nativeHost.origin = "chrome-extension://" + "b".repeat(32) + "/"; assert.ok(codes(origin).includes("NATIVE_HOST_EXTENSION_ORIGIN_MISMATCH"));
  const policy = fixture(); policy.nativeHost.policyVerified = false; assert.ok(codes(policy).includes("NATIVE_HOST_OWNER_POLICY_NOT_VERIFIED"));
  const missing = fixture(); missing.nativeHost.status = "MISSING"; assert.ok(codes(missing).includes("NATIVE_HOST_REGISTRATION_NOT_VERIFIED"));
});

test("ChatGPT authentication is a human attestation, not profile data", () => {
  const e = fixture(); e.chatgpt.authenticatedAndIdle = false;
  assert.ok(codes(e).includes("CHATGPT_NOT_HUMAN_CONFIRMED_AUTHENTICATED_AND_IDLE"));
});

test("any attempted send, profile secret read, other-profile access or credential write blocks readiness", () => {
  const cases = [
    ["messageSendAttempted", "MESSAGE_SEND_NOT_PROVEN_ABSENT", "message_send_attempted"],
    ["profileSecretsRead", "PROFILE_SECRET_READ_NOT_PROVEN_ABSENT", "profile_secrets_read"],
    ["otherProfilesTouched", "OTHER_PROFILE_ACCESS_NOT_PROVEN_ABSENT", "other_profiles_touched"],
    ["credentialsWritten", "CREDENTIAL_WRITE_NOT_PROVEN_ABSENT", "credentials_written"],
  ];
  for (const [field, code, reportField] of cases) {
    const e = fixture(); e.safety[field] = true;
    const r = evaluateF1DesktopReadiness(e);
    assert.ok(r.blocker_codes.includes(code));
    assert.equal(r.safety[reportField], true);
    assert.equal(r.real_chrome_status, "BLOCKED");
  }
});

test("missing real-host and browser proof cannot be replaced with source mocks", () => {
  const e = fixture(); e.nativeHost.status = "MISSING"; e.chatgpt.authenticatedAndIdle = false;
  const r = evaluateF1DesktopReadiness(e);
  assert.equal(r.source_status, "SOURCE_SMOKE_PASS");
  assert.equal(r.real_chrome_status, "BLOCKED");
  assert.ok(r.blocker_codes.includes("NATIVE_HOST_REGISTRATION_NOT_VERIFIED"));
  assert.ok(r.blocker_codes.includes("CHATGPT_NOT_HUMAN_CONFIRMED_AUTHENTICATED_AND_IDLE"));
});

test("non-object input and malformed readiness session fail closed", () => {
  assert.equal(evaluateF1DesktopReadiness(null).real_chrome_status, "BLOCKED");
  const e = fixture(); e.readinessSessionId = "x";
  assert.ok(codes(e).includes("READINESS_SESSION_ID_INVALID"));
});

test("native-host fail closed before ChatGPT prompts does not invent zero tabs or an auth failure", () => {
  const e = fixture();
  e.nativeHost.status = "MISSING";
  e.nativeHost.policyVerified = false;
  e.chatgpt = { targetCount: null, exclusivityAttested: false, authenticatedAndIdle: false };
  e.operatorBlocker = "NATIVE_HOST_INSTALL_FAILED_OR_OWNER_POLICY_MISSING";
  const r = evaluateF1DesktopReadiness(e);
  assert.equal(r.source_status, "SOURCE_SMOKE_PASS");
  assert.equal(r.real_chrome_status, "BLOCKED");
  assert.ok(r.blocker_codes.includes("NATIVE_HOST_INSTALL_FAILED_OR_OWNER_POLICY_MISSING"));
  assert.ok(r.blocker_codes.includes("CHATGPT_TARGET_NOT_EVALUATED"));
  assert.ok(!r.blocker_codes.includes("CHATGPT_TARGET_COUNT_NOT_ONE"));
  assert.ok(!r.blocker_codes.includes("CHATGPT_TARGET_EXCLUSIVITY_NOT_ATTESTED"));
  assert.ok(!r.blocker_codes.includes("CHATGPT_NOT_HUMAN_CONFIRMED_AUTHENTICATED_AND_IDLE"));
  assert.equal(r.chatgpt.open_target_count, null);
  assert.equal(r.chatgpt.target_count_source, "NOT_EVALUATED");
  assert.equal(r.chatgpt.authenticated_and_idle, null);
  assert.equal(r.chatgpt.authentication_evidence_source, "NOT_EVALUATED");
  assert.equal(r.authority.message_send_authority, "NONE");
});

test("missing ChatGPT evidence always fails closed, without false owner attestation", () => {
  const e = fixture();
  delete e.chatgpt;
  const r = evaluateF1DesktopReadiness(e);
  assert.equal(r.real_chrome_status, "BLOCKED");
  assert.ok(r.blocker_codes.includes("CHATGPT_TARGET_NOT_EVALUATED"));
  assert.equal(r.chatgpt.open_target_count, null);
  assert.equal(r.chatgpt.target_count_source, "NOT_EVALUATED");
});

test("actual owner-entered zero or duplicate ChatGPT tabs still fail", () => {
  for (const count of [0, 2]) {
    const e = fixture();
    e.chatgpt.targetCount = count;
    const r = evaluateF1DesktopReadiness(e);
    assert.equal(r.real_chrome_status, "BLOCKED");
    assert.ok(r.blocker_codes.includes("CHATGPT_TARGET_COUNT_NOT_ONE"));
    assert.ok(!r.blocker_codes.includes("CHATGPT_TARGET_NOT_EVALUATED"));
    assert.equal(r.chatgpt.open_target_count, count);
    assert.equal(r.chatgpt.target_count_source, "OWNER_VISUAL_ATTESTATION");
  }
});

test("sequential prompts preserve unasked confirmation states after a count failure", () => {
  for (const count of [0, 2]) {
    const e = fixture();
    e.chatgpt = { targetCount: count, exclusivityAttested: null, authenticatedAndIdle: null };
    e.profile.exclusiveOwnerAttested = true;
    const r = evaluateF1DesktopReadiness(e);
    assert.ok(r.blocker_codes.includes("CHATGPT_TARGET_COUNT_NOT_ONE"));
    assert.ok(!r.blocker_codes.includes("CHATGPT_TARGET_EXCLUSIVITY_NOT_ATTESTED"));
    assert.ok(!r.blocker_codes.includes("CHATGPT_NOT_HUMAN_CONFIRMED_AUTHENTICATED_AND_IDLE"));
    assert.equal(r.chatgpt.target_exclusivity_attested, null);
    assert.equal(r.chatgpt.target_exclusivity_evidence_source, "NOT_EVALUATED");
    assert.equal(r.chatgpt.authenticated_and_idle, null);
    assert.equal(r.chatgpt.authentication_evidence_source, "NOT_EVALUATED");
    assert.equal(r.real_chrome_status, "BLOCKED");
  }
});

test("target uniqueness and authentication report their own evaluated states", () => {
  const pending = fixture();
  pending.chatgpt = {targetCount: 1, exclusivityAttested: true, authenticatedAndIdle: null};
  let r = evaluateF1DesktopReadiness(pending);
  assert.ok(r.blocker_codes.includes("CHATGPT_AUTH_IDLE_NOT_EVALUATED"));
  assert.equal(r.chatgpt.target_exclusivity_attested, true);
  assert.equal(r.chatgpt.authenticated_and_idle, null);
  const declined = fixture();
  declined.chatgpt = {targetCount: 1, exclusivityAttested: true, authenticatedAndIdle: false};
  r = evaluateF1DesktopReadiness(declined);
  assert.ok(r.blocker_codes.includes("CHATGPT_NOT_HUMAN_CONFIRMED_AUTHENTICATED_AND_IDLE"));
  assert.equal(r.chatgpt.authentication_evidence_source, "OWNER_CONFIRMATION_FAILED");
  const missing = fixture();
  missing.chatgpt = {targetCount: 1, exclusivityAttested: null, authenticatedAndIdle: null};
  r = evaluateF1DesktopReadiness(missing);
  assert.ok(r.blocker_codes.includes("CHATGPT_TARGET_EXCLUSIVITY_NOT_EVALUATED"));
  assert.equal(r.real_chrome_status, "BLOCKED");
});

test("actual embedded shell Python report producer preserves absent, invalid and completed stages", () => {
  const shell=readFileSync(new URL("../../scripts/forge-f1-desktop-readiness.sh",import.meta.url),"utf8");
  const startMarker='python3 - "$EVIDENCE_FILE" <<\'PY\'\n';
  const first=shell.indexOf(startMarker);
  assert.notEqual(first,-1,"actual embedded report producer exists");
  const begin=first+startMarker.length, end=shell.indexOf("\nPY\n",begin);
  assert.ok(end>begin);
  const producer=shell.slice(begin,end);
  const tmp=mkdtempSync(join(tmpdir(),"bke-f1-python-report-"));
  try {
    const cases=[
      {name:"before-count",count:"",exclusive:"",auth:"",countExpected:null,authExpected:null,code:"CHATGPT_TARGET_NOT_EVALUATED"},
      {name:"count-zero",count:"0",exclusive:"",auth:"",countExpected:0,authExpected:null,code:"CHATGPT_TARGET_COUNT_NOT_ONE"},
      {name:"count-duplicate",count:"2",exclusive:"",auth:"",countExpected:2,authExpected:null,code:"CHATGPT_TARGET_COUNT_NOT_ONE"},
      {name:"count-invalid",count:"bad",exclusive:"",auth:"",countExpected:"INVALID",authExpected:null,code:"CHATGPT_TARGET_COUNT_NOT_ONE"},
      {name:"count-then-interrupted",count:"1",exclusive:"true",auth:"",countExpected:1,authExpected:null,code:"CHATGPT_AUTH_IDLE_NOT_EVALUATED"},
      {name:"auth-not-confirmed",count:"1",exclusive:"true",auth:"false",countExpected:1,authExpected:false,code:"CHATGPT_NOT_HUMAN_CONFIRMED_AUTHENTICATED_AND_IDLE"},
      {name:"all-confirmed",count:"1",exclusive:"true",auth:"true",countExpected:1,authExpected:true,code:null},
    ];
    for(const c of cases){
      const path=join(tmp,c.name+".json");
      const p=spawnSync("python3",["-",path],{input:producer,encoding:"utf8",
        env:{...process.env,F1_TARGET_COUNT:c.count,F1_CHATGPT_EXCLUSIVE:c.exclusive,
          F1_CHATGPT_AUTH_IDLE:c.auth,F1_EXTENSION_MANIFEST_VERSION:"3"}});
      assert.equal(p.status,0,c.name+": "+(p.stderr||"no stderr"));
      const produced=JSON.parse(readFileSync(path,"utf8"));
      assert.equal(produced.chatgpt.targetCount,c.countExpected,c.name);
      assert.equal(produced.chatgpt.authenticatedAndIdle,c.authExpected,c.name);
      const e=fixture();
      e.chatgpt=produced.chatgpt;
      const report=evaluateF1DesktopReadiness(e);
      if(c.code)assert.ok(report.blocker_codes.includes(c.code),c.name);
      else assert.equal(report.real_chrome_status,"REAL_CHROME_READY");
      if(c.authExpected===null)assert.equal(report.chatgpt.authentication_evidence_source,"NOT_EVALUATED",c.name);
      if(c.countExpected!==1)assert.equal(report.chatgpt.target_exclusivity_attested,null,c.name);
      assert.equal(report.authority.message_send_authority,"NONE");
    }
  } finally {
    rmSync(tmp,{recursive:true,force:true});
  }
});

test("owner ChatGPT observations run before native-host policy and cannot bypass it", () => {
  const shell=readFileSync(new URL("../../scripts/forge-f1-desktop-readiness.sh",import.meta.url),"utf8");
  const target= shell.indexOf('prompt_exact "THIS_IS_THE_ONLY_F1_EXPERIMENT_PROFILE"');
  const auth= shell.indexOf('prompt_exact "CHATGPT_AUTHENTICATED_AND_IDLE"');
  const install= shell.indexOf('bash "$ROOT_DIR/scripts/prepare-chrome-native-host.sh" install');
  assert.ok(target > 0 && auth > target && install > auth,
    "owner target checks must occur before native-host install");
  const evidence=fixture();
  evidence.nativeHost.status="MISSING";
  evidence.nativeHost.policyVerified=false;
  evidence.operatorBlocker="NATIVE_HOST_INSTALL_FAILED_OR_OWNER_POLICY_MISSING";
  const r=evaluateF1DesktopReadiness(evidence);
  assert.equal(r.source_status,"SOURCE_SMOKE_PASS");
  assert.equal(r.real_chrome_status,"BLOCKED");
  assert.ok(r.blocker_codes.includes("NATIVE_HOST_OWNER_POLICY_NOT_VERIFIED"));
  assert.ok(r.blocker_codes.includes("NATIVE_HOST_INSTALL_FAILED_OR_OWNER_POLICY_MISSING"));
  assert.ok(!r.blocker_codes.some(code=>code.startsWith("CHATGPT_")));
  assert.equal(r.chatgpt.target_count_source,"OWNER_VISUAL_ATTESTATION");
  assert.equal(r.chatgpt.authenticated_and_idle,true);
  assert.equal(r.authority.dispatch_authority,"NONE");
  assert.equal(r.authority.message_send_authority,"NONE");
});
