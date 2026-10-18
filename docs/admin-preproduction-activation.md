# PREPRODUCTION Admin activation — one command

## Operator outcome

From an already cloned `jan2xo/bke-worker` directory, after this intent is certified and merged:

```bash
bash scripts/activate-admin-preproduction.sh
```

The script discovers **both current GitHub repository main branches**, creates an isolated clean worktree, clones current `jan2xo/bke-command-center` automatically and checks both remote SHAs. It does not touch the operator's local Gradle, Android emulator, GeckoView session or dirty files.

If necessary, it invokes the official GitHub (`gh auth login --web`) or Cloudflare (`wrangler login`) browser login and leaves credential entry/MFA/OAuth/CAPTCHA fully human-controlled.

## Read-only preflight (before any mutation)

1. Obtain current Wrangler credentials in process memory only; discover exactly one Cloudflare account that contains BOTH expected PREPRODUCTION Worker scripts. Never copy tokens into arguments, files, logs or PRs.
2. Discover the **existing** Access app `cc.jl-bke.com`, organization issuer, application audience and policy-authorized Admin email from Cloudflare API. Require a single self-hosted app, a single exact-email allow rule and no bypass/everyone/service-auth policy. Never output the Admin email or JWT.
3. Verify relay secret **names** for GitHub App identity, webhook and WSS; Command Center secret **names** for existing policy verification and GitHub provider token. Never read their values.
4. Refuse a pre-existing or partial activation. Prove anonymous `GET https://cc.jl-bke.com/admin` is blocked by Access before any upload.
5. Re-run the cheap and complete source checks, including Command Center `npm ci`, `npm test`, `npm run check`, Wrangler PREPRODUCTION dry-run, relay `npm run check`. Verify Cloudflare deploy IDs and policy did not drift.
6. Write a sanitized GitHub issue #30 preflight checkpoint.

## Explicitly authorized PREPRODUCTION mutation only

- Deploy `bke-worker-relay-preproduction` from verified current Worker main, verify new deployment.
- Set relay `BKE_ADMIN_BROKER_ENABLED=true` and `BKE_ADMIN_REPO_CATALOG_ENABLED=true` through Wrangler encrypted-secret bindings (never GitHub or local files).
- Deploy `bke-command-center-preproduction` from verified current Command Center main, verify **private named service binding** `BKE_GITHUB_READ_BROKER` targets `CommandCenterReadBroker` on the correct relay.
- Recheck Access policy and anonymous denial. Populate Command Center's Admin Access issuer/AUD/allowlisted email via encrypted Worker secret bindings, then set `GITHUB_DISCOVERY_AUTH_MODE=catalog` and, **last**, `BKE_ADMIN_DISCOVERY_ENABLED=true`. No static PAT fallback in catalog mode.
- Verify Admin variable **names**, service binding and anonymous Access denial again. Write sanitized GitHub checkpoint **OWNER_ACCESS_LOGIN_REQUIRED**.
- Human Admin navigates to `https://cc.jl-bke.com/admin` and authenticates manually; actual authorized repository listing requires **separate human live acceptance proof**. Do not claim success merely because Wrangler deployed successfully.

**Cloudflare warning:** `wrangler secret put` deploys a new Worker version immediately. Each mutation is deliberately checkpointed, and partially configured runtime is a **STOP** condition requiring operator-led recovery. Do not blindly rerun the script in an ambiguous state, and do not rotate existing GitHub App private keys or change installed repositories.

## Hard locks

- No production/default Worker deploy; every Wrangler mutation supplies `--env preproduction` from the exact config root.
- No Cloudflare Access app/policy mutation, GitHub App permission change, new OAuth installation, GitHub release/worker dispatch, Android wake, production DNS or shared browser profile.
- No shell tracing or secrets in argv, committed files, GitHub PR comments or temporary files. Only official encrypted Cloudflare secret bindings receive derived Access identity/config values.
- Fail closed if the wrong repository/current main, uncertain deployment version, changed policy, multiple accounts, missing/duplicated targets, missing protected route, provider API errors, unexpected token format or partial existing activation.
- `OWNER_ACCESS_LOGIN_REQUIRED` is the highest automated result. A real logged-in Admin must validate private RPC and catalog content to complete PREPRODUCTION live acceptance.

Certification for this PR: PR Guard operator contract + Node tests + exact-head review of authorization, scope, recovery and deployment. This is an **operator ceremony**, not a change to relay runtime or Android, so no Android APK or unrelated core/server/ChatGPT CI. Production is always locked.
