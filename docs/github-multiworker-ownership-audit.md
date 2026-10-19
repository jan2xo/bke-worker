# Multi-worker GitHub ownership + resource collision audit (SOURCE ONLY)

Program: the operator-authorized multi-worker BKE Worker mission. The existing 5-minute serial dispatcher in `scripts/github_serial_dispatcher.py` remains the live **single** `android-worker-a` scheduler; this PR does NOT enable concurrent dispatch, change GitHub App privileges, create worker labels, or wake ChatGPT.

## Problem

The v1 scheduler only checks PRs labeled `bke-worker:android-worker-a` within one repository. Multiple future worker identities require a *global, fail-closed admission precondition* before any multi-worker scheduling or recovery: one open PR per worker across the complete relevant GitHub installation scope; one worker label per open PR; no two registered workers may share a ChatGPT target, writable browser profile, bridge identity or live session binding.

## Narrow implementation

The pure `scripts/github_multiworker_ownership.py` audits a supplied, already-authenticated snapshot. It rejects incomplete or stale GitHub PR enumeration, mismatched repository inventory, duplicate workers across PRs/repositories, multiple/invalid worker assignment labels, malformed PR heads, mismatched or duplicate trusted resource-registration snapshots, and cross-worker resource conflicts.

A caller MUST obtain a trustworthy **complete** repository scope and PR listing from the existing GitHub App installation (including pagination) and separately verify registration/identity/resource provenance through the approved BKE Command Center ceremony. A boolean in a payload or PR body is **not** evidence of independent trust. This pure function cannot verify GitHub or browser truth itself, and its positive result is only `OWNERSHIP_CONSISTENT`, **not** `READY_TO_DISPATCH` or a wake/lease authority. The trusted host must still fail closed on incomplete evidence, race/lease uncertainty and unverified target/profile ownership.

This initial audit never reads task/checklist content, does not establish an alternative queue, and stores no mutable task database. It does not modify or run the existing dispatcher. Intentional activation requires its own certified PR, a real authenticated worker-registration path and globally scoped atomic dispatch/lease enforcement.

## Certification

Only the cheap `PR Guard` path, including the new adversarial Python contract test for multi-worker collisions. No Android APK, Cloudflare relay deployment, Chromium profile, Notion, production, or browser authentication changes.
