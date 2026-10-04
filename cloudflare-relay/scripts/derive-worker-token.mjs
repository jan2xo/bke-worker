import { deriveRelayToken, isValidWorkerId } from "../src/protocol.js";

const workerId = process.argv[2] || "";
const secretKey = process.env.BKE_WORKER_RELAY_TOKEN_KEY || "";

if (!isValidWorkerId(workerId)) {
  console.error("usage: BKE_WORKER_RELAY_TOKEN_KEY=<master-key> node scripts/derive-worker-token.mjs <worker-id>");
  process.exit(2);
}
if (secretKey.length < 32) {
  console.error("BKE_WORKER_RELAY_TOKEN_KEY must be at least 32 characters.");
  process.exit(2);
}

console.log(await deriveRelayToken(secretKey, workerId));
