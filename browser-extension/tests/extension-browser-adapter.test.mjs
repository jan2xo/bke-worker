import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import vm from "node:vm";
import { ExtensionBrowserAdapter } from "../dist/extension-browser-adapter.js";

const CONTENT_SCRIPT_PATH = fileURLToPath(new URL("../dist/content-script.js", import.meta.url));
const HEAD = "a".repeat(40);
const FENCE_SHA = "b".repeat(40);
const CLAIM_SHA = "c".repeat(40);
const NOW = "2026-10-20T12:00:00.000Z";

test("ExtensionBrowserAdapter binds commit SHAs, tracks submissions, and refuses duplicate attemptId", async () => {
  const sent = [];
  let seqCounter = 10;
  const adapter = new ExtensionBrowserAdapter(
    {
      repository: "jan2xo/bke-worker",
      prNumber: 127,
      headSha: HEAD,
      workerId: "worker-f1",
      targetId: "target-01",
      profileId: "profile-01",
      targetTabId: 42,
      nowMs: () => 1_760_961_600_000,
      nextSeq: () => ++seqCounter,
    },
    {
      async sendCommand(cmd) {
        sent.push(cmd);
        if (cmd.action === "GET_TARGET_STATUS") {
          return {
            ok: true,
            code: "TARGET_OK",
            payload: {
              observedAt: NOW,
              url: "https://chatgpt.com/",
              visible: true,
              composerAvailable: true,
              turnBusy: false,
              uiState: "NEW_CHAT_LANDING",
              tabId: 42,
              targetId: "target-01",
              profileId: "profile-01",
              matchingWritableTargetCount: 1,
              sharedWritableProfile: false,
            },
          };
        }
        if (cmd.action === "DISPATCH_FIRST_MESSAGE") {
          return {
            ok: true,
            code: "FIRST_MESSAGE_SENT",
            payload: {
              beforeUrl: "https://chatgpt.com/",
              afterUrl: "https://chatgpt.com/c/conv_test_1234",
              conversationId: "conv_test_1234",
              sendStartedAt: "2026-10-20T12:00:01.000Z",
              confirmedAt: "2026-10-20T12:00:02.000Z",
            },
          };
        }
        return {
          ok: true,
          code: "CONTINUATION_SENT",
          payload: {
            beforeUrl: "https://chatgpt.com/c/conv_test_1234",
            afterUrl: "https://chatgpt.com/c/conv_test_1234",
            conversationId: "conv_test_1234",
            sendStartedAt: "2026-10-20T12:00:03.000Z",
            confirmedAt: "2026-10-20T12:00:04.000Z",
          },
        };
      },
    },
  );

  const firstPort = adapter.asFirstMessagePort();
  const snap = await firstPort.observe(NOW);
  assert.equal(snap.fresh.current.uiState, "NEW_CHAT_LANDING");
  assert.equal(snap.bootstrap.profileIsolated, true);
  assert.equal(sent[0].seq, 11);

  const sub1 = await firstPort.submitOnce("hello turn 1", {
    attemptId: "attempt-01",
    fenceId: "fence-01",
    claimId: "claim-01",
    targetId: "target-01",
    profileId: "profile-01",
    targetTabId: 42,
    fenceCommitSha: FENCE_SHA,
    sendClaimCommitSha: CLAIM_SHA,
  });
  assert.equal(sub1.status, "SENT");
  assert.equal(sub1.receipt?.fenceCommitSha, FENCE_SHA);
  assert.equal(sub1.receipt?.sendClaimCommitSha, CLAIM_SHA);
  assert.equal(sub1.receipt?.conversationId, "conv_test_1234");
  assert.equal(firstPort.submissionCount, 1);

  // Duplicate submitOnce for same attemptId must fail closed with 0 dispatcher calls
  const callsBeforeDup = sent.length;
  const dup = await firstPort.submitOnce("duplicate", {
    attemptId: "attempt-01",
    fenceId: "fence-01",
    claimId: "claim-01",
    targetId: "target-01",
    profileId: "profile-01",
    targetTabId: 42,
  });
  assert.equal(dup.status, "UNCERTAIN");
  assert.equal(dup.receipt, null);
  assert.equal(sent.length, callsBeforeDup);

  // Continuation port uses exact receipt literal and preserves monotonic seq
  const contPort = adapter.asContinuationPort();
  const sub2 = await contPort.submitContinuationOnce("turn 2", {
    attemptId: "attempt-02",
    fenceId: "fence-02",
    claimId: "claim-02",
    targetId: "target-01",
    profileId: "profile-01",
    targetTabId: 42,
    expectedConversationId: "conv_test_1234",
    expectedTurnNumber: 2,
    fenceCommitSha: FENCE_SHA,
    sendClaimCommitSha: CLAIM_SHA,
  });
  assert.equal(sub2.status, "SENT");
  assert.equal(sub2.receipt?.event, "CONTINUATION_SENT_IN_SAME_CONVERSATION");
  assert.equal(sub2.receipt?.turnNumber, 2);
  assert.equal(sent[sent.length - 1].seq, 13);
});

