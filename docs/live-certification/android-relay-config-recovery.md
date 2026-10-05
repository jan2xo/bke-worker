# Android relay config recovery

## Intent

Preserve the existing PREPRODUCTION Android Worker pairing across ordinary
Android process/service recreation so the foreground Worker can reconnect to the
Cloudflare relay without re-entering the runtime token after every process kill.

This is a transport-liveness dependency of the serial/restart roadmap. It does
not automate ChatGPT authentication.

## Storage boundary

- worker ID and relay URL are stored in app-private SharedPreferences;
- the worker-bound relay bearer token is encrypted before persistence;
- encryption uses an AES-256 key generated inside Android Keystore;
- ciphertext uses AES/GCM with a fresh IV;
- only ciphertext + IV are stored in private preferences;
- the raw token is never logged or committed;
- Android backup remains disabled by the application manifest.

The Keystore key intentionally does **not** require biometric/device-credential
unlock. The relay token is a device transport credential required for autonomous
service recovery. ChatGPT authentication, OAuth, MFA and security challenges
remain human-owned and are not stored by this mechanism.

## Recovery behavior

When the service is recreated:

1. restore and decrypt the last valid relay configuration;
2. restore whether relay runtime was requested;
3. if the config validates and relay was requested, reconnect outbound WSS;
4. Gecko/ChatGPT starts under the existing service lifecycle;
5. any relay wake queued while the device was disconnected can then be delivered.

Invalid/missing/corrupt stored pairing fails closed as UNPAIRED. Applying a new
invalid config does not overwrite a previously valid stored pairing.

## Scope boundary

This wave covers process/service recreation under the existing START_STICKY
foreground-service model.

It does not add BOOT_COMPLETED/device-reboot autostart. Android reboot startup
policy is a separate intent/certification boundary.

Production remains locked.
