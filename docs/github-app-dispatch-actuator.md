# BKE Worker — GitHub App dispatch actuator

## Purpose

Use the existing **BKE Worker GitHub App** as the bounded mutation identity for
the serial GitHub Master Queue dispatcher.

This replaces the repository-wide dependency on allowing the workflow
`GITHUB_TOKEN` to create pull requests.

GitHub remains the durable source of task, ownership, PR, certification, and
merge truth.

Cloudflare is an authentication/token-broker boundary only.

## Proven existing identity

The BKE Worker GitHub App already exists and has been used as the PREPRODUCTION
webhook source. Historical PR #35 is the inbound webhook cutover ledger.

This intent extends that same App with outbound repository mutation authority.
It does not create a second App.

## Trust path

```text
Serial Master Queue Dispatcher
  -> GitHub Actions OIDC token
  -> Cloudflare PREPRODUCTION broker
  -> verify exact repository + workflow@main + event
  -> sign short-lived GitHub App JWT
  -> resolve the App installation for jan2xo/bke-worker from GitHub
  -> mint one-hour installation token
  -> scope token to jan2xo/bke-worker
  -> scope permissions to Contents/Issues/Pull requests write
  -> serial dispatcher
  -> branch / draft PR / labels / issue updates
```

The GitHub Actions built-in token is intentionally reduced to:

```yaml
contents: read
id-token: write
```

It is not the mutation credential.

## GitHub App permissions

Required repository permissions on the existing BKE Worker GitHub App:

- Metadata: read
- Contents: read & write
- Issues: read & write
- Pull requests: read & write

Not required and should remain disabled:

- Administration
- repository/organization secret management
- organization administration
- production-specific privileges

## Cloudflare secret boundary

PREPRODUCTION Worker encrypted secrets:

- `BKE_WORKER_GITHUB_APP_ID`
- `BKE_WORKER_GITHUB_APP_PRIVATE_KEY_PEM`

The App private key must never appear in:

- Git history;
- GitHub Issues/PR comments;
- Actions logs;
- Android state;
- ChatGPT prompts/responses;
- release artifacts.

Only Cloudflare holds the long-lived App private key.

## GitHub Actions OIDC boundary

The broker accepts only a valid GitHub Actions OIDC JWT that proves:

- issuer: `https://token.actions.githubusercontent.com`
- audience: `bke-worker-github-app-broker`
- repository: `jan2xo/bke-worker`
- repository ID: `1354026486`
- workflow ref:
  `jan2xo/bke-worker/.github/workflows/serial-dispatcher.yml@refs/heads/main`
- workflow name: `Serial Master Queue Dispatcher`
- ref: `refs/heads/main`
- event is one of:
  - `issues`
  - `pull_request_target`
  - `workflow_dispatch`

The OIDC signature is verified against GitHub's published Actions OIDC JWKS.

## Installation resolution and token scope

The broker never trusts an operator-supplied installation ID. After signing the GitHub App JWT, it asks GitHub for the installation of that App on the canonical control repository:

`GET /repos/jan2xo/bke-worker/installation`

The returned installation ID and permission grant are used only for the following
installation-token request. Before minting, the broker verifies that the
installation actually grants Contents/Issues/Pull requests write. An
under-granted installation fails closed with the exact missing permission before
the token request.

The broker then asks GitHub for an installation token scoped by the immutable
control repository ID:

```json
{
  "repository_ids": [1354026486],
  "permissions": {
    "contents": "write",
    "issues": "write",
    "pull_requests": "write"
  }
}
```

Using the repository ID avoids relying on a mutable name string while preserving
the one-repository token boundary even if the App installation itself can see
additional repositories.

The installation token is short-lived and is masked immediately by the Actions
workflow before being exported to the following dispatcher step.

The broker never returns the App private key.

## PREPRODUCTION bootstrap

First, the owner updates the existing BKE Worker GitHub App registration with the
required repository permissions and generates/downloads a private key.

Then, from a human-authenticated operator shell:

```bash
cd cloudflare-relay

export BKE_WORKER_GITHUB_APP_ID='<app id>'
export BKE_WORKER_GITHUB_APP_PRIVATE_KEY_FILE='<path to downloaded PEM>'
export BKE_WORKER_GITHUB_APP_BROKER_URL='https://<preproduction-worker>.workers.dev'

bash scripts/configure-github-app-actuator.sh --apply
```

The script:

1. validates human `gh` and Wrangler authentication;
2. stores the App ID/private key in Cloudflare PREPRODUCTION secret bindings;
3. leaves installation identity to GitHub repository lookup at broker runtime;
4. deploys the broker;
5. sets only the non-secret broker origin as repository variable
   `BKE_WORKER_GITHUB_APP_BROKER_URL`.

It does not print the private key.

## One-command operator completion

After the actuator identity is configured, the normal PREPRODUCTION operator
interface is one command from the repository:

```bash
bash scripts/complete-github-app-actuator-preproduction.sh
```

The script synchronizes trusted `main`, reuses existing Cloudflare/GitHub
configuration, asks for input only if a required configuration/authentication
boundary is genuinely missing, deploys PREPRODUCTION, runs the frozen serial
dispatcher proof, verifies `WAITING / NO_RUNNABLE_TASK`, verifies there was no
branch/PR/worker-assignment mutation, and writes the safe proof checkpoint to
Issue #55.

It never asks for an installation ID. The broker resolves that from GitHub.

If the live broker proves that the GitHub App installation is under-granted, the
same operator entrypoint treats that as a human security boundary rather than a
chat/manual-command boundary: it opens the GitHub App settings and installed-app
settings pages, prints the exact required repository permissions (Contents,
Issues, Pull requests = Read and write), waits for the owner to save/approve the
permission update, then resumes the same PREPRODUCTION certification flow.

## Remote proof before local Android certification

With #44/#45/#46 still blocked:

1. manually dispatch **Serial Master Queue Dispatcher**;
2. broker must accept the Actions OIDC identity;
3. App installation token must mint successfully;
4. dispatcher must complete with:

```text
WAITING / NO_RUNNABLE_TASK
```

This proves the GitHub App mutation credential path without opening a PR yet.

## Real PR-creation proof

After Android recovery certification is green and the real serial queue resumes:

1. unblock Task A only;
2. Task A already exists as PR #48, so no new PR is required for A;
3. merge Task A;
4. dispatcher must materialize Task B as a new branch + draft PR using the GitHub
   App token;
5. that Task B creation is the first real **GitHub App opens PR** certification.

No repository-wide `Allow GitHub Actions to create and approve pull requests`
setting is required for this path.

## Future MCP reuse

This broker is deliberately narrow. A future BKE MCP may reuse the same GitHub
App identity and Cloudflare secret boundary, but should expose BKE-native policy
verbs rather than raw unrestricted GitHub requests.

For this intent, do not implement the full MCP.

## Production lock

Production remains locked.

This design does not authorize:

- production deployment;
- production App installation expansion;
- organization-wide administration;
- secret export;
- generic arbitrary GitHub mutation endpoints.
