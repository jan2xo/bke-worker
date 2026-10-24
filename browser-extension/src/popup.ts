interface PopupBridgeStatus {
  protocolVersion: number;
  workerId: string;
  controllerUrl: string;
  connectionState: string;
  chatGpt: {
    observedAt: string;
    url: string;
    visible: boolean;
    composerAvailable: boolean;
    turnBusy: boolean;
  } | null;
}

const workerIdInput = document.querySelector<HTMLInputElement>("#worker-id")!;
const controllerUrlInput =
  document.querySelector<HTMLInputElement>("#controller-url")!;
const saveButton = document.querySelector<HTMLButtonElement>("#save")!;
const probeButton = document.querySelector<HTMLButtonElement>("#probe")!;
const initializeIdentityButton = document.querySelector<HTMLButtonElement>("#initialize-identity")!;
const feedback = document.querySelector<HTMLElement>("#feedback")!;
const policyFile = document.querySelector<HTMLInputElement>("#native-policy-file")!;
const verifyNativeButton = document.querySelector<HTMLButtonElement>("#verify-native-local")!;
let localOwnerPolicy: unknown = null;

policyFile.addEventListener("change", async () => {
  localOwnerPolicy = null;
  const files = policyFile.files;
  const selected = files?.[0];
  if (!selected || files?.length !== 1 || selected.size < 8 ||
      selected.size > 4096) {
    feedback.textContent = "Select one owner-reviewed local policy JSON (max 4096 bytes).";
    return;
  }
  try {
    const parsed: unknown = JSON.parse(await selected.text());
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed))
      throw Error("POLICY_NOT_OBJECT");
    localOwnerPolicy = parsed;
    feedback.textContent = "Local policy loaded. Verify its scope before consenting.";
  } catch {
    feedback.textContent = "Owner policy unreadable or invalid.";
  }
});

verifyNativeButton.addEventListener("click", () => {
  if (localOwnerPolicy === null) {
    feedback.textContent = "Select the owner-reviewed local policy first.";
    return;
  }
  verifyNativeButton.disabled = true;
  feedback.textContent = "Requesting optional local nativeMessaging permission…";
  // Permission request happens synchronously inside this DIRECT USER CLICK;
  // it is never made from service-worker startup, a web page, or a task.
  void chrome.permissions.request({permissions:["nativeMessaging"]})
    .then(async (granted: boolean) => {
      if (granted !== true) {
        feedback.textContent = "Native permission declined. No connection attempted.";
        return;
      }
      const result = await chrome.runtime.sendMessage({
        type:"bke.native.local.proof",policy:localOwnerPolicy,
      });
      feedback.textContent = result?.state === "LOCAL_READ_ONLY_PONG" &&
        result?.admission_authority === "NONE" &&
        result?.dispatch_authority === "NONE" &&
        result?.message_send_authority === "NONE" &&
        result?.controller_authentication === "NOT_ESTABLISHED"
        ? "Verified one-shot local native read-only roundtrip. No controller, assignment, or send authority."
        : (result?.code ?? "Native proof blocked or uncertain. No retry was performed.");
    })
    .catch(() => {
      feedback.textContent = "Native permission or local proof unavailable.";
    })
    .finally(() => {
      localOwnerPolicy = null;
      policyFile.value = "";
      verifyNativeButton.disabled = false;
    });
});

const statusEl = document.querySelector<HTMLElement>("#status")!;

function appendStatusLine(label: string, value: string): void {
  const row = document.createElement("div");
  row.className = "status-row";

  const key = document.createElement("span");
  key.textContent = label;

  const data = document.createElement("strong");
  data.textContent = value;

  row.append(key, data);
  statusEl.append(row);
}

async function refresh(): Promise<void> {
  const current = (await chrome.runtime.sendMessage({
    type: "bke.status.get",
  })) as PopupBridgeStatus;

  workerIdInput.value = current.workerId;
  controllerUrlInput.value = current.controllerUrl;

  const chat = current.chatGpt;
  const chatState = chat
    ? chat.composerAvailable
      ? chat.turnBusy
        ? "BUSY"
        : "READY"
      : "NO COMPOSER"
    : "NOT SEEN";

  statusEl.replaceChildren();
  appendStatusLine("Protocol", String(current.protocolVersion));
  const identity = await chrome.runtime.sendMessage({type:"bke.device.identity.status"});
  appendStatusLine("Device identity", identity.state === "PROVISIONED"
    ? "LOCAL KEY READY (UNPAIRED)" : identity.state === "NOT_PROVISIONED"
      ? "NOT CREATED" : "BLOCKED");
  if (identity.state === "PROVISIONED") {
    appendStatusLine("Key SHA-256", identity.public_key_sha256);
  }
  appendStatusLine("Bridge", current.connectionState);
  appendStatusLine("ChatGPT", chatState);
  appendStatusLine("Visible", chat ? String(chat.visible) : "—");
  appendStatusLine(
    "Observed",
    chat ? new Date(chat.observedAt).toLocaleTimeString() : "—",
  );
}

saveButton.addEventListener("click", async () => {
  feedback.textContent = "Saving…";
  const result = await chrome.runtime.sendMessage({
    type: "bke.config.set",
    workerId: workerIdInput.value,
    controllerUrl: controllerUrlInput.value,
  });

  feedback.textContent = result.ok ? "Saved." : result.error;
  await refresh();
});

probeButton.addEventListener("click", async () => {
  feedback.textContent = "Probing ChatGPT tabs…";
  await chrome.runtime.sendMessage({ type: "bke.chatgpt.probe" });
  await new Promise((resolve) => setTimeout(resolve, 250));
  await refresh();
  feedback.textContent = "Probe complete.";
});

initializeIdentityButton.addEventListener("click", async () => {
  initializeIdentityButton.disabled = true;
  feedback.textContent = "Creating device identity in this browser profile…";
  try {
    const result = await chrome.runtime.sendMessage({type:"bke.device.identity.initialize"});
    feedback.textContent = result.state === "PROVISIONED"
      ? "Private identity created locally. Not paired or connected."
      : (result.code ?? "Device identity unavailable.");
    await refresh();
  } catch { feedback.textContent = "Device identity unavailable."; }
  finally { initializeIdentityButton.disabled = false; }
});

void refresh();
