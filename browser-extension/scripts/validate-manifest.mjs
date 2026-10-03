import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const manifest = JSON.parse(
  await readFile(new URL("../manifest.json", import.meta.url), "utf8"),
);

assert.equal(manifest.manifest_version, 3);
assert.ok(Number(manifest.minimum_chrome_version) >= 116);
assert.deepEqual(manifest.permissions, ["storage"]);
assert.deepEqual(manifest.host_permissions, ["https://chatgpt.com/*"]);
assert.equal(manifest.background?.type, "module");
assert.equal(manifest.background?.service_worker, "dist/service-worker.js");
assert.deepEqual(manifest.content_scripts?.[0]?.matches, ["https://chatgpt.com/*"]);

const serialized = JSON.stringify(manifest);
for (const forbidden of [
  "<all_urls>",
  "cookies",
  "debugger",
  "history",
  "identity",
  "nativeMessaging",
  "webRequest",
]) {
  assert.equal(
    serialized.includes(forbidden),
    false,
    `forbidden permission: ${forbidden}`,
  );
}

console.log("BKE browser extension manifest boundary: PASS");
