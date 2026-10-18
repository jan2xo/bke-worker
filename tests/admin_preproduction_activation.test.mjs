import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, symlinkSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import {
  policyIdentity, noPriorActivation, names, denyAnonymous, isDirectRunner, selectAdminAccessApplication, accessSnapshot,
} from "../scripts/admin_preproduction_activation.mjs";

const app = { domain:"cc.jl-bke.com", type:"self_hosted",
  aud:"0123456789abcdef0123456789abcdef" };
const org = { auth_domain:"project-freedom.cloudflareaccess.com" };
const p = { decision:"allow", include:[{ email:{ email:"admin@example.test" } }],
  require:[], exclude:[] };
test("Admin policy is derived from exact Access application and operator email", () => {
  const result=policyIdentity(app,[p],org);
  assert.deepEqual(result,{ email:"admin@example.test",
    issuer:"https://project-freedom.cloudflareaccess.com",
    aud:app.aud });
});
test("Wildcard, bypass, extra allow identities and changed issuer fail closed", () => {
  const cases = [
    [app, [{ ...p, decision:"bypass" }], org],
    [app, [p,p],org],
    [app, [{ ...p, include:[{everyone:{}}] }],org],
    [app, [{ ...p, include:[{email:{ email:"admin@example.test" }},{email:{email:"x@example.test"}}]}],org],
    [app, [{ ...p, require:[{email_domain:{domain:"other.test"}}] }],org],
    [{...app,domain:"other.example"},[p],org],
    [{...app,aud:"too-short"},[p],org],
    [app,[p],{auth_domain:"other.example"}],
    [app,[{ ...p, include:[{email:{email:"not-an-email"}}] }],org],
  ];
  for(const args of cases)assert.throws(()=>policyIdentity(...args));
});
test("Partial or repeat activation cannot be interpreted as a new clean bootstrap",()=>{
  noPriorActivation(new Map(),new Map());
  for(const x of ["BKE_ADMIN_BROKER_ENABLED","BKE_ADMIN_REPO_CATALOG_ENABLED"]) {
    assert.throws(()=>noPriorActivation(new Map([[x,{}]]),new Map()),
      /ADMIN_ACTIVATION_ALREADY_OR_PARTIALLY_CONFIGURED/);
  }
  for(const x of ["BKE_ADMIN_DISCOVERY_ENABLED","BKE_ADMIN_EMAILS","GITHUB_DISCOVERY_AUTH_MODE"]) {
    assert.throws(()=>noPriorActivation(new Map(),new Map([[x,{}]])),
      /ADMIN_ACTIVATION_ALREADY_OR_PARTIALLY_CONFIGURED/);
  }
});
test("Cloudflare binding inventory reads only names and type, no values",()=>{
  const map=names([{name:"GITHUB_TOKEN",type:"secret_text"},{name:"BKE_PREPRODUCTION",type:"plain_text"}]);
  assert.equal(map.get("GITHUB_TOKEN").type,"secret_text");
  assert.equal(map.has("BKE_ADMIN_DISCOVERY_ENABLED"),false);
});

test("Anonymous probe rejects an origin 403, accepts only actual Access login challenge", async () => {
  const previous = globalThis.fetch;
  try {
    globalThis.fetch = async () => new Response("denied by application", { status: 403 });
    await assert.rejects(() => denyAnonymous("https://cc.jl-bke.com/admin", "https://project-freedom.cloudflareaccess.com"), /ACCESS_ANONYMOUS_NOT_DENIED/);
    globalThis.fetch = async () => Response.redirect(
      "https://project-freedom.cloudflareaccess.com/cdn-cgi/access/login/example", 302);
    await denyAnonymous("https://cc.jl-bke.com/admin", "https://project-freedom.cloudflareaccess.com");
    globalThis.fetch = async () => Response.redirect("https://evil.example/?continue=cloudflareaccess.com", 302);
    await assert.rejects(() => denyAnonymous("https://cc.jl-bke.com/admin", "https://project-freedom.cloudflareaccess.com"), /ACCESS_ANONYMOUS_NOT_DENIED/);
    globalThis.fetch = async () => new Response("public app", { status: 200 });
    await assert.rejects(() => denyAnonymous("https://cc.jl-bke.com/admin", "https://project-freedom.cloudflareaccess.com"), /ACCESS_ANONYMOUS_NOT_DENIED/);
  } finally {
    globalThis.fetch = previous;
  }
});

