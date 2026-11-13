const STATUS_MESSAGE = "bke.chatgpt.status";
const PROBE_MESSAGE = "bke.chatgpt.probe";
const DISPATCH_MESSAGE = "bke.chatgpt.dispatch";
const REPORT_DEBOUNCE_MS = 300;
const PERIODIC_REPORT_MS = 5000;

let reportTimer: number | null = null;
let lastSerialized = "";
let dispatchInFlight = false;
const consumedAttemptIds = new Set<string>();

function findComposer(): Element | null {
  return (
    document.querySelector('[data-testid="prompt-textarea"]') ??
    document.querySelector('textarea[placeholder*="Message"]') ??
    document.querySelector('[contenteditable="true"][role="textbox"]') ??
    document.querySelector('[contenteditable="true"]')
  );
}

function findSendButton(): HTMLButtonElement | null {
  const el =
    document.querySelector('[data-testid="send-button"]') ??
    document.querySelector('button[data-testid*="send"]') ??
    document.querySelector('button[aria-label*="Send"]') ??
    document.querySelector('form button[type="submit"]');
  return el instanceof HTMLButtonElement ? el : null;
}

function isTurnBusy(): boolean {
  return Boolean(
    document.querySelector('[data-testid="stop-button"]') ??
      document.querySelector('button[aria-label*="Stop"]'),
  );
}

function isAuthRequired(): boolean {
  try {
    const parsed = new URL(location.href);
    if (
      parsed.pathname.startsWith("/auth") ||
      parsed.pathname.startsWith("/login") ||
      parsed.pathname.startsWith("/signup")
    ) {
      return true;
    }
  } catch {
    return true;
  }
  return Boolean(
    document.querySelector('[data-testid="login-button"]') ??
      document.querySelector('[data-testid="signup-button"]') ??
      document.querySelector('form[action*="login"]') ??
      document.querySelector("#challenge-form"),
  );
}

function classifyUiState(
  composerAvailable: boolean,
  turnBusy: boolean,
): "NEW_CHAT_LANDING" | "THREAD" | "BUSY" | "AUTH_REQUIRED" | "UNKNOWN" {
  if (isAuthRequired()) {
    return "AUTH_REQUIRED";
  }
  if (turnBusy) {
    return "BUSY";
  }
  if (!composerAvailable) {
    return "UNKNOWN";
  }
  try {
    const parsed = new URL(location.href);
    if (parsed.origin !== "https://chatgpt.com") {
      return "UNKNOWN";
    }
    if (parsed.pathname === "/" && !parsed.search && !parsed.hash) {
      return "NEW_CHAT_LANDING";
    }
    if (/^\/c\/[A-Za-z0-9_-]{8,128}$/.test(parsed.pathname) && !parsed.search && !parsed.hash) {
      return "THREAD";
    }
    return "UNKNOWN";
  } catch {
    return "UNKNOWN";
  }
}

function extractConversationId(urlString: string): string | null {
  try {
    const parsed = new URL(urlString);
    if (parsed.origin !== "https://chatgpt.com" || parsed.search || parsed.hash) {
      return null;
    }
    const m = /^\/c\/([A-Za-z0-9_-]{8,128})$/.exec(parsed.pathname);
    return m ? (m[1] ?? null) : null;
  } catch {
    return null;
  }
}

function snapshot() {
  const composerAvailable = Boolean(findComposer());
  const turnBusy = isTurnBusy();
  const uiState = classifyUiState(composerAvailable, turnBusy);
  return {
    protocolVersion: 1,
    observedAt: new Date().toISOString(),
    url: location.href,
    visible: document.visibilityState === "visible",
    composerAvailable,
    turnBusy,
    uiState,
  };
}

