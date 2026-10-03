import {
  PROTOCOL_VERSION,
  deriveConnectionState,
  isValidChatGptPageStatus,
  validateConfig,
  type BridgeConfig,
  type BridgeStatus,
  type ChatGptPageStatus,
} from "./protocol.js";

const CONFIG_KEY = "bridgeConfig";
const STATUS_KEY = "chatGptStatus";
const STATUS_MESSAGE = "bke.chatgpt.status";
const GET_STATUS_MESSAGE = "bke.status.get";
const GET_CONFIG_MESSAGE = "bke.config.get";
const SET_CONFIG_MESSAGE = "bke.config.set";
const PROBE_MESSAGE = "bke.chatgpt.probe";

const DEFAULT_CONFIG: BridgeConfig = {
  workerId: "",
  controllerUrl: "",
};

async function hardenStorageAccess(): Promise<void> {
  await Promise.all([
    chrome.storage.local.setAccessLevel({
      accessLevel: "TRUSTED_CONTEXTS",
    }),
    chrome.storage.session.setAccessLevel({
      accessLevel: "TRUSTED_CONTEXTS",
    }),
  ]);
}

async function getConfig(): Promise<BridgeConfig> {
  const stored = await chrome.storage.local.get(CONFIG_KEY);
  const value = stored[CONFIG_KEY];

  if (
    typeof value?.workerId === "string" &&
    typeof value?.controllerUrl === "string"
  ) {
    return {
      workerId: value.workerId,
      controllerUrl: value.controllerUrl,
    };
  }

  return DEFAULT_CONFIG;
}

async function getChatGptStatus(): Promise<ChatGptPageStatus | null> {
  const stored = await chrome.storage.session.get(STATUS_KEY);
  return stored[STATUS_KEY] ?? null;
}

async function getBridgeStatus(): Promise<BridgeStatus> {
  const [config, chatGpt] = await Promise.all([
    getConfig(),
    getChatGptStatus(),
  ]);

  return {
    protocolVersion: PROTOCOL_VERSION,
    workerId: config.workerId,
    controllerUrl: config.controllerUrl,
    connectionState: deriveConnectionState(config),
    chatGpt,
  };
}

function isChatGptSender(sender: any): boolean {
  try {
    return new URL(sender?.url ?? "").origin === "https://chatgpt.com";
  } catch {
    return false;
  }
}

async function recordChatGptStatus(
  payload: unknown,
  sender: any,
): Promise<{ ok: boolean; error?: string }> {
  if (!isChatGptSender(sender)) {
    return { ok: false, error: "CHATGPT_SENDER_INVALID" };
  }

  if (!isValidChatGptPageStatus(payload)) {
    return { ok: false, error: "CHATGPT_STATUS_INVALID" };
  }

  const candidate: ChatGptPageStatus = payload;

  await chrome.storage.session.set({
    [STATUS_KEY]: candidate,
  });

  await chrome.action.setBadgeText({
    text: candidate.composerAvailable && !candidate.turnBusy ? "OK" : "…",
  });

  return { ok: true };
}

async function probeChatGptTabs(): Promise<void> {
  const tabs = await chrome.tabs.query({
    url: ["https://chatgpt.com/*"],
  });

  await Promise.all(
    tabs
      .filter((tab: any) => typeof tab.id === "number")
      .map(async (tab: any) => {
        try {
          await chrome.tabs.sendMessage(tab.id, {
            type: PROBE_MESSAGE,
          });
        } catch {
          // A tab may exist before the content script is ready. The content
          // script reports on its own once it loads.
        }
      }),
  );
}

chrome.runtime.onInstalled.addListener(() => {
  void chrome.action.setBadgeText({ text: "" });
});

chrome.runtime.onStartup.addListener(() => {
  void hardenStorageAccess().then(() => probeChatGptTabs());
});

chrome.runtime.onMessage.addListener(
  (
    message: any,
    sender: any,
    sendResponse: (response: unknown) => void,
  ) => {
    const type = message?.type;

    if (type === STATUS_MESSAGE) {
      void recordChatGptStatus(message.payload, sender).then(sendResponse);
      return true;
    }

    if (type === GET_STATUS_MESSAGE) {
      void getBridgeStatus().then(sendResponse);
      return true;
    }

    if (type === GET_CONFIG_MESSAGE) {
      void getConfig().then(sendResponse);
      return true;
    }

    if (type === SET_CONFIG_MESSAGE) {
      const workerId = String(message?.workerId ?? "");
      const controllerUrl = String(message?.controllerUrl ?? "");
      const result = validateConfig(workerId, controllerUrl);

      if (!result.ok || result.value === null) {
        sendResponse(result);
        return false;
      }

      void chrome.storage.local
        .set({ [CONFIG_KEY]: result.value })
        .then(() => sendResponse(result));
      return true;
    }

    if (type === PROBE_MESSAGE) {
      void probeChatGptTabs().then(() => sendResponse({ ok: true }));
      return true;
    }

    return false;
  },
);

void probeChatGptTabs();
