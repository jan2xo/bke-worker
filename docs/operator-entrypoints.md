# BKE Worker — Operator entrypoints

## Contract

A BKE Worker PR that requires an owner/operator action must ship or update one
repo-tracked script that is the operator interface for that action.

The normal human instruction is exactly:

```bash
bash scripts/<intent-entrypoint>.sh
```

Do not turn the chat transcript into an installation manual.

## Discovery before prompting

The entrypoint should first discover and reuse everything it safely can:

- current repository and branch;
- remote `main` and exact SHA;
- non-secret GitHub variables and repository state;
- existing Cloudflare/other provider configuration;
- installed CLI tools and authenticated sessions;
- expected PR/Issue/queue state.

A human should not be asked to pre-export an ID, URL, path, or other value that
the script can reliably discover.

A dirty or non-main local checkout should not automatically block an operation
when the script can establish an isolated trusted execution context. Prefer a
temporary clean worktree pinned to exact fetched `origin/main`, run the bounded
operation there, then remove the temporary worktree without touching the user's
current branch or local changes.

On macOS and other systems where logical and physical paths may differ (for
example `/var/...` vs `/private/var/...`), entrypoints must compare
canonical physical paths (for example via `pwd -P`) rather than raw path
strings.

Provider CLIs must also run from the repository-owned configuration root that
defines the target environment. For example, Wrangler commands for the BKE
relay run from `cloudflare-relay/`, where `wrangler.toml` defines
`[env.preproduction]`; they must not rely on the operator's current working
directory.

## Human-only interaction

Prompt only when the missing value or action genuinely belongs to the human
boundary, for example:

- a secret or private-key file that does not already exist in the authorized
  encrypted store;
- an official CLI/browser login;
- OAuth approval, MFA, CAPTCHA, or security challenge;
- an explicit production/security authorization that cannot be inferred.

The script may launch the provider's official interactive login flow. It must
never type credentials, answer MFA, solve CAPTCHA, or bypass a security
challenge.

Secret contents must never be echoed. Prefer asking for a local secret-file path
over asking the operator to paste the secret itself. Persist secrets only into
an explicitly authorized encrypted boundary.

## Fail-closed behavior

An operator entrypoint must stop rather than improvise when it encounters:

- the wrong repository or environment;
- inability to establish a clean trusted execution context from a dirty,
  non-main, stale, or otherwise ambiguous local checkout;
- stale or untrusted code;
- conflicting worker ownership;
- an unexpected queue state;
- a failed deployment/certification check;
- uncertainty about whether a mutating action already happened.

## Completion

Where the intent allows it, the script should complete the whole bounded
operator ceremony:

`discover -> authenticate if needed -> execute -> verify -> durable checkpoint`

The script should print one clear final state such as `PASS`, `BLOCKED`, or
`FAIL-CLOSED`.

Production remains locked unless separately and explicitly authorized.
