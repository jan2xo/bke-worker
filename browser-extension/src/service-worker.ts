import {
  PROTOCOL_VERSION,
  deriveConnectionState,
  isValidChatGptPageStatus,
  validateConfig,
  type BridgeConfig,
  type BridgeStatus,
  type ChatGptPageStatus,
} from "./protocol.js";
import { createDeviceIdentityBridge, createIndexedDbIdentityStore, publicIdentitySummary } from "./device-identity.js";
import { checkOwnerNativePolicy } from "./native-policy-gate.js";
import { proveLocalNativeHost } from "./native-proof-client.js";
import { createChatGptTargetBinding } from "./target-binding.js";

const CONFIG_KEY = "bridgeConfig";
const STATUS_MESSAGE = "bke.chatgpt.status";
const GET_STATUS_MESSAGE = "bke.status.get";
const GET_CONFIG_MESSAGE = "bke.config.get";
const SET_CONFIG_MESSAGE = "bke.config.set";
const PROBE_MESSAGE = "bke.chatgpt.probe";
const IDENTITY_STATUS_MESSAGE = "bke.device.identity.status";
const IDENTITY_INIT_MESSAGE = "bke.device.identity.initialize";
const NATIVE_PROOF_MESSAGE = "bke.native.local.proof";
const TARGET_SELECT_MESSAGE = "bke.chatgpt.target.select";
const targetBinding=createChatGptTargetBinding(
  ()=>chrome.tabs.query({url:["https://chatgpt.com/*"]}),chrome.runtime.id,
  (tabId:number)=>chrome.webNavigation.getFrame({tabId,frameId:0}));
let nativeProofActive = false;

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

