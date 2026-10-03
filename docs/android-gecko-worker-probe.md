# Android Gecko Worker probe

## Intent

Prove inside **BKE Worker** that a phone can host the ChatGPT browser worker without Playwright/CDP or Android Accessibility.

BKE DNA Logger is reference architecture only. This implementation lives entirely in `jan2xo/bke-worker`.

## Target shape

```text
Android foreground service
  -> application-owned GeckoRuntime
  -> service-owned GeckoSession
  -> BKE Worker Gecko WebExtension
  -> ChatGPT DOM probe
  -> Gecko native messaging
  -> READY / BUSY notification state

Activity
  -> attaches GeckoView to the service-owned session for human login/use
  -> detaches without closing the session when backgrounded
```

## First proof boundary

This PR is probe-only.

Required:
- service-owned GeckoSession survives Activity detach;
- human-authenticated ChatGPT can be viewed through the same session;
- Worker extension reports bounded composer/busy state;
- notification reflects STARTING / READY / BUSY / NO_COMPOSER / FAILED;
- idle Worker mode uses no permanent wake lock;
- exact-head Android build succeeds;
- physical-device background and screen-off proof before merge.

Out of scope:
- GitHub webhook ingestion;
- VPS/WSS/FCM/MQTT transport;
- prompt dispatch;
- Send-button automation;
- response/message scraping;
- cookies/auth-token export;
- OAuth/MFA/CAPTCHA automation;
- production deployment;
- declaring Android canonical before certification.
