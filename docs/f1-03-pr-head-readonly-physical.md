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

    DO NOT run the draft entrypoint directly: its self-check occurs too late.

Instead, use a separately verified inline, out-of-checkout Python bootstrap.
Its SHA-256 pin must be corroborated with the exact reviewed GitHub source
and FORGE verdict **independently of the local editable repository**. Never
copy a command from an unreviewed working-tree file. Re-pin and re-review if
the diagnostic source changes.

Operator-only after independent exact-head acceptance and local consent:

```bash
/usr/bin/python3 -I -c '
import hashlib, hmac, os, pathlib, stat, sys
PIN = "8e9e3dba509d4e078219c896bfb602e5d1652d5ba587a170f7fd4da3fa3b0663"
def blocked():
    print("BKE_F1_VERIFIED_BOOTSTRAP=BLOCKED reason=ENTRYPOINT_UNTRUSTED", file=sys.stderr)
    raise SystemExit(2)
if len(sys.argv) != 2 or not all(
    hasattr(os, name) for name in ("O_NOFOLLOW", "O_NONBLOCK")
):
    blocked()
candidate = pathlib.Path(sys.argv[1])
try:
    fd = os.open(candidate, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    try:
        info = os.fstat(fd)
        if not stat.S_ISREG(info.st_mode) or info.st_size > 65536:
            blocked()
        with os.fdopen(fd, "rb") as reader:
            fd = -1
            source = reader.read(65537)
    finally:
        if fd >= 0:
            os.close(fd)
except OSError:
    blocked()
if len(source) > 65536 or not hmac.compare_digest(
    hashlib.sha256(source).hexdigest(), PIN
):
    blocked()
# Only execute the same in-memory bytes checked above; never reopen.
sys.argv = [str(candidate)]
exec(compile(source, str(candidate), "exec"), {
    "__name__": "__main__", "__file__": str(candidate), "__package__": None
})
' scripts/forge_f1_pr_head_mac_readonly.py
```

**Entrypoint SHA-256 pin:** `8e9e3dba509d4e078219c896bfb602e5d1652d5ba587a170f7fd4da3fa3b0663`.

The trusted bootstrap uses `O_NOFOLLOW | O_NONBLOCK` (a FIFO cannot wait for
its writer), requires a regular file via descriptor `fstat`, a 64-KiB maximum,
and SHA-256
before even compiling the candidate; then it executes the same, verified
in-memory bytes so the file cannot be swapped between check and execution.
A bad pin, symlink, FIFO, or other nonregular file returns
`BKE_F1_VERIFIED_BOOTSTRAP=BLOCKED reason=ENTRYPOINT_UNTRUSTED` before
any reviewed-SHA/consent prompt, local Git command or Mac probe. The verified
diagnostic retains all current helper hashes, index/config/graph validation,
live GitHub ref check, explicit human consent, and post-probe verification.
Trusted operating system and Python standard library are prerequisites.

Preconditions (checked automatically before and after the probe):

- verified bootstrap separately checks exact candidate bytes before any
  candidate code is parsed or executed; no direct entrypoint execution;
- a non-root human owner, interactive TTY, zero CLI arguments;
- the exact supported GitHub \`jan2xo/bke-worker\` origin, correct PR branch,
  no tracked modifications or untracked files, canonical real checkout;
- enumerate the complete tracked index with a **bounded 256-KiB** allowance
  (the ordinary 4-KiB command-output limit is unchanged for other checks);
  reject an oversized index rather than truncating or skipping entries;
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
plus all existing F1-03 process/PID/native tests. Tests execute the documented inline bootstrap in actual Linux subprocesses
against marker-injected candidate source, positive trusted source, symlink,
and a real FIFO with a hard subprocess timeout (no hang, prompt, or probe).
No real Chrome or GitHub remote is accessed.

Even physical **PID diagnostic PASS** is just one prerequisite. Owner
Chrome extension permission, native-host registration, actual human-granted
signed Chrome↔Node handshake, authenticated typed controller, worker/target
isolation, MV3/reconnect/replay and merge authority are **separate** F1-03
gates. PR #146 remains DRAFT/UNMERGED until all required acceptance
evidence is complete, independently reviewed and explicitly authorized.
