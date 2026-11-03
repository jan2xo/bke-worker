// Source-only owner-selected ChatGPT status binding. No browser profile,
// controller, pairing, assignment, or message-send authority is conferred.
import { isValidChatGptPageStatus, isValidWorkerId, type ChatGptPageStatus } from "./protocol.js";

type BrowserTab = { id?:number; url?:string; incognito?:boolean };
type BrowserSender = { id?:string; tab?:BrowserTab; url?:string;
  frameId?:number; documentId?:string; documentLifecycle?:string };
type Selected = { workerId:string; keySha256:string; tabId:number;
  documentId:string|null; url:string|null };
const HASH=/^[a-f0-9]{64}$/;
const UUID=/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i;
const isChatUrl=(url:unknown):url is string=>{
  try { return typeof url==="string" && new URL(url).origin==="https://chatgpt.com"; }
  catch { return false; }
};
const blocked=(code:string)=>({ok:false,code});
const safeTab=(tab:BrowserTab|undefined):tab is BrowserTab&{id:number;url:string}=>
  Number.isSafeInteger(tab?.id)&&Number(tab?.id)>=0&&tab?.incognito===false&&isChatUrl(tab?.url);

export function createChatGptTargetBinding(
  listTabs:()=>Promise<BrowserTab[]>,extensionId:string,
) {
  let selected:Selected|null=null;
  let status:ChatGptPageStatus|null=null;
  let generation=0;
  function invalidate(){generation++;selected=null;status=null;}
  function sameOwner(workerId:string,keySha256:string){
    return selected!==null&&selected.workerId===workerId&&selected.keySha256===keySha256;
  }
  async function census(tabId:number,url:string){
    try {
      const tabs=await listTabs();
      return Array.isArray(tabs)&&tabs.length===1&&safeTab(tabs[0])&&
        tabs[0].id===tabId&&tabs[0].url===url;
    }catch{return false;}
  }
  async function select(workerId:string,keySha256:string){
    invalidate();
    const generationAtStart=generation;
    if(!isValidWorkerId(workerId)||workerId.trim()!==workerId||!HASH.test(keySha256))
      return blocked("TARGET_OWNER_INVALID");
    let tabs:BrowserTab[];
    try{tabs=await listTabs();}catch{return blocked("TARGET_TABS_UNAVAILABLE");}
    if(generation!==generationAtStart)return blocked("TARGET_SELECTION_STALE");
    if(!Array.isArray(tabs)||tabs.length!==1||!safeTab(tabs[0]))
      return blocked("TARGET_NOT_UNIQUE");
    selected={workerId,keySha256,tabId:tabs[0].id,documentId:null,url:null};
    return {ok:true,state:"OWNER_TAB_SELECTED_OBSERVATION_ONLY" as const};
  }
  async function observe(payload:unknown,sender:BrowserSender,workerId:string,keySha256:string){
    const current=selected,started=generation;
    if(!current)return blocked("TARGET_NOT_SELECTED");
    if(!sameOwner(workerId,keySha256)){invalidate();return blocked("TARGET_OWNER_CHANGED");}
    if(!isValidChatGptPageStatus(payload)||sender?.id!==extensionId||
      sender.frameId!==0||sender.documentLifecycle!=="active"||
      typeof sender.documentId!=="string"||!UUID.test(sender.documentId)||
      !safeTab(sender.tab)||sender.tab.id!==current.tabId||
      sender.url!==payload.url||!isChatUrl(sender.url)){
      invalidate();return blocked("TARGET_SENDER_DENIED");
    }
    if(current.documentId!==null&&current.documentId!==sender.documentId){
      invalidate();return blocked("TARGET_DOCUMENT_CHANGED");
    }
    if(current.url!==null&&current.url!==sender.url){
      invalidate();return blocked("TARGET_URL_CHANGED");
    }
    if(!await census(current.tabId,sender.url)){
      invalidate();return blocked("TARGET_CENSUS_CHANGED");
    }
    if(generation!==started||selected!==current)return blocked("TARGET_OBSERVATION_STALE");
    selected={...current,documentId:sender.documentId,url:sender.url};
    status=payload;
    return {ok:true};
  }
  async function current(workerId:string,keySha256:string){
    const snapshot=selected,seen=status,started=generation;
    if(!snapshot||!seen)return null;
    if(!sameOwner(workerId,keySha256)){invalidate();return null;}
    if(snapshot.documentId===null||snapshot.url===null||
      !await census(snapshot.tabId,snapshot.url)){
      invalidate();return null;
    }
    if(generation!==started||selected!==snapshot)return null;
    return seen;
  }
  function tabChanged(tabId:number){if(selected?.tabId===tabId)invalidate();}
  return Object.freeze({select,observe,current,invalidate,tabChanged});
}
