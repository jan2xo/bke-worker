# Android + Cloudflare PREPRODUCTION Live Smoke

This branch exists only as the durable GitHub ledger for the real PREPRODUCTION relay smoke:

```text
GitHub pull_request event
  -> Cloudflare Worker
  -> worker-scoped Durable Object
  -> Android WSS session
  -> human-authenticated ChatGPT
  -> live GitHub checkpoint comment
```

The executable task is intentionally carried in the pull request body so the worker can recover it from live GitHub state.

No file mutation is required for success.

Production remains locked.
