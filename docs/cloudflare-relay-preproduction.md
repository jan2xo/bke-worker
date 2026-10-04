# BKE Worker — Cloudflare relay PREPRODUCTION activation

This runbook begins **after** PR-level relay certification is green and merged.

It does not authorize production.

## 1. Human Cloudflare authentication

Cloudflare login/API-token setup remains a human security boundary. Do not automate MFA or account security challenges.

Verify Wrangler can see the intended Cloudflare account before changing anything:

```bash
cd cloudflare-relay
npx --yes wrangler@4.147.0 whoami
```

## 2. Generate PREPRODUCTION secrets locally

Generate two independent random values:

```bash
export BKE_WORKER_GITHUB_WEBHOOK_SECRET="$(
  python3 -c 'import secrets; print(secrets.token_urlsafe(48))'
)"

export BKE_WORKER_RELAY_TOKEN_KEY="$(
  python3 -c 'import secrets; print(secrets.token_urlsafe(48))'
)"
```

Do not paste either master secret into Android, GitHub comments, CI logs, or source control.

## 3. Store only encrypted Cloudflare secrets

```bash
printf '%s' "$BKE_WORKER_GITHUB_WEBHOOK_SECRET" \
  | npx --yes wrangler@4.147.0 secret put \
      BKE_WORKER_GITHUB_WEBHOOK_SECRET \
      --env preproduction

printf '%s' "$BKE_WORKER_RELAY_TOKEN_KEY" \
  | npx --yes wrangler@4.147.0 secret put \
      BKE_WORKER_RELAY_TOKEN_KEY \
      --env preproduction
```

## 4. Deploy PREPRODUCTION only

```bash
npx --yes wrangler@4.147.0 deploy --env preproduction
```

The top-level Worker configuration is deliberately non-public. The named PREPRODUCTION environment is the only configuration in this repository that enables a workers.dev endpoint.

Record the exact resulting PREPRODUCTION hostname.

## 5. Derive the Android worker token

For `android-worker-a`:

```bash
BKE_WORKER_RELAY_TOKEN_KEY="$BKE_WORKER_RELAY_TOKEN_KEY" \
  node scripts/derive-worker-token.mjs android-worker-a
```

Paste the resulting derived token into Android's **Runtime relay token** field.

Do **not** paste the master `BKE_WORKER_RELAY_TOKEN_KEY` into Android.

Configure the relay URL as:

```text
wss://<preproduction-worker-host>/relay/android-worker-a
```

The expected resting state is:

```text
BROWSER: ATTACHED
CHAT: READY
RELAY: CONNECTED
WORKER ID: android-worker-a
```

## 6. Prepare the GitHub webhook without mutating GitHub

Set the exact PREPRODUCTION endpoint:

```bash
export BKE_WORKER_CLOUDFLARE_WEBHOOK_URL="https://<preproduction-worker-host>/webhooks/github"
```

Run the configurator without `--apply`:

```bash
BKE_WORKER_CLOUDFLARE_WEBHOOK_URL="$BKE_WORKER_CLOUDFLARE_WEBHOOK_URL" \
  bash scripts/configure-github-webhook.sh
```

This is a dry run and must print:

```text
GITHUB WEBHOOK PLAN — NO MUTATION
```

## 7. Owner-authorized GitHub activation

Only after the relay is certified and the owner authorizes the GitHub mutation:

```bash
BKE_WORKER_CLOUDFLARE_WEBHOOK_URL="$BKE_WORKER_CLOUDFLARE_WEBHOOK_URL" \
BKE_WORKER_GITHUB_WEBHOOK_SECRET="$BKE_WORKER_GITHUB_WEBHOOK_SECRET" \
  bash scripts/configure-github-webhook.sh --apply
```

The webhook subscribes only to `pull_request` events and keeps TLS verification enabled.

## 8. Assignment-label smoke

GitHub remains assignment authority. A PR becomes routable only when it has exactly one label:

```text
bke-worker:<worker_id>
```

For the Android smoke, create the label if the repository does not already have it:

```bash
gh label create "bke-worker:android-worker-a" \
  -R jan2xo/bke-worker \
  --description "Assign PR to BKE Worker android-worker-a" \
  --color 0E8A16
```

Applying that label to a dedicated PREPRODUCTION smoke PR is an **execution-authority action**. Do it only when the PR's intent and expected head are ready for the smoke.

Expected end-to-end path:

```text
GitHub pull_request event
  -> signed Cloudflare webhook
  -> worker label routing
  -> per-worker Durable Object
  -> worker-bound WSS token
  -> Android REGISTER
  -> WAKE
  -> ChatGPT live GitHub truth recovery
  -> ACK accepted
  -> ACK completed
```

## 9. Fail-closed recovery

If a connection is lost after a wake is `sent`, `deferred`, or `accepted`, the relay deliberately does not auto-redeliver it. The ChatGPT dispatch outcome may be ambiguous.

Use a new explicit GitHub event or operator recovery rather than risking a duplicate prompt.

## Production lock

This runbook is PREPRODUCTION-only. It does not authorize:

- production deployment;
- production DNS/custom-domain activation;
- production secrets;
- production webhook cutover;
- bypassing human Cloudflare or ChatGPT authentication;
- weakening exact-head or worker-label checks.
