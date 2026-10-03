# BKE Worker Cloudflare Durable Relay

PREPRODUCTION transport for the proven Android Gecko worker path.

## Authority boundary

Cloudflare is **transport/routing/liveness only**.

GitHub remains the source of task ownership and exact-head truth. The relay never accepts arbitrary prompt text, JavaScript, shell commands, or planning state.

## Public surface

- `POST /webhooks/github` — GitHub webhook ingress.
- `GET /relay/<worker_id>` with `Upgrade: websocket` — Android outbound WSS connection.
- every other path returns 404.

## Required secrets

Set these as Cloudflare Worker secrets. Never commit them:

- `BKE_WORKER_GITHUB_WEBHOOK_SECRET`
- `BKE_WORKER_RELAY_TOKEN`

Variable names are generation-independent.

## Routing

Only `jan2xo/bke-worker` pull-request events are routable.

A routable PR must have exactly one worker assignment label:

`bke-worker:<worker_id>`

The relay routes by that worker ID into one Durable Object instance. The object accepts one registered Android session as authoritative and replaces older sessions.

## Durable delivery semantics

The Durable Object stores bounded delivery dedupe and at most:

- one active wake;
- one newer queued wake for the same PR.

A wake moves through relay-side phases such as `queued`, `sent`, `deferred`, and `accepted`.

Once the wake may have reached Android, disconnect does **not** cause automatic redelivery. This deliberately fails closed because a ChatGPT dispatch could already have happened. Explicit GitHub activity or operator recovery is safer than duplicate prompt delivery.

`completed` and `rejected` ACKs retire the active wake and allow a queued re-evaluation wake to proceed.

## Local checks

```bash
cd cloudflare-relay
npm run check
python3 ../tests/cloudflare_relay_contract.py
```

## Preproduction configuration

When the owner is ready to certify/deploy preproduction:

```bash
cd cloudflare-relay
wrangler secret put BKE_WORKER_GITHUB_WEBHOOK_SECRET --env preproduction
wrangler secret put BKE_WORKER_RELAY_TOKEN --env preproduction
wrangler deploy --env preproduction
```

Then configure the Android relay URL as:

`wss://<preproduction-worker-host>/relay/android-worker-a`

Production deployment, DNS cutover, and GitHub webhook mutation remain locked until explicitly authorized.

## GitHub webhook mutation guard

The repository webhook configurator is deliberately non-mutating by default:

```bash
BKE_WORKER_CLOUDFLARE_WEBHOOK_URL="https://<preproduction-worker-host>/webhooks/github" \
  bash scripts/configure-github-webhook.sh
```

That prints the intended configuration only. After relay certification and explicit owner authorization, add `--apply` and provide `BKE_WORKER_GITHUB_WEBHOOK_SECRET`. The script creates or updates only the exact pull-request webhook and sends the secret to `gh api` through stdin rather than printing it or placing it directly in command arguments.
