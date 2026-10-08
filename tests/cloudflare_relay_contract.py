#!/usr/bin/env python3
from pathlib import Path

root = Path(__file__).resolve().parents[1]
relay = root / "cloudflare-relay"
protocol = (relay / "src/protocol.js").read_text(encoding="utf-8")
runtime = (relay / "src/index.js").read_text(encoding="utf-8")
github_app = (relay / "src/github-app.js").read_text(encoding="utf-8")
wrangler = (relay / "wrangler.toml").read_text(encoding="utf-8")
readme = (relay / "README.md").read_text(encoding="utf-8")
webhook_configurator = (
    relay / "scripts/configure-github-webhook.sh"
).read_text(encoding="utf-8")
preproduction_creator = (
    relay / "scripts/create-preproduction-worker.sh"
).read_text(encoding="utf-8")
github_app_configurator = (
    relay / "scripts/configure-github-app-actuator.sh"
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
    'supersedesStaleHead',
    'state: sent ? "superseded_sent" : "superseded_queued"',
    'superseded_delivery_id',
    'recent.includes(ack.delivery_id)',
    'phase: "queued"',
    'phase: "sent"',
    'ack.state === "deferred"',
    'ack.state === "accepted"',
    'ack.state === "rejected"',
    'ack.state === "completed"',
    'BKE_WORKER_GITHUB_WEBHOOK_SECRET',
    'BKE_WORKER_RELAY_TOKEN_KEY',
    '"/github/app/install-token"',
    "verifyActionsOidcToken",
    "mintInstallationToken",
):

    assert token in runtime, token

for token in (
    'CONTROL_REPOSITORY = "jan2xo/bke-worker"',
    'CONTROL_REPOSITORY_ID = "1354026486"',
    'SERIAL_WORKFLOW_REF =',
    '"jan2xo/bke-worker/.github/workflows/serial-dispatcher.yml@refs/heads/main"',
    'BROKER_AUDIENCE = "bke-worker-github-app-broker"',
    'ACTIONS_OIDC_ISSUER = "https://token.actions.githubusercontent.com"',
    '"https://token.actions.githubusercontent.com/.well-known/jwks"',
    '"RS256"',
    'repository_ids: [Number(CONTROL_REPOSITORY_ID)]',
    'GITHUB_APP_PERMISSION_REQUIRED',
    'validateInstallationPermissions',
    'contents: "write"',
    'issues: "write"',
    'pull_requests: "write"',
    'BKE_WORKER_GITHUB_APP_ID',
    'BKE_WORKER_GITHUB_APP_PRIVATE_KEY_PEM',
    '"https://api.github.com/repos/jan2xo/bke-worker/installation"',
    'GITHUB_APP_INSTALLATION_RESOLUTION_FAILED',
):
    assert token in github_app, token

for forbidden in (
    "administration",
    "organization_",
    "secrets: \"write\"",
):
    assert forbidden not in github_app.lower(), forbidden

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
    '"BKE_WORKER_GITHUB_APP_ID"',
    '"BKE_WORKER_GITHUB_APP_PRIVATE_KEY_PEM"',
):

    assert token in wrangler, token

for forbidden in (
    "BKE_WORKER_GITHUB_WEBHOOK_SECRET =",
    "BKE_WORKER_RELAY_TOKEN_KEY =",
    "BKE_WORKER_GITHUB_APP_ID =",
    "BKE_WORKER_GITHUB_APP_PRIVATE_KEY_PEM =",
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

for token in (
    'BKE WORKER GITHUB APP ACTUATOR — PREPRODUCTION',
    'Metadata: read',
    'Contents: read & write',
    'Issues: read & write',
    'Pull requests: read & write',
    'BKE_WORKER_GITHUB_APP_ID',
    'BKE_WORKER_GITHUB_APP_PRIVATE_KEY_FILE',
    'BKE_WORKER_GITHUB_APP_PRIVATE_KEY_PEM',
    'Installation: resolved by the broker from GitHub',
    'wrangler secret put BKE_WORKER_GITHUB_APP_PRIVATE_KEY_PEM',
    'gh variable set BKE_WORKER_GITHUB_APP_BROKER_URL',
    'Production remains LOCKED.',
):
    assert token in github_app_configurator, token

for forbidden in (
    'echo "$PRIVATE_KEY_FILE"',
    'cat "$PRIVATE_KEY_FILE" | tee',
    'gh secret set',
    'Administration: write',
):
    assert forbidden not in github_app_configurator, forbidden

for forbidden in (
    'echo "$BKE_WORKER_GITHUB_WEBHOOK_SECRET"',
    'echo "$BKE_WORKER_RELAY_TOKEN_KEY"',
    'configure-github-webhook.sh --apply',
):
    assert forbidden not in preproduction_creator, forbidden

print("BKE Worker Cloudflare durable relay contract: PASS")
