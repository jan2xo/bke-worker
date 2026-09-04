# BKE Worker — Cloudflare Remote Access

This document defines the supported remote-control path for BKE Worker.

## Architecture

```text
PHONE / REMOTE OPERATOR
        ↓
https://worker.jl-bke.com
        ↓
Cloudflare edge
        ↓
Cloudflare Tunnel
        ↓
cloudflared on the Worker host
        ↓
http://127.0.0.1:5080
        ↓
BKE Worker operator UI

Chromium CDP
http://127.0.0.1:9222
        ↑
LOOPBACK ONLY — NEVER EXPOSED THROUGH THE TUNNEL
```

The tunnel is host/deployment infrastructure. It is not orchestration authority and it does not change the Notion-checkbox watchdog contract.

## Security boundary

Remote operator authentication is host-owned and stored only in the host environment file:

```text
~/.config/bke-worker/bke-worker.env
```

Required remote values:

```text
BKE_WORKER_CLOUDFLARE_TUNNEL_TOKEN=
BKE_WORKER_REMOTE_USERNAME=
BKE_WORKER_REMOTE_PASSWORD=
```

The real values must never be committed to GitHub. Keep the environment file mode at `600`.

The following remain UI/runtime-owned and must not be moved into `.env`:

- Notion integration secret
- exact ChatGPT `/c/<conversation-id>` URL
- ChatGPT cookies/session material
- Chromium browser profile contents

The Chromium CDP endpoint must remain loopback-only:

```text
BKE_WORKER_BROWSER_CDP_ENDPOINT=http://127.0.0.1:9222
```

## UTM setup

UTM is a fully valid Worker host for remote-control certification. The Mac does not need to proxy the Worker and no inbound router port needs to be opened.

Install `cloudflared` directly inside the UTM Linux VM. On Debian/Ubuntu, use Cloudflare's current Linux package instructions, or install the appropriate `cloudflared` package for the VM architecture. Verify installation with:

```bash
cloudflared --version
```

The Worker itself should already be reachable locally inside UTM on port `5080`.

## Create the tunnel

The supported runtime is a remotely managed named Cloudflare Tunnel. Create a tunnel in the Cloudflare dashboard under **Networking → Tunnels** and configure a published application route:

```text
Hostname:    worker.jl-bke.com
Service URL: http://localhost:5080
```

Copy only the tunnel token (`eyJ...`) from the Cloudflare connector command. Anyone holding this token can run the tunnel, so treat it as a secret.

Populate the host environment file:

```bash
nano ~/.config/bke-worker/bke-worker.env
```

Set:

```text
BKE_WORKER_CLOUDFLARE_TUNNEL_TOKEN=<tunnel-token>
BKE_WORKER_REMOTE_USERNAME=<operator-username>
BKE_WORKER_REMOTE_PASSWORD=<strong-operator-password>
```

Then enforce permissions:

```bash
chmod 600 ~/.config/bke-worker/bke-worker.env
```

Do not paste these values into GitHub issues, commits, CI logs, Notion, or ChatGPT.

## Start

Normal startup remains one command:

```bash
bash scripts/run-worker.sh
```

When `BKE_WORKER_CLOUDFLARE_TUNNEL_TOKEN` is present, the launcher starts `cloudflared` alongside the Worker. The token value is never intentionally printed by the launcher.

If a tunnel token is configured but remote username/password are missing, remote deployment must fail closed rather than expose the operator surface unauthenticated.

After startup, test from a phone using mobile data rather than the same LAN:

```text
https://worker.jl-bke.com
```

Expected result:

```text
Cloudflare HTTPS
→ BKE Worker remote authentication
→ Worker operator UI
```

## Account/login caveat

Remote access to the Worker UI does not itself provide a remote desktop view of Chromium. If the dedicated ChatGPT profile is already authorized, the remote operator can start/reuse that session normally. If ChatGPT requires an interactive login/MFA/CAPTCHA, the operator must temporarily access the graphical session of the Worker host or a separately secured remote-desktop surface.

Do not expose Chromium CDP as a workaround.

## Host progression

The same boundary is intended to survive host migration:

```text
UTM Linux VM
→ Raspberry Pi
→ persistent VPS
```

Only the origin host changes. The public hostname and Worker architecture can remain stable.

## Guardrails

```text
Cloudflare Tunnel = remote transport
remote username/password = operator access boundary
Notion = task/progress authority
Worker = watchdog/dispatcher
ChatGPT = engineering executor
GitHub = code/evidence authority
```

Never make Cloudflare, DNS, or GitHub events the task-advance authority. Exact Notion block completion remains the only advance gate.
