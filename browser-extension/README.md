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

## Load unpacked for local certification

After building:

1. Open `chrome://extensions`.
2. Enable **Developer mode**.
3. Choose **Load unpacked**.
4. Select this `browser-extension/` directory.
5. Open the extension popup and set a worker ID such as `worker-a`.
6. Open the worker's normal human-authenticated `chatgpt.com` session and press **Probe**.

Do not use this extension as a production control surface until the bridge transport and command boundary are separately implemented and certified.