// Identity is read from the extension's own nonexportable key store, never
// accepted from ChatGPT page input or the untrusted message payload.
async function ownerIdentity():Promise<{workerId:string;keySha256:string}|null>{
  try{
    const config=await getConfig();
    if(!validateConfig(config.workerId,config.controllerUrl).ok)return null;
    const key=await createDeviceIdentityBridge({
      store:createIndexedDbIdentityStore()}).read(config.workerId);
    return key.state==="READY"
      ? {workerId:config.workerId,keySha256:key.public_key_sha256}:null;
  }catch{return null;}
}
async function getBridgeStatus():Promise<BridgeStatus>{
  const config=await getConfig();
  const owner=await ownerIdentity();
  const chatGpt=owner
    ? await targetBinding.current(owner.workerId,owner.keySha256):null;
  return {
    protocolVersion:PROTOCOL_VERSION,workerId:config.workerId,
    controllerUrl:config.controllerUrl,
    connectionState:deriveConnectionState(config),chatGpt,
  };
}
async function recordChatGptStatus(payload:unknown,sender:any){
  const owner=await ownerIdentity();
  if(!owner){
    targetBinding.invalidate();
    return {ok:false,error:"TARGET_OWNER_UNAVAILABLE"};
  }
  const result=await targetBinding.observe(payload,sender,owner.workerId,owner.keySha256);
  if(!result.ok){
    await chrome.action.setBadgeText({text:""});
    return {ok:false,error:result.code};
  }
  const candidate=payload as ChatGptPageStatus;
  await chrome.action.setBadgeText({
    text:candidate.composerAvailable&&!candidate.turnBusy?"OK":"…",
  });
  return {ok:true};
}
// Selecting a read-only target is a separate direct owner popup action.
async function selectOwnerTarget(){
  const owner=await ownerIdentity();
  if(!owner)return {ok:false,code:"TARGET_OWNER_UNAVAILABLE"};
  const result=await targetBinding.select(owner.workerId,owner.keySha256);
  if(result.ok)await probeChatGptTabs();
  return result;
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

async function initializeBridge(): Promise<void> {
  targetBinding.invalidate(); // MV3 restart never restores stale observations.
  await chrome.action.setBadgeText({text:""});
  await hardenStorageAccess();
  await probeChatGptTabs();
}

chrome.runtime.onInstalled.addListener(() => {
  void chrome.action
    .setBadgeText({ text: "" })
    .then(() => initializeBridge());
});

chrome.runtime.onStartup.addListener(() => {
  void initializeBridge();
});
chrome.tabs.onRemoved.addListener((tabId:number)=>{
  targetBinding.tabChanged(tabId);
  void chrome.action.setBadgeText({text:""});
});
chrome.tabs.onUpdated.addListener((tabId:number,change:any)=>{
  if(change?.status==="loading"||typeof change?.url==="string"){
    targetBinding.tabChanged(tabId);
    void chrome.action.setBadgeText({text:""});
  }
});
chrome.tabs.onReplaced.addListener((added:number,removed:number)=>{
  targetBinding.tabChanged(removed);
  targetBinding.tabChanged(added);
  void chrome.action.setBadgeText({text:""});
});
// History API and fragment navigation can change a top-level URL while the
// tab ID and document ID remain the same; never preserve old status on either.
function revokeTopLevelNavigation(details:any){
  if(details?.frameId!==0||!Number.isSafeInteger(details?.tabId))return;
  targetBinding.tabChanged(details.tabId);
  void chrome.action.setBadgeText({text:""});
}
chrome.webNavigation.onHistoryStateUpdated.addListener(revokeTopLevelNavigation);
chrome.webNavigation.onReferenceFragmentUpdated.addListener(revokeTopLevelNavigation);
chrome.webNavigation.onBeforeNavigate.addListener(revokeTopLevelNavigation);

// Only the extension popup can initialize or inspect the local device key.
// Neither ChatGPT content scripts nor externally-connected pages can sign.
function isTrustedPopup(sender: any): boolean {
  return sender?.id === chrome.runtime.id &&
    sender?.url === chrome.runtime.getURL("popup.html") &&
    !sender?.tab;
}

async function deviceIdentityAction(kind: "read" | "initialize") {
  try {
    const config = await getConfig();
    if (!validateConfig(config.workerId, config.controllerUrl).ok) {
      return { state: "BLOCKED", code: "IDENTITY_CONFIGURATION_INVALID" };
    }
    const bridge = createDeviceIdentityBridge({store:createIndexedDbIdentityStore()});
    if (kind === "initialize") {
      const result = await bridge.initialize(config.workerId);
      if (result.state !== "READY") return result;
    }
    return publicIdentitySummary(bridge, config.workerId);
  } catch { return { state: "BLOCKED", code: "IDENTITY_UNAVAILABLE" }; }
}


// Runs ONLY after an explicit owner popup click + Chrome optional permission.
// A local signed possession receipt is never a GitHub claim, controller session,
// browser/account attestation, ChatGPT send or autonomous wake permission.
async function nativeProofAction(rawPolicy: unknown) {
  if (nativeProofActive) return {state:"BLOCKED",code:"NATIVE_PROOF_ALREADY_IN_PROGRESS"};
  nativeProofActive = true;
  try {
    const config = await getConfig();
    if (!validateConfig(config.workerId, config.controllerUrl).ok)
      return {state:"BLOCKED",code:"NATIVE_PROOF_WORKER_INVALID"};
    const bridge = createDeviceIdentityBridge({store:createIndexedDbIdentityStore()});
    const publicKey = await bridge.read(config.workerId);
    if (publicKey.state !== "READY")
      return {state:"BLOCKED",code:"NATIVE_PROOF_DEVICE_KEY_UNAVAILABLE"};
    const policy = checkOwnerNativePolicy(rawPolicy,{
      origin:chrome.runtime.getURL(""),
      workerId:config.workerId,
      publicKeySha256:publicKey.public_key_sha256,
      now:Date.now(),
    });
    if (policy.state !== "LOCAL_POLICY_MATCH_ONLY") return policy;
    const permitted = await chrome.permissions.contains({permissions:["nativeMessaging"]});
    if (permitted !== true)
      return {state:"BLOCKED",code:"NATIVE_PROOF_PERMISSION_NOT_GRANTED"};
    const tabs = await chrome.tabs.query({url:["https://chatgpt.com/*"]});
    if (tabs.length !== 1 || !Number.isInteger(tabs[0]?.id) ||
        tabs[0]?.incognito === true)
      return {state:"BLOCKED",code:"NATIVE_PROOF_TARGET_AMBIGUOUS"};
    return await proveLocalNativeHost({
      runtime:chrome.runtime,
      identity:bridge,
      workerId:config.workerId,
      resources:policy.resources,
      profileBindingSha256:policy.profileBindingSha256,
    });
  } catch {
    return {state:"BLOCKED",code:"NATIVE_PROOF_OUTCOME_UNCERTAIN"};
  } finally {
    nativeProofActive = false;
  }
}

chrome.runtime.onMessage.addListener(
  (
    message: any,
    sender: any,
    sendResponse: (response: unknown) => void,
  ) => {
    const type = message?.type;

    if (type === NATIVE_PROOF_MESSAGE) {
      if (!isTrustedPopup(sender)) {
        sendResponse({state:"BLOCKED",code:"NATIVE_PROOF_SENDER_REJECTED"});
        return false;
      }
      void nativeProofAction(message?.policy).then(sendResponse,
        () => sendResponse({state:"BLOCKED",code:"NATIVE_PROOF_OUTCOME_UNCERTAIN"}));
      return true;
    }

    if (type === IDENTITY_STATUS_MESSAGE || type === IDENTITY_INIT_MESSAGE) {
      if (!isTrustedPopup(sender)) {
        sendResponse({ state: "BLOCKED", code: "IDENTITY_SENDER_REJECTED" });
        return false;
      }
      void deviceIdentityAction(type === IDENTITY_INIT_MESSAGE ? "initialize" : "read")
        .then(sendResponse, () => sendResponse({state:"BLOCKED",code:"IDENTITY_UNAVAILABLE"}));
      return true;
    }

    if (type === STATUS_MESSAGE) {
      void recordChatGptStatus(message.payload, sender).then(sendResponse,
        () => sendResponse({ok:false,error:"TARGET_OBSERVATION_UNAVAILABLE"}));
      return true;
    }

    if (type === TARGET_SELECT_MESSAGE) {
      if(!isTrustedPopup(sender)){
        sendResponse({ok:false,code:"TARGET_SELECT_SENDER_REJECTED"});
        return false;
      }
      void selectOwnerTarget().then(sendResponse,
        () => sendResponse({ok:false,code:"TARGET_SELECTION_UNAVAILABLE"}));
      return true;
    }

    if (type === GET_STATUS_MESSAGE) {
      if(!isTrustedPopup(sender)){
        sendResponse({ok:false,error:"TARGET_STATUS_SENDER_REJECTED"});
        return false;
      }
      void getBridgeStatus().then(sendResponse);
      return true;
    }

    if (type === GET_CONFIG_MESSAGE) {
      if (!isTrustedPopup(sender)) {
        sendResponse({ok:false,error:"CONFIG_SENDER_REJECTED"});
        return false;
      }
      void getConfig().then(sendResponse);
      return true;
    }

    if (type === SET_CONFIG_MESSAGE) {
      if (!isTrustedPopup(sender)) {
        sendResponse({ok:false,error:"CONFIG_SENDER_REJECTED"});
        return false;
      }
      const workerId = String(message?.workerId ?? "");
      const controllerUrl = String(message?.controllerUrl ?? "");
      const result = validateConfig(workerId, controllerUrl);

      if (!result.ok || result.value === null) {
        sendResponse(result);
        return false;
      }

      targetBinding.invalidate(); // Even a same-ID save requires re-selection.
      void chrome.action.setBadgeText({text:""});
      void chrome.storage.local
        .set({ [CONFIG_KEY]: result.value })
        .then(() => sendResponse(result),
          () => sendResponse({ok:false,error:"CONFIG_SAVE_UNAVAILABLE"}));
      return true;
    }

    if (type === PROBE_MESSAGE) {
      void probeChatGptTabs().then(() => sendResponse({ ok: true }));
      return true;
    }

    return false;
  },
);

void initializeBridge();
