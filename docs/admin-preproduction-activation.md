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

## Access app visibility recovery

If the operator receives `ACCESS_APPLICATION_NOT_VISIBLE`, **stop**. The Cloudflare API view associated with the locally authenticated Wrangler principal returned no Access app for the exact PREPRODUCTION hostname. This is distinct from `ACCESS_APPLICATION_AMBIGUOUS`, which means more than one exact match. Do not create a duplicate Access application, choose another domain, enter a manual Access audience/ID, use a browser cookie, or skip Access verification.

The operator entrypoint queries `GET /accounts/{account_id}/access/apps?domain=cc.jl-bke.com&exact=true&per_page=100&page=1`, requires **exactly one** domain match, fetches that application's detail by ID, and verifies ID, domain, type and Access application audience before trusting any signed human policy. If the CLI identity cannot see the app, verify its Cloudflare account membership and `Access: Apps and Policies: Read` permission through the official Cloudflare account authentication/settings; no value should be pasted into the script. Keep the activation stopped until the protected app is visible to that principal.

The fail-closed read happens *before any deployment* during preflight. The script does not create or modify an Access application, broaden its policy or print an Admin email or JWT. After credential/scope recovery, retry the same canonical one-command entrypoint from current main; it rechecks that no partial mutation occurred.

## Connected Cloudflare Access bootstrap (preferred)

**Reason:** Wrangler 4.148.0's built-in OAuth scopes do not include the Cloudflare Access Apps & Policies read permission. A Workers deployment credential does not necessarily authorize inspecting Zero Trust apps and policies.

An already-authorized, separately connected Cloudflare administration integration can verify the exact protected hostname **cc.jl-bke.com**, the Access application AUD and issuer, and the single allowed human Admin identity. It can stage four values **directly into encrypted PREPRODUCTION Command Center Worker secret bindings**, with no URLs, IDs, tokens or configuration pasted by the operator:

- **BKE_ADMIN_ACCESS_ISSUER:** verified Cloudflare Access issuer
- **BKE_ADMIN_ACCESS_AUD:** verified application AUD
- **BKE_ADMIN_EMAILS:** single operator allowlisted email
- **BKE_ADMIN_ACCESS_BOOTSTRAP_SOURCE:** encrypted marker identifying the separately authorized connector bootstrap

All FOUR secret bindings must exist and be typed **secret_text**. The policy audit is performed using that separate authorized Cloudflare integration, not silently inherited from the Wrangler login.

The one-command operator entrypoint accepts either its original complete live-Access-read mode or this explicitly configured connected bootstrap. In connected mode it **does not** query Access Apps/Policies through insufficient Wrangler OAuth scope and **never reads, prints or replaces** the pre-staged encrypted values. It verifies the anonymous HTTPS Cloudflare Access challenge from the protected hostname and rechecks the four bindings after source deployment, before enabling the Admin flag last.

**Important trust qualification:** the Wrangler script cannot decrypt those bindings or independently repeat the connector's Access policy audit. The Cloudflare-connected verification must be genuine and current. A redirect challenge alone is not equivalent to a verified allowed-Admin policy. The signed Admin JWT still requires an exact issuer/AUD/allowlisted email, and live human Access acceptance is separately REQUIRED after rollout.

If one or more bindings are absent/wrong type, the script fails closed with **ACCESS_CONNECTED_BOOTSTRAP_PARTIAL**. It will NOT accept guessed manual values, a GitHub comment as proof, or a different Access application. Policy changes require renewed authorized connector verification and secret update. The script refuses repeated or partially enabled Admin deployments.

Production, GitHub App permissions, stored browser profiles, and Android certification remain LOCKED.

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
