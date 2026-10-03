const STATUS_MESSAGE = "bke.chatgpt.status";
const PROBE_MESSAGE = "bke.chatgpt.probe";
const REPORT_DEBOUNCE_MS = 300;
const PERIODIC_REPORT_MS = 5000;

let reportTimer: number | null = null;
let lastSerialized = "";

function findComposer(): Element | null {
  return (
    document.querySelector('[data-testid="prompt-textarea"]') ??
    document.querySelector('textarea[placeholder*="Message"]') ??
    document.querySelector('[contenteditable="true"][role="textbox"]') ??
    document.querySelector('[contenteditable="true"]')
  );
}

function isTurnBusy(): boolean {
  return Boolean(
    document.querySelector('[data-testid="stop-button"]') ??
      document.querySelector('button[aria-label*="Stop"]'),
  );
}

function snapshot() {
  return {
    protocolVersion: 1,
    observedAt: new Date().toISOString(),
    url: location.href,
    visible: document.visibilityState === "visible",
    composerAvailable: Boolean(findComposer()),
    turnBusy: isTurnBusy(),
  };
}

async function report(force = false): Promise<void> {
  const current = snapshot();
  const stable = JSON.stringify({
    url: current.url,
    visible: current.visible,
    composerAvailable: current.composerAvailable,
    turnBusy: current.turnBusy,
  });

  if (!force && stable === lastSerialized) {
    return;
  }

  lastSerialized = stable;

  try {
    await chrome.runtime.sendMessage({
      type: STATUS_MESSAGE,
      payload: current,
    });
  } catch {
    // Extension reloads can invalidate the runtime while this content script
    // is still alive. A later page reload will install a fresh script.
  }
}

function scheduleReport(): void {
  if (reportTimer !== null) {
    clearTimeout(reportTimer);
  }

  reportTimer = window.setTimeout(() => {
    reportTimer = null;
    void report();
  }, REPORT_DEBOUNCE_MS);
}

const observer = new MutationObserver(scheduleReport);
observer.observe(document.documentElement, {
  childList: true,
  subtree: true,
  attributes: true,
  attributeFilter: ["aria-busy", "disabled", "data-testid"],
});

document.addEventListener("visibilitychange", () => void report(true));
window.addEventListener("focus", () => void report(true));
window.addEventListener("popstate", () => void report(true));

chrome.runtime.onMessage.addListener((message: unknown) => {
  if (
    typeof message === "object" &&
    message !== null &&
    (message as { type?: unknown }).type === PROBE_MESSAGE
  ) {
    void report(true);
  }
});

setInterval(() => void report(), PERIODIC_REPORT_MS);
void report(true);
