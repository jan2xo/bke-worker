# Read-only multi-worker preclaim and session evidence check (SOURCE ONLY)

This intent follows merged Worker PRs #112 (resource and ownership collision audit) and #113 (double-read complete GitHub PR inventory). Parent multi-worker program is tracked in BKE Command Center issue #30.

`scripts/github_multiworker_preclaim.py` composes those two source-certified modules with a separately provided **trusted private session-evidence reader** to assess whether a specified worker/PR pair is consistent *before* any globally serialized atomic claim. The caller must already have owner-authorized complete repository scope and a GitHub App read client, and provide the attested registration reader from a genuine authenticated OS/browser device-session and Command Center installation trust boundary. A boolean or `source` label in a browser, HTTP request, PR body or plain object is NEVER independent evidence of provenance. The reader itself is an external, independently certified prerequisite.

The preflight:
- refuses an unavailable or malformed trusted private reader, stale/expired session evidence, changed registration/session state between reads, and absent session-binding fingerprints;
- checks all workers for duplicate ChatGPT target/profile/bridge/device/session resources and duplicate PR assignment;
- verifies the exact requested open PR/head is **unassigned**, and that the intended worker currently has no active PR;
- outputs only a minimal `PRECLAIM_CONSISTENT_ONLY` witness with `dispatch_authority=NONE`, `wake_authority=NONE`, `assignment_authority=NONE` and `atomicity=NONE`.

It never mutates GitHub, starts a browser, issues credentials, creates a lease, or grants worker activation. A double-read snapshot is **not** atomic; changes can happen immediately after verification. A future separately certified installation-scoped serialized CAS/claim phase with a final exact-head and worker-owner read is mandatory. Do not wire this module into the active single-worker cron, or pass PR #58's INACTIVE registration snapshot as verified live sessions—it lacks the required independently attested `session_binding_sha256`.

Certification: cheap existing PR Guard plus focused Python adversarial contract tests covering positive controlled fixtures, stale/changed sessions, shared resource fingerprints, assigned workers, competing labels, unexpected PR head, partial GitHub inventory and unsupported registration authority. No production/PREPRODUCTION, Cloudflare, Android, WebExtension, login/authentication, or live assignment mutations.
