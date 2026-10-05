#!/usr/bin/env python3
from pathlib import Path

root = Path(__file__).resolve().parents[1]
relay = root / "cloudflare-relay"
protocol = (relay / "src/protocol.js").read_text(encoding="utf-8")
runtime = (relay / "src/index.js").read_text(encoding="utf-8")
wrangler = (relay / "wrangler.toml").read_text(encoding="utf-8")
readme = (relay / "README.md").read_text(encoding="utf-8")
webhook_configurator = (
    relay / "scripts/configure-github-webhook.sh"
).read_text(encoding="utf-8")
preproduction_creator = (
    relay / "scripts/create-preproduction-worker.sh"
).read_text(encoding="utf-8")
android = (
    root
    / "android-gecko/app/src/main/kotlin/com/bke/worker/gecko/RelayProtocol.kt"
).read_text(encoding="utf-8")

for token in (
    'CONTROL_REPOSITORY = "jan2xo/bke-worker"',
    'CONTROL_REPOSITORIES = new Set([',
    '"jan2xo/bke-demo-app"',
    'ASSIGNMENT_LABEL_PREFIX = "bke-worker:"',
    'verifyGitHubSignature',
    '"opened", "reopened", "labeled", "synchronize"',
    'type: "wake"',
    'repo: repository',
    'deriveRelayToken',
    'relayBearerMatches',
    'RELAY_TOKEN_CONTEXT + workerId',
    'validateRegister',
    'validateAck',
):
    assert token in protocol, token

wake_keys = (
    "protocol",
    "type",
    "worker_id",
    "repo",
    "pr_number",
    "expected_head_sha",
    "reason",
    "delivery_id",
)
for key in wake_keys:
    assert f'"{key}"' in protocol, key
    assert f'"{key}"' in android, key

for token in (
    'import { DurableObject } from "cloudflare:workers"',
    'export class WorkerSession extends DurableObject',
    'this.ctx.storage',
    'SESSION_OBJECT_GENERATION = "v2"',
    'workerSessionObjectId(env, routing.workerId)',
    'workerSessionObjectId(env, workerId)',
    'new WebSocketPair()',
    'this.ctx.acceptWebSocket(server)',
    'server.serializeAttachment(',
    'other.close(4001, "replaced by newer session")',
    'RECENT_DELIVERY_LIMIT = 64',
    'ACTIVE_CONNECTION_KEY = "active_connection_id"',
    'connectionId = crypto.randomUUID()',
    'attachment.connectionId !== activeConnectionId',
    'contentLength > MAX_WEBHOOK_BYTES',
    'active?.phase === "queued"',
    'state: "coalesced_queued"',
    'phase: "queued"',
    'phase: "sent"',
    'ack.state === "deferred"',
    'ack.state === "accepted"',
    'ack.state === "rejected"',
    'ack.state === "completed"',
    'BKE_WORKER_GITHUB_WEBHOOK_SECRET',
    'BKE_WORKER_RELAY_TOKEN_KEY',
):
    assert token in runtime, token

for forbidden in (
    'json.optString("prompt")',
    '"prompt":',
    '"javascript":',
    '"command":',
    "eval(",
):
    assert forbidden not in protocol + runtime, forbidden

for token in (
    'name = "WORKER_SESSIONS"',
    'class_name = "WorkerSession"',
    'workers_dev = false',
    'preview_urls = false',
    '[exports.WorkerSession]',
    'type = "durable-object"',
    'storage = "sqlite"',
    '[secrets]',
    '[env.preproduction]',
    '[env.preproduction.secrets]',
    '[env.production]',
    '[env.production.secrets]',
):
    assert token in wrangler, token

for forbidden in (
    "BKE_WORKER_GITHUB_WEBHOOK_SECRET =",
    "BKE_WORKER_RELAY_TOKEN_KEY =",
    "route =",
    "routes =",
    "[[migrations]]",
    "new_classes",
):
    assert forbidden not in wrangler, forbidden

for token in (
    "GitHub remains the source of task ownership",
    "transport/routing/liveness only",
    "Production deployment, DNS cutover, and GitHub webhook mutation remain locked",
):
    assert token in readme, token

for token in (
    'GITHUB WEBHOOK PLAN — NO MUTATION',
    'if [[ "$APPLY" != "true" ]]',
    '"events": ["pull_request"]',
    '"insecure_ssl": "0"',
    '--method PATCH',
    '--method POST',
    '--input -',
):
    assert token in webhook_configurator, token

assert 'echo "$SECRET"' not in webhook_configurator

for token in (
    'wrangler whoami',
    'wrangler deploy',
    '--env "$ENVIRONMENT"',
    'BKE_WORKER_GITHUB_WEBHOOK_SECRET',
    'BKE_WORKER_RELAY_TOKEN_KEY',
    'chmod 700 "$SECRET_DIR"',
    'chmod 600 "$SECRET_FILE"',
    'mktemp "$ROOT_DIR/.wrangler-bootstrap.',
    'targets = {"[secrets]", "[env.preproduction.secrets]"}',
    'node scripts/derive-worker-token.mjs "$WORKER_ID"',
    'GitHub webhook mutation was NOT performed.',
    'Production remains LOCKED.',
):
    assert token in preproduction_creator, token

for forbidden in (
    'echo "$BKE_WORKER_GITHUB_WEBHOOK_SECRET"',
    'echo "$BKE_WORKER_RELAY_TOKEN_KEY"',
    'configure-github-webhook.sh --apply',
):
    assert forbidden not in preproduction_creator, forbidden

print("BKE Worker Cloudflare durable relay contract: PASS")
