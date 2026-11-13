export const PROTOCOL_VERSION = 1 as const;
export const WORKER_ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,62}$/;

export type BridgeConnectionState =
  | "DISABLED"
  | "UNPAIRED"
  | "READY_FOR_TRANSPORT";

export interface BridgeConfig {
  workerId: string;
  controllerUrl: string;
}

export type ChatPageUiState =
  | "NEW_CHAT_LANDING"
  | "THREAD"
  | "BUSY"
  | "AUTH_REQUIRED"
  | "UNKNOWN";

export interface ChatGptPageStatus {
  protocolVersion: typeof PROTOCOL_VERSION;
  observedAt: string;
  url: string;
  visible: boolean;
  composerAvailable: boolean;
  turnBusy: boolean;
  uiState?: ChatPageUiState;
}

export interface BridgeStatus {
  protocolVersion: typeof PROTOCOL_VERSION;
  workerId: string;
  controllerUrl: string;
  connectionState: BridgeConnectionState;
  chatGpt: ChatGptPageStatus | null;
}

export interface ConfigValidationResult {
  ok: boolean;
  error: string | null;
  value: BridgeConfig | null;
}

export function isValidWorkerId(value: string): boolean {
  return WORKER_ID_PATTERN.test(value.trim());
}

export function isAllowedControllerUrl(value: string): boolean {
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    return true;
  }

  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    return false;
  }

  if (parsed.username || parsed.password || parsed.hash) {
    return false;
  }

  if (parsed.protocol === "wss:") {
    return true;
  }

  if (parsed.protocol !== "ws:") {
    return false;
  }

  return parsed.hostname === "127.0.0.1" || parsed.hostname === "localhost";
}

export function validateConfig(
  workerId: string,
  controllerUrl: string,
): ConfigValidationResult {
  const normalizedWorkerId = workerId.trim();
  const normalizedControllerUrl = controllerUrl.trim();

  if (!isValidWorkerId(normalizedWorkerId)) {
    return {
      ok: false,
      error: "WORKER_ID_INVALID",
      value: null,
    };
  }

  if (!isAllowedControllerUrl(normalizedControllerUrl)) {
    return {
      ok: false,
      error: "CONTROLLER_URL_INVALID",
      value: null,
    };
  }

  return {
    ok: true,
    error: null,
    value: {
      workerId: normalizedWorkerId,
      controllerUrl: normalizedControllerUrl,
    },
  };
}

const VALID_UI_STATES = new Set<ChatPageUiState>([
  "NEW_CHAT_LANDING",
  "THREAD",
  "BUSY",
  "AUTH_REQUIRED",
  "UNKNOWN",
]);

export function conversationIdFromChatGptUrl(rawUrl: string): string | null {
  try {
    const url = new URL(rawUrl);
    if (
      url.origin !== "https://chatgpt.com" ||
      url.username ||
      url.password ||
      url.search ||
      url.hash
    ) {
      return null;
    }
    const match = /^\/c\/([A-Za-z0-9_-]{8,128})$/.exec(url.pathname);
    return match ? (match[1] ?? null) : null;
  } catch {
    return null;
  }
}

export function isChatGptLandingUrl(rawUrl: string): boolean {
  try {
    const url = new URL(rawUrl);
    return (
      url.origin === "https://chatgpt.com" &&
      !url.username &&
      !url.password &&
      !url.search &&
      !url.hash &&
      url.pathname === "/"
    );
  } catch {
    return false;
  }
}

export function isValidChatGptPageStatus(
  value: unknown,
): value is ChatGptPageStatus {
  if (typeof value !== "object" || value === null) {
    return false;
  }

  const candidate = value as Partial<ChatGptPageStatus>;
  if (
    candidate.protocolVersion !== PROTOCOL_VERSION ||
    typeof candidate.observedAt !== "string" ||
    typeof candidate.url !== "string" ||
    typeof candidate.visible !== "boolean" ||
    typeof candidate.composerAvailable !== "boolean" ||
    typeof candidate.turnBusy !== "boolean" ||
    (candidate.uiState !== undefined && !VALID_UI_STATES.has(candidate.uiState))
  ) {
    return false;
  }

  try {
    return new URL(candidate.url).origin === "https://chatgpt.com";
  } catch {
    return false;
  }
}

export function deriveConnectionState(
  config: BridgeConfig,
): BridgeConnectionState {
  if (!config.workerId) {
    return "DISABLED";
  }

  if (!config.controllerUrl) {
    return "UNPAIRED";
  }

  return "READY_FOR_TRANSPORT";
}