test("macOS-style symlink path resolves to direct runner without starting activation", () => {
  const root = mkdtempSync(join(tmpdir(), "bke-admin-entry-"));
  try {
    const original = join(root, "entry.mjs");
    const alias = join(root, "linked.mjs");
    writeFileSync(original, "// test fixture");
    symlinkSync(original, alias);
    assert.equal(isDirectRunner(pathToFileURL(original).href, alias), true);
    assert.equal(isDirectRunner(pathToFileURL(original).href, original), true);
    assert.equal(isDirectRunner(pathToFileURL(original).href, join(root, "not-present")), false);
    assert.equal(isDirectRunner(pathToFileURL(original).href, undefined), false);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("Exact Access application selector distinguishes invisibility from ambiguity", () => {
  const entry = { ...app, id: "e19a0551-aaaa-bbbb-cccc-0123456789ab" };
  assert.equal(selectAdminAccessApplication([entry]).id, entry.id);
  assert.throws(() => selectAdminAccessApplication([]), /ACCESS_APPLICATION_NOT_VISIBLE/);
  assert.throws(() => selectAdminAccessApplication([{...entry,domain:"elsewhere.example"}]),
    /ACCESS_APPLICATION_NOT_VISIBLE/);
  assert.throws(() => selectAdminAccessApplication([entry, {...entry, id:"a19a0551-aaaa-bbbb-cccc-0123456789ab"}]),
    /ACCESS_APPLICATION_AMBIGUOUS/);
  assert.throws(() => selectAdminAccessApplication({result:[entry]}), /ACCESS_APPLICATION_RESPONSE_INVALID/);
  assert.throws(() => selectAdminAccessApplication([{...entry,id:"bad-id"}]), /ACCESS_APPLICATION_ID_INVALID/);
});

test("Access snapshot uses the exact domain filter and verifies selected app detail", async () => {
  const entry = { ...app, id:"e19a0551-aaaa-bbbb-cccc-0123456789ab" };
  const original = globalThis.fetch;
  const paths = [];
  let mode = "valid";
  globalThis.fetch = async (url, options) => {
    const parsed = new URL(url);
    paths.push(parsed.pathname + parsed.search);
    assert.equal(options.headers.Authorization, "Bearer fake-cloudflare-token");
    if (parsed.pathname.endsWith("/access/apps")) {
      assert.equal(parsed.searchParams.get("domain"), "cc.jl-bke.com");
      assert.equal(parsed.searchParams.get("exact"), "true");
      assert.equal(parsed.searchParams.get("page"), "1");
      return Response.json({success:true,result:mode === "missing" ? [] : [entry]});
    }
    if (parsed.pathname.endsWith("/access/apps/" + entry.id)) {
      return Response.json({success:true,result:mode === "changed" ? {...entry,aud:"changed"} : entry});
    }
    if (parsed.pathname.endsWith("/access/apps/" + entry.id + "/policies")) {
      return Response.json({success:true,result:[p]});
    }
    if (parsed.pathname.endsWith("/access/organizations")) {
      return Response.json({success:true,result:org});
    }
    throw new Error("unexpected Cloudflare endpoint");
  };
  try {
    const result = await accessSnapshot("fake-cloudflare-token","a".repeat(32));
    assert.equal(result.aud, app.aud);
    assert.equal(result.issuer,"https://project-freedom.cloudflareaccess.com");
    assert.equal(paths.length,4);
    assert(paths[0].includes("/access/apps?domain="));
    mode = "missing";
    await assert.rejects(() => accessSnapshot("fake-cloudflare-token","a".repeat(32)),
      /ACCESS_APPLICATION_NOT_VISIBLE/);
    mode = "changed";
    await assert.rejects(() => accessSnapshot("fake-cloudflare-token","a".repeat(32)),
      /ACCESS_APPLICATION_DETAIL_MISMATCH/);
  } finally {
    globalThis.fetch = original;
  }
});
