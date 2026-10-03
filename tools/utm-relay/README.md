# UTM WSS smoke relay

This harness proves the BKE Worker Android relay path before Cloudflare exists.

It is **preproduction-only** and does not accept GitHub webhooks.

## What it proves

```text
UTM mock relay
  -> TLS/WSS
  -> Android foreground service
  -> bounded wake validation
  -> locally generated CONTINUE FROM PR prompt
  -> Gecko native messaging
  -> ChatGPT
  -> BUSY / READY
  -> ACK back to UTM
```

GitHub/current-main remains execution authority. The relay packet is only wake context.

## 1. Prepare UTM Ubuntu

Clone or pull the current BKE Worker repository on the UTM VM.

```bash
sudo apt-get update
sudo apt-get install -y python3-venv openssl
cd ~/bke-worker
git pull --ff-only
python3 -m venv .venv-utm-relay
. .venv-utm-relay/bin/activate
pip install -r tools/utm-relay/requirements.txt
```

Find the UTM address reachable from the Android emulator:

```bash
hostname -I
```

Use the actual reachable IP below as `<UTM_IP>`.

## 2. Generate short-lived development TLS

```bash
cd ~/bke-worker
bash tools/utm-relay/generate-dev-tls.sh <UTM_IP>
```

Generated material lives under:

```text
.bke-worker-utm-relay/tls/
```

That directory is gitignored.

Only copy/install this certificate on the Android emulator:

```text
.bke-worker-utm-relay/tls/bke-worker-dev-ca.crt
```

Never copy the CA private key or server private key to Android.

## 3. Trust the development CA on the emulator

The debug APK uses Android Network Security Config `debug-overrides` so a user-installed CA may be trusted **only while the app is debuggable**.

Install the CA through Android Settings as a CA certificate. Android may require a screen lock before it permits user CA installation.

Release behavior remains system-CA-only.

## 4. Start the relay

Generate a one-session token in the UTM shell:

```bash
TOKEN="$(python3 -c 'import secrets; print(secrets.token_urlsafe(32))')"
echo "$TOKEN"
```

For the first fail-closed smoke, PR #13 may be used only if it is still open and unassigned. Always re-check its current head first.

Run:

```bash
. .venv-utm-relay/bin/activate
python3 tools/utm-relay/mock_relay.py \
  --cert .bke-worker-utm-relay/tls/server.crt \
  --key .bke-worker-utm-relay/tls/server.key \
  --token "$TOKEN" \
  --worker-id android-worker-a \
  --pr <PR_NUMBER> \
  --head-sha <EXACT_40_CHAR_HEAD_SHA>
```

The relay listens on `0.0.0.0:8787`.

## 5. Configure Android Worker

Use:

```text
Worker ID:
android-worker-a

Relay URL:
wss://<UTM_IP>:8787

Runtime relay token:
<TOKEN printed by UTM>
```

Tap **START / APPLY WORKER**.

## Expected relay output

```text
BKE UTM RELAY READY wss://0.0.0.0:8787
CONNECTED
REGISTER: {...}
WAKE: {...}
ACK: {"protocol":1,...,"state":"accepted"}
ACK: {"protocol":1,...,"state":"completed"}
```

For an unassigned PR, the ChatGPT turn should receive the locally generated continuation prompt, recover live GitHub state, detect missing worker assignment, and fail closed. That is a valid first smoke because it proves the transport without granting engineering authority.

## Security notes

- non-loopback plaintext `ws://` remains rejected by Android;
- mock relay requires a bearer token;
- token is runtime-only in the Android UI/service;
- generated TLS key material is local and ignored by Git;
- no GitHub PAT is placed in the relay;
- relay does not accept arbitrary prompt text, JavaScript, or shell commands;
- this harness is not a production service and must not be internet-exposed.
