# F1-03 — exact PR-head Mac PID diagnostic (READ-ONLY, not pairing)

## Why this entrypoint is separate

The existing \`node scripts/forge-f1-owner-policy.mjs\` intentionally
requires **clean, up-to-date main** and can write a private owner policy after
separate human consent. We do NOT change that source provenance gate. F1-03
currently lives in **unmerged DRAFT PR #146**, so that tool is ineligible.

A new operator-only diagnostic enables the **read-only** process-identity
portion of F1-03 physical acceptance at a reviewed exact PR-head commit,
without modifying Chrome or weakening the original main-only policy writer.

**No one should run a draft PR script inside their human-authenticated
Chrome profile before a separate exact-head source/security review and
explicit operator authorization for that physical test.** This script does
not enroll a worker, verify a ChatGPT account/tab, grant nativeMessaging,
install a native host, or create an owner-policy file.

## Operator entrypoint — only after separately authorized physical review

On a physical macOS owner workstation, in the canonical repository checkout
on **only** \`feat/f1-03-owner-policy-provisioning-20261023\` at the exact
reviewed F1-03 PR #146 head:

    /usr/bin/python3 -I scripts/forge_f1_pr_head_mac_readonly.py

Preconditions (checked automatically before and after the probe):

- a non-root human owner, interactive TTY, zero CLI arguments;
- the exact supported GitHub \`jan2xo/bke-worker\` origin, correct PR branch,
  no tracked modifications or untracked files, canonical real checkout;
- reject any tracked index assume-unchanged/skip-worktree flags; independently
  verify the on-disk diagnostic and both Python verification helpers against
  exact HEAD Git blob object IDs before and after the status check;
- reject repository-configured fsmonitor and effectful Git content filters;
  force-disable fsmonitor at highest Git config precedence for every Git
  subprocess so status cannot launch a local monitor before owner consent;
- reject repository-local/worktree/included Git URL rewrite settings and detect
  local Git configuration drift; reject all local replacement refs (loose or packed)
  and legacy Git graft metadata using worktree-aware Git path resolution;
  `GIT_NO_REPLACE_OBJECTS=1` also prevents replacement interpretation by ancestry;
  repeat graph checks before and after ancestry and both source snapshots;
  the HTTPS live-ref lookup runs outside the
  checkout with system/global Git configuration disabled and HTTPS-only transport;
- exact local HEAD equals GitHub's **live** \`refs/pull/146/head\` resolved
  directly via HTTPS Git ls-remote; current remote main must be ancestor
  of this PR head. If the PR or main moves, STOP;
- the owner types the FULL reviewed commit SHA, then exactly
  \`I APPROVE READ ONLY PR 146 MAC IDENTITY CHECK\`.
  The script cannot independently attest a second-actor security review;
  the human must verify the current exact-head review before consenting.

The diagnostic checks the existing private dedicated
\`~/.bke-worker/f1/chrome-profile\` directory **permissions only**, not its
contents. It requires exactly one official installed Google Chrome.app path,
uses the existing pinned Apple/Google publisher code signature validator,
then checks the already-running F1 Chrome process via existing libproc PID
unique-generation, signed running-PID CodeDirectory and disk signed-code
identity. It performs the signer, process and private-directory check again
to reject changed/uncertain state. No Chrome executable is launched—not
even with \`--version\`. No Chrome profile, cookies, local-storage/private
keys, page text, network session, or browser auth is accessed.

The program may query GitHub's public PR/main git refs to verify provenance;
this is read-only repository/network metadata, not a GitHub assignment write.
It does not run a local Git fetch or alter a Git checkout.

### Terminal result semantics

On source and signed PID success:
- \`BKE_F1_PR_HEAD_DIAGNOSTIC=READ_ONLY_PID_PROBE_PASS\`;
- \`BKE_F1_REAL_CHROME_READY=NOT_PROVEN\`;
- \`BKE_F1_NATIVE_HOST_HANDSHAKE=NOT_RUN\`;
- \`BKE_F1_CONTROLLER_AUTH=NOT_ESTABLISHED\`;
- \`BKE_F1_DISPATCH_AUTHORITY=NONE\`.

Any ambiguous repo identity, PR/ref/main mismatch, missing or ambiguous
Chrome, missing/unsupported private macOS process-generation API, mismatch
between live/disk CodeDirectory, invalid signer, changed PID lifetime or
changed checkout yields **\`BLOCKED\`** and a nonzero exit. No fallback.
Only bounded status/commit identifiers appear; do not attach raw Chrome
profile data to a GitHub checkpoint.

### Certification

Linux Guard must execute \`tests/forge_f1_pr_head_mac_readonly_test.py\`
through actual \`unittest\` (no conditional skips or unconditional PASS)
plus all existing F1-03 process/PID/native tests. Tests mock Mac identity
and GitHub ref inputs; they do not touch a real browser or GitHub remote.

Even physical **PID diagnostic PASS** is just one prerequisite. Owner
Chrome extension permission, native-host registration, actual human-granted
signed Chrome↔Node handshake, authenticated typed controller, worker/target
isolation, MV3/reconnect/replay and merge authority are **separate** F1-03
gates. PR #146 remains DRAFT/UNMERGED until all required acceptance
evidence is complete, independently reviewed and explicitly authorized.
