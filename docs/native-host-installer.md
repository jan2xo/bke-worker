# Chrome native-host operator entrypoint (source-only)

Single command:

```bash
bash scripts/prepare-chrome-native-host.sh
```

The default `inspect` mode is read-only. Supported explicit modes are `install`, `verify`, and `rollback`. Automated tests run only against an existing disposable directory supplied through the test hook; no test writes to the actual browser configuration.

Supported platforms are macOS (Chrome user profile) and Linux (Google Chrome user config). Other platforms fail closed. Node.js 22 or newer is required.

The manifest uses Chrome's native messaging schema with host name `com.bke.worker.native_host`, `type: stdio`, an absolute launcher path, and one exactly validated `chrome-extension://[a-p]{32}/` origin. Chrome provides the caller-origin argument; the generated launcher passes the existing absolute policy path as argument one to `entry.mjs`, preserving the two-argument host contract.

The source manifest cannot reveal the locally generated Chrome extension ID, so the operator is prompted for it when not supplied through the explicitly documented input. Before install, an existing owner-pinned policy must be present at `~/.config/bke-worker/native-host/owner-policy.json` or at `BKE_NATIVE_HOST_POLICY_PATH`. The installer validates that policy through `validNativeHostPolicy` in `host.mjs` and never creates worker IDs or trust pins.

Installation is explicit and interactive on real user paths. It refuses conflicting files, symlinks, unsafe ownership/modes, or unknown state. Files are staged, installed without clobbering, and the manifest is exposed last. A transaction record holds hashes for each installed artifact; rollback removes files only when all relevant artifacts still match recorded hashes and safe ownership/modes. Unknown or changed state is preserved for manual review.

This is not server attestation. A Chrome argv origin and local P-256 proof alone are not trusted admission. The script does not launch Chrome, grant `nativeMessaging`, modify the extension manifest/source, enroll a device, or touch production/PREPRODUCTION. The separate WebExtension native client and server-verified host identity/admission path remain prerequisites before end-to-end enrollment.
