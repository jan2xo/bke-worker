# Chrome native-host operator entrypoint (source-only)

Run from any working directory inside a checkout:

```bash
bash scripts/prepare-chrome-native-host.sh
```

Default mode is read-only `inspect`. Optional explicit modes are `install`, `verify`, and `rollback`. CI and the repository test suite never execute registration against the real home directory.

Supported targets: macOS Chrome user profile and Linux Google Chrome user config. Other operating systems fail closed. Node.js 22+ is required.

The installer uses the existing native host executable contract:
`entry.mjs <absolute-policy-path> <Chrome-calling-origin>`.
Chrome supplies the last argument; the generated launcher supplies its absolute policy path first. It does not infer an extension ID from the source manifest; if the origin cannot be safely discovered it requests it interactively. The origin must be a Chrome extension origin with exactly 32 characters in the Chrome ID alphabet.

Before `install`, an owner-pinned policy must already exist at `~/.config/bke-worker/native-host/owner-policy.json`, or a path selected via `BKE_NATIVE_HOST_POLICY_PATH`. The policy is integrity-sensitive and validated by the exact `validNativeHostPolicy` contract in `host.mjs`; the installer never invents a key, resource pin or worker identity.

Install explicitly prompts for confirmation (unless a disposable test root is supplied). It refuses to overwrite any existing manifest, launcher, host source, policy copy, or transaction record. A successful transaction writes a transaction record containing only paths/origin and removes only the exact artifacts it created on rollback; if state changed since install, rollback refuses.

No registration is activated by testing. The installer does not edit the extension manifest, grant `nativeMessaging`, enroll a device, or claim that P-256 possession or argv origin constitutes server attestation. The WebExtension native client and a separately trusted server-side host identity/admission path remain dependencies before a real end-to-end enrollment can be certified.
