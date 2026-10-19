# Verified native-host installation bytes — SOURCE ONLY

Parent [Command Center issue #30](https://github.com/jan2xo/bke-command-center/issues/30). This is the next necessary OS-side prerequisite after merged Worker [PR #109](https://github.com/jan2xo/bke-worker/pull/109), Command Center [PR #57](https://github.com/jan2xo/bke-command-center/pull/57) and the independent owner-controlled installer [Worker PR #108](https://github.com/jan2xo/bke-worker/pull/108).

`browser-extension/native-host/installation-witness.mjs` reads existing filesystem metadata, installed host files and installer transaction receipt **without writing anything**. Trusted host code must supply independently pinned, exact hashes of the six shipped files, expected extension origin, worker ID, and absolute approved manifest and transaction file paths. The installer-generated transaction JSON is not a cryptographic signature; matching its hashes alone is **not trusted authority**. The external hash pins must come from an authorized owner/security review, NOT the same untrusted manifest/transaction or browser input.

The read-only verifier refuses path drift, symlinked files or parent directories, unexpected owners/modes, oversized files, conflicting manifest/schema/origin, changed contents or installer transaction/hash mismatch. Output is a small immutable `INSTALLATION_BYTES_VERIFIED` status with explicit `browser_session_authority: NONE`, `device_admission_authority: NONE`, `dispatch_authority: NONE`. It does not discover the browser's profile, establish the Chrome process identity, attest a private channel, sign a binding, issue a key, grant `nativeMessaging` or connect to Command Center. It does not run automatically on the existing host.

This is not a hardware/OS-backed remote attestation claim. A same-user process with write privileges can replace some unprotected files or share a browser profile. Platform-specific live-process/session verification and human-trusted host key provisioning remain separate gates before PR #109's signer or Command Center #57's verifier may be used for real device admission.

## Certification

Exact-head WebExtension/native Node tests + required cheap PR Guard, adversarial filesystem fixtures, no real user Chrome writes; no Android APK/relay rebuild, Cloudflare deployment, token/secret provisioning or production/PREPRODUCTION enablement.