async function report(force = false): Promise<void> {
  const current = snapshot();
  const stable = JSON.stringify({
    url: current.url,
    visible: current.visible,
    composerAvailable: current.composerAvailable,
    turnBusy: current.turnBusy,
    uiState: current.uiState,
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

function setComposerPrompt(composer: Element, prompt: string): boolean {
  if (composer instanceof HTMLTextAreaElement) {
    const descriptor = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value");
    if (descriptor?.set) {
      descriptor.set.call(composer, prompt);
    } else {
      composer.value = prompt;
    }
    composer.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText", data: prompt }));
    composer.dispatchEvent(new Event("change", { bubbles: true }));
    return true;
  }
  if (composer instanceof HTMLElement && composer.getAttribute("contenteditable") === "true") {
    composer.replaceChildren(document.createTextNode(prompt));
    composer.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText", data: prompt }));
    return true;
  }
  return false;
}

function isSendButtonReady(btn: HTMLButtonElement | null): btn is HTMLButtonElement {
  return Boolean(btn && !btn.disabled && btn.getAttribute("aria-disabled") !== "true");
}

async function waitForCondition(check: () => boolean, timeoutMs: number, intervalMs: number): Promise<boolean> {
  const started = Date.now();
  while (Date.now() - started <= timeoutMs) {
    if (check()) return true;
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  return check();
}

interface DispatchCommandPayload {
  type: typeof DISPATCH_MESSAGE;
  mode: "FIRST_MESSAGE" | "CONTINUATION";
  attemptId: string;
  prompt: string;
  expectedBeforeUrl: string;
  expectedConversationId?: string;
}

async function handleDispatch(cmd: DispatchCommandPayload) {
  if (dispatchInFlight) {
    return { ok: false, status: "UNCERTAIN", code: "DISPATCH_ALREADY_IN_FLIGHT" };
  }
  if (
    !cmd ||
    typeof cmd.attemptId !== "string" ||
    !cmd.attemptId ||
    typeof cmd.prompt !== "string" ||
    cmd.prompt.trim().length === 0 ||
    (cmd.mode !== "FIRST_MESSAGE" && cmd.mode !== "CONTINUATION")
  ) {
    return { ok: false, status: "BLOCKED", code: "DISPATCH_PAYLOAD_INVALID" };
  }
  if (consumedAttemptIds.has(cmd.attemptId)) {
    return { ok: false, status: "BLOCKED", code: "DISPATCH_ATTEMPT_ALREADY_CONSUMED" };
  }

  const current = snapshot();
  if (current.uiState === "AUTH_REQUIRED") {
    return { ok: false, status: "BLOCKED", code: "CHATGPT_AUTH_REQUIRED" };
  }
  if (current.turnBusy || current.uiState === "BUSY") {
    return { ok: false, status: "BLOCKED", code: "CHATGPT_TURN_BUSY" };
  }
  if (!current.composerAvailable) {
    return { ok: false, status: "BLOCKED", code: "CHATGPT_COMPOSER_UNAVAILABLE" };
  }
  if (current.url !== cmd.expectedBeforeUrl) {
    return { ok: false, status: "BLOCKED", code: "CHATGPT_BEFORE_URL_MISMATCH" };
  }
  if (cmd.mode === "FIRST_MESSAGE" && current.uiState !== "NEW_CHAT_LANDING") {
    return { ok: false, status: "BLOCKED", code: "FIRST_MESSAGE_REQUIRES_LANDING" };
  }
  if (
    cmd.mode === "CONTINUATION" &&
    (current.uiState !== "THREAD" ||
      !cmd.expectedConversationId ||
      extractConversationId(current.url) !== cmd.expectedConversationId)
  ) {
    return { ok: false, status: "BLOCKED", code: "CONTINUATION_CONVERSATION_MISMATCH" };
  }

  const composer = findComposer();
  if (!composer) {
    return { ok: false, status: "BLOCKED", code: "CHATGPT_COMPOSER_UNAVAILABLE" };
  }

  dispatchInFlight = true;
  consumedAttemptIds.add(cmd.attemptId);

  try {
    const beforeUrl = location.href;
    if (!setComposerPrompt(composer, cmd.prompt)) {
      return { ok: false, status: "BLOCKED", code: "CHATGPT_COMPOSER_WRITE_FAILED" };
    }

    const ready = await waitForCondition(() => isSendButtonReady(findSendButton()), 1500, 50);
    const sendButton = findSendButton();
    if (!ready || !isSendButtonReady(sendButton)) {
      return { ok: false, status: "UNCERTAIN", code: "SEND_BUTTON_NOT_READY" };
    }

    const sendStartedAt = new Date().toISOString();
    // Single-click actuator: invoke click() once and NEVER retry.
    sendButton.click();

    if (cmd.mode === "FIRST_MESSAGE") {
      const transitioned = await waitForCondition(
        () => extractConversationId(location.href) !== null,
        8000,
        100,
      );
      const afterUrl = location.href;
      const conversationId = extractConversationId(afterUrl);
      if (!transitioned || !conversationId) {
        return {
          ok: false,
          status: "UNCERTAIN",
          code: "CONVERSATION_URL_TRANSITION_TIMEOUT",
          beforeUrl,
          afterUrl,
        };
      }
      const confirmedAt = new Date().toISOString();
      void report(true);
      return {
        ok: true,
        status: "SENT",
        code: "FIRST_MESSAGE_SENT",
        beforeUrl,
        afterUrl,
        conversationId,
        sendStartedAt,
        confirmedAt,
      };
    }

    // CONTINUATION: verify URL remains on exact expectedConversationId
    await new Promise((r) => setTimeout(r, 150));
    const afterUrl = location.href;
    const afterId = extractConversationId(afterUrl);
    if (!afterId || afterId !== cmd.expectedConversationId) {
      return {
        ok: false,
        status: "UNCERTAIN",
        code: "CONTINUATION_DRIFTED_TO_OTHER_CONVERSATION",
        beforeUrl,
        afterUrl,
      };
    }
    const confirmedAt = new Date().toISOString();
    void report(true);
    return {
      ok: true,
      status: "SENT",
      code: "CONTINUATION_SENT",
      beforeUrl,
      afterUrl,
      conversationId: afterId,
      sendStartedAt,
      confirmedAt,
    };
  } catch {
    return { ok: false, status: "UNCERTAIN", code: "DISPATCH_DOM_EXCEPTION" };
  } finally {
    dispatchInFlight = false;
  }
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

chrome.runtime.onMessage.addListener((message: unknown, sender: any, sendResponse: (res: unknown) => void) => {
  if (typeof message !== "object" || message === null) {
    return false;
  }
  const type = (message as { type?: unknown }).type;
  if (type === PROBE_MESSAGE) {
    void report(true);
    return false;
  }
  if (type === DISPATCH_MESSAGE) {
    if (sender?.tab || sender?.id !== chrome.runtime.id) {
      sendResponse({ ok: false, status: "BLOCKED", code: "DISPATCH_SENDER_REJECTED" });
      return false;
    }
    void handleDispatch(message as DispatchCommandPayload).then(sendResponse, () =>
      sendResponse({ ok: false, status: "UNCERTAIN", code: "DISPATCH_UNHANDLED_EXCEPTION" }),
    );
    return true;
  }
  return false;
});

setInterval(() => void report(), PERIODIC_REPORT_MS);
void report(true);
