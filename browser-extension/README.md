# BKE Worker Browser Bridge

This directory contains the first Chromium extension foundation for BKE Worker.

It is intentionally **not yet the canonical autonomous browser adapter**. The current canonical runtime remains the .NET + Playwright/CDP path until the extension path is locally certified against a real human-authenticated ChatGPT profile.

## Current capability

The extension currently:

- uses Manifest V3;
- runs only on `https://chatgpt.com/*`;
- observes ChatGPT page liveness, composer availability, visibility, and busy/idle state;
- persists non-secret worker configuration in `chrome.storage.local`;
- keeps transient page observations in `chrome.storage.session`;
- exposes a small popup for worker ID, future controller URL, and manual probe;
- validates controller URLs as `wss://` by default, allowing `ws://` only for loopback development;
- does not read or store ChatGPT message contents.

The extension currently does **not**:

- automate login, OAuth, MFA, CAPTCHA, or security challenges;
- read/export cookies or browser credentials;
- send ChatGPT prompts;
- expose CDP;
- connect to a remote controller;
- accept remote commands;
- execute arbitrary JavaScript supplied by a controller.

Those capabilities require separate bounded intents and certification.

## Build

Node 22+ is expected.

```bash
cd browser-extension
npm install
npm run check
```

`npm run build` emits browser-loadable JavaScript into `dist/`.

## Load into the exact worker profile for local certification

After building, bind the extension path to the worker environment instead of relying on a manual load in whichever Chromium profile happens to be open:

```bash
BKE_WORKER_BROWSER_EXTENSION_PATH=$HOME/bke/bke-worker/browser-extension
```

Then start Chromium with `scripts/start-chatgpt-browser.sh`. The host script validates `manifest.json` plus the built `dist/` artifacts and passes the unpacked extension through Chromium's `--load-extension` flag for that exact worker profile.

For ad-hoc inspection you may still use `chrome://extensions` -> Developer mode -> Load unpacked, but that does not certify the Worker startup/profile binding.

Once loaded, open the extension popup, set a worker ID such as `worker-a`, and press **Probe** against the worker's normal human-authenticated `chatgpt.com` session.

Do not use this extension as a production control surface until the bridge transport and command boundary are separately implemented and certified.
