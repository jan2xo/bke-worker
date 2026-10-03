(() => {
  "use strict";

  const NATIVE_APP = "bke.worker.gecko";
  const PROTOCOL_VERSION = 1;
  const REPORT_DEBOUNCE_MS = 300;
  const PERIODIC_REPORT_MS = 5000;
  const PORT_RECONNECT_MS = 1000;

  let timer = null;
  let lastStableState = "";
  let nativePort = null;
  let reconnectTimer = null;

  function findComposer() {
    return (
      document.querySelector('[data-testid="prompt-textarea"]') ||
      document.querySelector('textarea[placeholder*="Message"]') ||
      document.querySelector('[contenteditable="true"][role="textbox"]') ||
      document.querySelector('[contenteditable="true"]')
    );
  }

  function findSendButton() {
    return (
      document.querySelector('button[data-testid="send-button"]') ||
      document.querySelector('[data-testid="send-button"]') ||
      document.querySelector('button[aria-label*="Send"]')
    );
  }

  function isTurnBusy() {
    return Boolean(
      document.querySelector('[data-testid="stop-button"]') ||
      document.querySelector('button[aria-label*="Stop"]')
    );
  }

  function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  async function waitForSendButtonReady(timeoutMs = 1500) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const sendButton = findSendButton();
      if (sendButton && !sendButton.disabled) {
        return sendButton;
      }
      await sleep(50);
    }
    return null;
  }

  function postNative(message) {
    try {
      nativePort?.postMessage(message);
    } catch {
      schedulePortReconnect();
    }
  }

  function schedulePortReconnect() {
    nativePort = null;
    if (reconnectTimer !== null) {
      return;
    }
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      connectNativePort();
    }, PORT_RECONNECT_MS);
  }

  function connectNativePort() {
    if (nativePort !== null) {
      return;
    }

    try {
      const port = browser.runtime.connectNative(NATIVE_APP);
      nativePort = port;
      port.onMessage.addListener(handleNativeCommand);
      port.onDisconnect.addListener(() => {
        if (nativePort === port) {
          nativePort = null;
        }
        schedulePortReconnect();
      });
      void report(true);
    } catch {
      schedulePortReconnect();
    }
  }

  function setComposerValue(composer, prompt) {
    composer.focus();

    if (composer instanceof HTMLTextAreaElement) {
      const descriptor = Object.getOwnPropertyDescriptor(
        HTMLTextAreaElement.prototype,
        "value"
      );
      if (!descriptor?.set) {
        return false;
      }
      descriptor.set.call(composer, prompt);
      composer.dispatchEvent(
        new InputEvent("input", {
          bubbles: true,
          inputType: "insertText",
          data: prompt
        })
      );
      return true;
    }

    if (composer instanceof HTMLElement && composer.isContentEditable) {
      composer.replaceChildren(document.createTextNode(prompt));
      composer.dispatchEvent(
        new InputEvent("input", {
          bubbles: true,
          inputType: "insertText",
          data: prompt
        })
      );
      return true;
    }

    return false;
  }

  async function dispatchPrompt(command) {
    const allowedKeys = [
      "type",
      "protocolVersion",
      "deliveryId",
      "prompt"
    ];
    const keys = Object.keys(command).sort();
    if (
      keys.length !== allowedKeys.length ||
      keys.some((key, index) => key !== [...allowedKeys].sort()[index]) ||
      command.type !== "dispatch_prompt" ||
      command.protocolVersion !== PROTOCOL_VERSION ||
      typeof command.deliveryId !== "string" ||
      !/^[A-Za-z0-9._:-]{1,128}$/.test(command.deliveryId) ||
      typeof command.prompt !== "string" ||
      command.prompt.length < 1 ||
      command.prompt.length > 4096
    ) {
      return;
    }

    if (location.origin !== "https://chatgpt.com" || isTurnBusy()) {
      postNative({
        type: "dispatch_result",
        protocolVersion: PROTOCOL_VERSION,
        deliveryId: command.deliveryId,
        accepted: false,
        error: "CHATGPT_NOT_READY"
      });
      return;
    }

    const composer = findComposer();
    if (!composer) {
      postNative({
        type: "dispatch_result",
        protocolVersion: PROTOCOL_VERSION,
        deliveryId: command.deliveryId,
        accepted: false,
        error: "COMPOSER_UNAVAILABLE"
      });
      return;
    }

    if (!setComposerValue(composer, command.prompt)) {
      postNative({
        type: "dispatch_result",
        protocolVersion: PROTOCOL_VERSION,
        deliveryId: command.deliveryId,
        accepted: false,
        error: "COMPOSER_WRITE_FAILED"
      });
      return;
    }

    const sendButton = await waitForSendButtonReady();
    if (!sendButton || isTurnBusy()) {
      postNative({
        type: "dispatch_result",
        protocolVersion: PROTOCOL_VERSION,
        deliveryId: command.deliveryId,
        accepted: false,
        error: "SEND_UNAVAILABLE_AFTER_WRITE"
      });
      return;
    }

    sendButton.click();
    postNative({
      type: "dispatch_result",
      protocolVersion: PROTOCOL_VERSION,
      deliveryId: command.deliveryId,
      accepted: true,
      error: null
    });
    setTimeout(() => void report(true), 50);
  }

  function handleNativeCommand(message) {
    if (typeof message !== "object" || message === null) {
      return;
    }
    void dispatchPrompt(message);
  }

  async function report(force = false) {
    const payload = {
      type: "worker_status",
      protocolVersion: PROTOCOL_VERSION,
      observedAt: new Date().toISOString(),
      pageUrl: location.href,
      composerAvailable: Boolean(findComposer()),
      turnBusy: isTurnBusy()
    };

    const stableState = JSON.stringify({
      pageUrl: payload.pageUrl,
      composerAvailable: payload.composerAvailable,
      turnBusy: payload.turnBusy
    });

    if (!force && stableState === lastStableState) {
      return;
    }
    lastStableState = stableState;
    postNative(payload);
  }

  function scheduleReport() {
    if (timer !== null) {
      clearTimeout(timer);
    }
    timer = setTimeout(() => {
      timer = null;
      void report();
    }, REPORT_DEBOUNCE_MS);
  }

  const observer = new MutationObserver(scheduleReport);
  observer.observe(document.documentElement, {
    childList: true,
    subtree: true,
    attributes: true,
    attributeFilter: ["aria-busy", "disabled", "data-testid"]
  });

  window.addEventListener("focus", () => void report(true));
  window.addEventListener("popstate", () => void report(true));
  document.addEventListener("visibilitychange", () => void report(true));

  setInterval(() => void report(), PERIODIC_REPORT_MS);
  connectNativePort();
})();
