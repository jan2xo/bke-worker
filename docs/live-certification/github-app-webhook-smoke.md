# GitHub App Webhook Live Smoke

This branch exists only to certify the BKE Worker GitHub App webhook cutover.

Expected path:

```text
BKE Worker GitHub App
  -> Cloudflare PREPRODUCTION webhook
  -> worker-scoped Durable Object
  -> android-worker-a
  -> human-authenticated ChatGPT
  -> live GitHub checkpoint
```

The legacy repository webhook is expected to be inactive.

No production action is authorized by this smoke.
