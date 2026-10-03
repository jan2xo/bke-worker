import { readFileSync } from "node:fs";

const config = readFileSync(new URL("../wrangler.toml", import.meta.url), "utf8");

for (const token of [
  'name = "bke-worker-relay"',
  'main = "src/index.js"',
  'name = "WORKER_SESSIONS"',
  'class_name = "WorkerSession"',
  'new_sqlite_classes = ["WorkerSession"]',
  '[env.preproduction]',
]) {
  if (!config.includes(token)) {
    throw new Error(`wrangler.toml lost required relay contract: ${token}`);
  }
}

for (const forbidden of [
  "BKE_WORKER_GITHUB_WEBHOOK_SECRET =",
  "BKE_WORKER_RELAY_TOKEN =",
  "routes =",
  "route =",
]) {
  if (config.includes(forbidden)) {
    throw new Error(`wrangler.toml contains forbidden production/secret material: ${forbidden}`);
  }
}

console.log("BKE Worker Cloudflare relay config contract: PASS");