function loadContentScriptHarness() {
  const scriptSrc = readFileSync(CONTENT_SCRIPT_PATH, "utf8");
  // Compiled classic content script must not contain module import/export statements
  assert.equal(/^\s*(import|export)\b/m.test(scriptSrc), false);

  const page = {
    href: "https://chatgpt.com/",
    visibilityState: "visible",
    hasComposer: true,
    hasStopButton: false,
    hasLoginButton: false,
    sendDisabled: false,
    clickCount: 0,
    nextUrlOnClick: "https://chatgpt.com/c/conv_created_0001",
    writtenChildren: null,
    events: [],
  };

  class FakeTextAreaElement {}
  class FakeHTMLElement {
    constructor(opts = {}) {
      this.attrs = opts.attrs ?? {};
    }
    getAttribute(name) {
      return Object.hasOwn(this.attrs, name) ? this.attrs[name] : null;
    }
    replaceChildren(...nodes) {
      page.writtenChildren = nodes;
    }
    dispatchEvent(evt) {
      page.events.push(evt);
      return true;
    }
  }
  class FakeButtonElement extends FakeHTMLElement {
    get disabled() {
      return page.sendDisabled;
    }
    click() {
      page.clickCount += 1;
      if (page.nextUrlOnClick) {
        page.href = page.nextUrlOnClick;
      }
    }
  }
  const composerEl = new FakeHTMLElement({ attrs: { contenteditable: "true" } });
  const sendBtnEl = new FakeButtonElement();
  const stopBtnEl = {};
  const loginBtnEl = {};

  const sentMessages = [];
  const messageListeners = [];
  const intervals = [];

  const sandbox = {
    URL,
    Date,
    Set,
    JSON,
    Promise,
    Error,
    Object,
    Boolean,
    Number,
    String,
    setTimeout: (fn, ms) => globalThis.setTimeout(fn, Math.min(ms, 20)),
    clearTimeout: globalThis.clearTimeout,
    setInterval: (fn, ms) => {
      const id = globalThis.setInterval(fn, ms);
      id.unref?.();
      intervals.push(id);
      return id;
    },
    clearInterval: globalThis.clearInterval,
    HTMLTextAreaElement: FakeTextAreaElement,
    HTMLElement: FakeHTMLElement,
    HTMLButtonElement: FakeButtonElement,
    InputEvent: class InputEvent {
      constructor(type, init) {
        this.type = type;
        Object.assign(this, init);
      }
    },
    Event: class Event {
      constructor(type, init) {
        this.type = type;
        Object.assign(this, init);
      }
    },
    MutationObserver: class MutationObserver {
      observe() {}
      disconnect() {}
    },
    location: {
      get href() {
        return page.href;
      },
    },
    document: {
      documentElement: {},
      get visibilityState() {
        return page.visibilityState;
      },
      createTextNode: (text) => ({ nodeType: 3, data: text }),
      addEventListener() {},
      querySelector(selector) {
        if (selector === '[data-testid="prompt-textarea"]') return page.hasComposer ? composerEl : null;
        if (selector === '[data-testid="send-button"]') return page.hasComposer ? sendBtnEl : null;
        if (selector === '[data-testid="stop-button"]') return page.hasStopButton ? stopBtnEl : null;
        if (selector === '[data-testid="login-button"]') return page.hasLoginButton ? loginBtnEl : null;
        return null;
      },
    },
    chrome: {
      runtime: {
        id: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        sendMessage: async (msg) => {
          sentMessages.push(msg);
          return undefined;
        },
        onMessage: {
          addListener: (fn) => messageListeners.push(fn),
        },
      },
    },
  };
  sandbox.window = {
    setTimeout: sandbox.setTimeout,
    addEventListener() {},
  };

  vm.runInNewContext(scriptSrc, sandbox, { filename: "dist/content-script.js" });

  const invokeMessage = (msg, sender = { id: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" }) =>
    new Promise((resolve) => {
      let responded = false;
      const keepOpen = messageListeners[0](msg, sender, (res) => {
        responded = true;
        resolve(res);
      });
      if (!keepOpen && !responded) resolve(undefined);
    });

  return {
    page,
    sentMessages,
    invokeMessage,
    cleanup() {
      for (const id of intervals) globalThis.clearInterval(id);
    },
  };
}

test("dist/content-script.js classifies states and executes single-click first message + continuation", async () => {
  const h = loadContentScriptHarness();
  try {
    // Initial snapshot on https://chatgpt.com/
    assert.equal(h.sentMessages.length, 1);
    assert.equal(h.sentMessages[0].payload.uiState, "NEW_CHAT_LANDING");

    // Reject untrusted sender
    const badSender = await h.invokeMessage(
      {
        type: "bke.chatgpt.dispatch",
        mode: "FIRST_MESSAGE",
        attemptId: "att-1",
        prompt: "hi",
        expectedBeforeUrl: "https://chatgpt.com/",
      },
      { id: "other", tab: { id: 1 } },
    );
    assert.equal(badSender.ok, false);
    assert.equal(badSender.code, "DISPATCH_SENDER_REJECTED");
    assert.equal(h.page.clickCount, 0);

    // Reject BUSY / AUTH_REQUIRED before click
    h.page.hasLoginButton = true;
    h.page.hasComposer = false;
    await h.invokeMessage({ type: "bke.chatgpt.probe" });
    assert.equal(h.sentMessages.at(-1).payload.uiState, "AUTH_REQUIRED");
    h.page.hasLoginButton = false;
    h.page.hasComposer = true;
    h.page.hasStopButton = true;
    await h.invokeMessage({ type: "bke.chatgpt.probe" });
    assert.equal(h.sentMessages.at(-1).payload.uiState, "BUSY");
    h.page.hasStopButton = false;

    // Single-click FIRST_MESSAGE
    const first = await h.invokeMessage({
      type: "bke.chatgpt.dispatch",
      mode: "FIRST_MESSAGE",
      attemptId: "att-1",
      prompt: "Run turn 1",
      expectedBeforeUrl: "https://chatgpt.com/",
    });
    assert.equal(first.ok, true);
    assert.equal(first.code, "FIRST_MESSAGE_SENT");
    assert.equal(first.conversationId, "conv_created_0001");
    assert.equal(first.afterUrl, "https://chatgpt.com/c/conv_created_0001");
    assert.equal(h.page.clickCount, 1);
    assert.equal(h.page.writtenChildren[0].data, "Run turn 1");

    // Same attemptId must be blocked without clicking
    const replay = await h.invokeMessage({
      type: "bke.chatgpt.dispatch",
      mode: "FIRST_MESSAGE",
      attemptId: "att-1",
      prompt: "Replay",
      expectedBeforeUrl: "https://chatgpt.com/c/conv_created_0001",
    });
    assert.equal(replay.code, "DISPATCH_ATTEMPT_ALREADY_CONSUMED");
    assert.equal(h.page.clickCount, 1);

    // Continuation on same conversation stays on thread URL
    h.page.nextUrlOnClick = "https://chatgpt.com/c/conv_created_0001";
    const cont = await h.invokeMessage({
      type: "bke.chatgpt.dispatch",
      mode: "CONTINUATION",
      attemptId: "att-2",
      prompt: "Run turn 2",
      expectedBeforeUrl: "https://chatgpt.com/c/conv_created_0001",
      expectedConversationId: "conv_created_0001",
    });
    assert.equal(cont.ok, true);
    assert.equal(cont.code, "CONTINUATION_SENT");
    assert.equal(cont.conversationId, "conv_created_0001");
    assert.equal(h.page.clickCount, 2);

    // Reject accidental landing page for CONTINUATION
    h.page.href = "https://chatgpt.com/";
    const wrongUrl = await h.invokeMessage({
      type: "bke.chatgpt.dispatch",
      mode: "CONTINUATION",
      attemptId: "att-3",
      prompt: "Should refuse",
      expectedBeforeUrl: "https://chatgpt.com/",
      expectedConversationId: "conv_created_0001",
    });
    assert.equal(wrongUrl.ok, false);
    assert.equal(wrongUrl.code, "CONTINUATION_CONVERSATION_MISMATCH");
    assert.equal(h.page.clickCount, 2);
  } finally {
    h.cleanup();
  }
});
