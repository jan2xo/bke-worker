#!/usr/bin/env python3
from pathlib import Path

root = Path(__file__).resolve().parents[1]
relay = root / "cloudflare-relay"
protocol = (relay / "src/protocol.js").read_text(encoding="utf-8")
runtime = (relay / "src/index.js").read_text(encoding="utf-8")
wrangler = (relay / "wrangler.toml").read_text(encoding="utf-8")
readme = (relay / "README.md").read_text(encoding="utf-8")
android = (
    root
    / "android-gecko/app/src/main/kotlin/com/bke/worker/gecko/RelayProtocol.kt"
).read_text(encoding="utf-8")

for token in (
    'CONTROL_REPOSITORY = "jan2xo/bke-worker"',
    'ASSIGNMENT_LABEL_PREFIX = "bke-worker:"',
    'verifyGitHubSignature',
    '"opened", "reopened", "labeled", "synchronize"',
    'type: "wake"',
    'repo: CONTROL_REPOSITORY',
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
    'env.WORKER_SESSIONS.idFromName(routing.workerId)',
    'new WebSocketPair()',
    'this.state.acceptWebSocket(server)',
    'server.serializeAttachment(',
    'other.close(4001, "replaced by newer session")',
    'RECENT_DELIVERY_LIMIT = 64',
    'phase: "queued"',
    'phase: "sent"',
    'ack.state === "deferred"',
    'ack.state === "accepted"',
    'ack.state === "rejected"',
    'ack.state === "completed"',
    'BKE_WORKER_GITHUB_WEBHOOK_SECRET',
    'BKE_WORKER_RELAY_TOKEN',
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
    '[exports.WorkerSession]',
    'type = "durable-object"',
    'storage = "sqlite"',
    '[secrets]',
    '[env.preproduction]',
    '[env.preproduction.secrets]',
):
    assert token in wrangler, token

for forbidden in (
    "BKE_WORKER_GITHUB_WEBHOOK_SECRET =",
    "BKE_WORKER_RELAY_TOKEN =",
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

print("BKE Worker Cloudflare durable relay contract: PASS")
