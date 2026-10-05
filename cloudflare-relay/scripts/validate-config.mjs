import { readFileSync } from "node:fs";

const config = readFileSync(new URL("../wrangler.toml", import.meta.url), "utf8");

for (const token of [
  'name = "bke-worker-relay"',
  'main = "src/index.js"',
  'workers_dev = false',
  'preview_urls = false',
  '[exports.WorkerSession]',
  'type = "durable-object"',
  'storage = "sqlite"',
  'name = "WORKER_SESSIONS"',
  'class_name = "WorkerSession"',
  '[secrets]',
  '"BKE_WORKER_GITHUB_WEBHOOK_SECRET"',
  '"BKE_WORKER_RELAY_TOKEN_KEY"',
  '"BKE_WORKER_GITHUB_APP_ID"',
  '"BKE_WORKER_GITHUB_APP_INSTALLATION_ID"',
  '"BKE_WORKER_GITHUB_APP_PRIVATE_KEY_PEM"',
  '[env.preproduction]',
  '[env.preproduction.secrets]',
]) {
  if (!config.includes(token)) {
    throw new Error(`wrangler.toml lost required relay contract: ${token}`);
  }
}

for (const forbidden of [
  "BKE_WORKER_GITHUB_WEBHOOK_SECRET =",
  "BKE_WORKER_RELAY_TOKEN_KEY =",
  "BKE_WORKER_GITHUB_APP_ID =",
  "BKE_WORKER_GITHUB_APP_INSTALLATION_ID =",
  "BKE_WORKER_GITHUB_APP_PRIVATE_KEY_PEM =",
  "routes =",
  "route =",
  "[[migrations]]",
  "new_classes",
]) {
  if (config.includes(forbidden)) {
    throw new Error(`wrangler.toml contains forbidden production/legacy material: ${forbidden}`);
  }
}

console.log("BKE Worker Cloudflare relay config contract: PASS");
