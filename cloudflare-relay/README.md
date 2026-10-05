# BKE Worker Cloudflare Durable Relay

PREPRODUCTION transport for the proven Android Gecko worker path.

## Authority boundary

Cloudflare is **transport/routing/liveness only**.

GitHub remains the source of task ownership and exact-head truth. The relay never accepts arbitrary prompt text, JavaScript, shell commands, or planning state.

## Public surface

- `POST /webhooks/github` — GitHub webhook ingress.
- `POST /github/app/install-token` — OIDC-authenticated BKE GitHub App installation-token broker for the trusted serial dispatcher.
- `GET /relay/<worker_id>` with `Upgrade: websocket` — Android outbound WSS connection.
- every other path returns 404.

The installation-token endpoint accepts only the exact GitHub Actions OIDC identity for `jan2xo/bke-worker/.github/workflows/serial-dispatcher.yml@main`; it is not a generic GitHub API proxy.

## Required secrets

Set these as Cloudflare Worker secrets. Never commit them:

- `BKE_WORKER_GITHUB_WEBHOOK_SECRET`
- `BKE_WORKER_RELAY_TOKEN_KEY`
- `BKE_WORKER_GITHUB_APP_ID`
- `BKE_WORKER_GITHUB_APP_INSTALLATION_ID`
- `BKE_WORKER_GITHUB_APP_PRIVATE_KEY_PEM`

Variable names are generation-independent.

`BKE_WORKER_RELAY_TOKEN_KEY` is a master relay key, not the value pasted into Android. Each worker receives a token derived from its own `worker_id`, so one worker cannot authenticate as another worker merely by knowing its own token.

Generate the Android token locally after setting the master key in your shell:

```bash
BKE_WORKER_RELAY_TOKEN_KEY='<same master key configured in Cloudflare>' \
  node scripts/derive-worker-token.mjs android-worker-a
```

Paste only the derived token into Android. Do not copy the master key to Android.

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

## Preproduction creation

After Cloudflare authentication, create the PREPRODUCTION Worker, generate/store its
two master secrets, deploy the Durable Object relay, and print the worker-bound
Android token with one command:

```bash
cd cloudflare-relay
bash scripts/create-preproduction-worker.sh
```

The creator stores master secrets only in `~/.bke-secrets` with mode `0600`,
writes them to Cloudflare through Wrangler secret bindings, and never copies the
relay master key to Android. It also performs only a dry-run GitHub webhook plan;
GitHub mutation remains a separate explicit action.

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

## GitHub App outbound actuator

The existing BKE Worker GitHub App is also the preferred outbound repository mutation identity.

The long-lived private key lives only in Cloudflare PREPRODUCTION encrypted secret bindings. GitHub Actions authenticates to the broker with its OIDC identity and receives a short-lived installation token scoped to `jan2xo/bke-worker` and only Contents/Issues/Pull Requests write.

See `docs/github-app-dispatch-actuator.md`.

The repository-wide Actions setting that allows `GITHUB_TOKEN` to create pull requests is not required when this actuator is active.
