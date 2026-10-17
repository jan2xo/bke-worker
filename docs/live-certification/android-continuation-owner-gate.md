# Single Android worker — live continuation owner gate

Status: **PREPRODUCTION preparation, not a live pass**. Parent: [#83](https://github.com/jan2xo/bke-worker/issues/83), local device matrix [#55](https://github.com/jan2xo/bke-worker/issues/55).

## Scope

This intent provides one operator entrypoint that safely **arms an already prepared, dedicated draft certification PR** only after its identity, contents, GitHub ownership and real human-observed Android readiness are checked. It does **not** manufacture a live 30-minute progress-lease result.

The operator-selected runtime is Android **GeckoView/WebExtension**, not legacy Linux/Playwright. The historical Android GitHub -> Cloudflare relay -> ChatGPT proof in PR #38 does **not** establish today's device state.

## Preparation and entrypoint

1. From current main, create a **fresh independent draft PR** titled exactly `certify: Android single-worker live 30-minute continuation`.
2. That PR's body must contain the exact marker `BKE ANDROID CONTINUATION CERTIFICATION` and the intended acceptance/checklist. It must change **only** `docs/live-certification/android-single-worker-continuation-acceptance.md`. It must be unassigned and must not introduce executable/product changes or production operations.
3. The operator runs one command from the BKE Worker repository:

```bash
bash scripts/certify-android-continuation-preproduction.sh
```

The script reads live GitHub, refuses ambiguous PR/worker state, and verifies exact main. It uses a temporary exact-main worktree if the operator's checkout is not a clean current main, preserving local changes.

4. The human independently verifies the existing device's **BROWSER ATTACHED / CHAT READY / RELAY CONNECTED / correct worker ID** and no duplicate session. There is no automated login, profile migration, APK reinstall, or secret read. A typed human acknowledgement is required.
5. The entrypoint posts a fresh `BKE EXECUTION CHECKPOINT — OWNER_DEVICE_PREFLIGHT` immediately before assignment. This **resets the existing GitHub progress-lease timestamp** so a stale test-PR commit cannot cause an immediate continuation after arming; it is an **owner device-readiness event, not proof of a worker turn**. The first real worker checkpoint must still be independently observed. The entrypoint then adds exactly one `bke-worker:android-worker-a` label, which may cause an authorized GitHub/relay wake. It verifies global ownership afterward and **does not reattempt** an uncertain label action.

If no connected authenticated device is available, **stop**. Do not assign a worker because GitHub says FREE.

## Acceptance (distinct from preparation)

A future live certification PR must show, with exact PR head and GitHub run/ledger evidence:

- PREPRODUCTION relay/GitHub action verified, single assigned worker, safe targeted ChatGPT session;
- first genuine worker execution checkpoint (not merely owner attestation or a GitHub label);
- unresolved checklist item(s) and no meaningful progress for at least 30 minutes of lease time;
- actual scheduled continuation check, exactly one `BKE CONTINUATION CHECKPOINT — RESUME_REQUESTED` generation and bounded relay wake;
- actual **second** ChatGPT worker turn, with fresh GitHub progress evidence, not a replay of a known/uncertain turn;
- no duplicate dispatch, no second worker/PR ownership, no cross-session routing;
- fail-closed behavior on ambiguous delivery, no undocumented checkpoint that silently renews the lease;
- independent review and removal of assignment before a certified/merged conclusion; no silent executor merge authority.

**No PASS** for live continuation until all the required evidence exists. CI can verify the operator script and static contracts, not actual device liveness or a 30-minute end-to-end loop.

## Security/authority

GitHub remains the PR delegation and evidence authority. Cloudflare is relay only. Worker instances do not invent tasks; owner + main brain delegate. No Notion, ChatGPT Work, production, automated OAuth/MFA/CAPTCHA, copied credentials, or cross-device profile migration.

**Certification for this entrypoint preparation PR:** cheap PR Guard and `tests/android_continuation_operator_contract.py` + shell syntax, exact-head review. Runtime `core/relay/android` certification is **not required** because the runtime implementations remain unchanged. The separate live acceptance PR is **not** covered by this certificate.
