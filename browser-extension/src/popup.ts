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
const feedback = document.querySelector<HTMLElement>("#feedback")!;
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

void refresh();
