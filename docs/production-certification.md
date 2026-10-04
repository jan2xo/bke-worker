# BKE Worker Production Certification

This document defines the production certification boundary for the GitHub → Cloudflare Durable Object → Android → ChatGPT worker path.

PREPRODUCTION live proof is recorded in PR #32. Production certification must not relabel that evidence. Production requires its own relay environment, stable Android release signing/provenance, exact-head certification, and a production live smoke after deployment.

## Production-owned proof

- Cloudflare `production` environment is isolated from PREPRODUCTION.
- Production runtime secrets are distinct from PREPRODUCTION secrets.
- Android release APK is non-debuggable and signed by a durable production signing identity.
- The release artifact records exact source SHA, artifact SHA-256, version, architecture, and signer certificate digest.
- Relay and Android release certification pass on the exact source head.
- Production live smoke proves GitHub webhook → Cloudflare Worker → Durable Object → Android → human-authenticated ChatGPT → GitHub checkpoint.
- PREPRODUCTION webhook is disabled before the production worker is made authoritative for the same worker ID.

## Production lock

Source/readiness work may be merged without deploying production. Production Cloudflare deployment, webhook cutover, release publication, and signing-key cutover remain explicit production actions.
