/**
 * F1-03 / F1-04 / F1-05 controller-side browser adapter.
 *
 * Bridges FirstMessageBrowserPort (F1-04) and ContinuationBrowserPort (F1-05)
 * to the authenticated controller -> native-host -> MV3 extension channel.
 */
import type { ContinuationBrowserObservation, ContinuationTurnReceipt } from "./continuation-gate.js";
import type { ContinuationBrowserPort } from "./continuation-runtime.js";
import type { BootstrapBrowserObservation, FirstMessageConversationReceipt } from "./bootstrap-fence.js";
import type { FirstMessageBrowserPort, RuntimeBrowserSnapshot } from "./first-message-runtime.js";
import type { ChatGptPageStatus, ChatPageUiState } from "./protocol.js";

export interface ControllerCommandDispatcher {
  sendCommand(command: Record<string, unknown>): Promise<{
    ok: boolean;
    code: string;
    uncertain?: boolean;
    payload?: Record<string, unknown>;
  }>;
}

export interface ExtensionBrowserAdapterConfig {
  repository: string;
  prNumber: number;
  headSha: string;
  workerId: string;
  targetId: string;
  profileId: string;
  targetTabId: number;
  ttlMs?: number;
  nowMs?: () => number;
  nextSeq?: () => number;
  makeCommandId?: (seq: number) => string;
}

interface ObservedTargetStatus {
  status: ChatGptPageStatus;
  tabId: number;
  targetId: string;
  profileId: string;
  matchingWritableTargetCount: number;
  sharedWritableProfile: boolean;
  uiState: ChatPageUiState;
}

export class ExtensionBrowserAdapter {
  private seq = 0;
  private submitCounter = 0;
  private submittedAttemptIds = new Set<string>();
  private lastFenceCommitReceipt: BootstrapBrowserObservation["fenceCommitReceipt"] | undefined;
  private lastFirstMessageReceipt: FirstMessageConversationReceipt | undefined;
  private lastContinuationReceipt: ContinuationTurnReceipt | undefined;
  private activeConversationId: string | null = null;
  private activeTurnNumber = 2;

  constructor(
    private readonly config: ExtensionBrowserAdapterConfig,
    private readonly dispatcher: ControllerCommandDispatcher,
  ) {}

  get submissionCount(): number {
    return this.submitCounter;
  }

  setFenceCommitReceipt(receipt: BootstrapBrowserObservation["fenceCommitReceipt"]): void {
    this.lastFenceCommitReceipt = receipt;
  }

  setContinuationContext(conversationId: string, turnNumber: number): void {
    this.activeConversationId = conversationId;
    this.activeTurnNumber = turnNumber;
  }

  private nextEnvelope(action: string, extra: Record<string, unknown> = {}) {
    const seq = this.config.nextSeq ? this.config.nextSeq() : (this.seq += 1);
    const now = this.config.nowMs ? this.config.nowMs() : Date.now();
    const command_id = this.config.makeCommandId
      ? this.config.makeCommandId(seq)
      : `bke-cmd-${this.config.prNumber}-${seq}`;
    return {
      type: "COMMAND",
      version: 1,
      command_id,
      seq,
      issued_at_ms: now,
      ttl_ms: this.config.ttlMs ?? 15_000,
      action,
      ...extra,
    };
  }

  private parseStatusPayload(
    payload: Record<string, unknown> | undefined,
    nowIso: string,
  ): ObservedTargetStatus {
    if (!payload) {
      throw Error("BROWSER_TARGET_STATUS_MISSING");
    }
    const tabId = typeof payload.tabId === "number" ? payload.tabId : this.config.targetTabId;
    const targetId = typeof payload.targetId === "string" ? payload.targetId : this.config.targetId;
    const profileId = typeof payload.profileId === "string" ? payload.profileId : this.config.profileId;
    const url = typeof payload.url === "string" ? payload.url : "https://chatgpt.com/unknown";
    const visible = payload.visible === true;
    const composerAvailable = payload.composerAvailable === true;
    const turnBusy = payload.turnBusy === true;
    const uiState = (typeof payload.uiState === "string" ? payload.uiState : "UNKNOWN") as ChatPageUiState;
    const observedAt = typeof payload.observedAt === "string" ? payload.observedAt : nowIso;
    const matchingWritableTargetCount =
      typeof payload.matchingWritableTargetCount === "number"
        ? payload.matchingWritableTargetCount
        : 1;
    const sharedWritableProfile = payload.sharedWritableProfile === true;

    return {
      tabId,
      targetId,
      profileId,
      matchingWritableTargetCount,
      sharedWritableProfile,
      uiState,
      status: {
        protocolVersion: 1,
        observedAt,
        url,
        visible,
        composerAvailable,
        turnBusy,
        uiState,
      },
    };
  }

  private async fetchTargetStatus(nowIso: string): Promise<ObservedTargetStatus> {
    const res = await this.dispatcher.sendCommand(this.nextEnvelope("GET_TARGET_STATUS"));
    if (!res.ok) {
      throw Error(res.code || "TARGET_STATUS_FAILED");
    }
    return this.parseStatusPayload(res.payload, nowIso);
  }

  async observeFirstMessage(nowIso: string): Promise<RuntimeBrowserSnapshot> {
    const obs = await this.fetchTargetStatus(nowIso);
    return {
      fresh: {
        current: {
          observedAt: obs.status.observedAt,
          url: obs.status.url,
          visible: obs.status.visible,
          composerAvailable: obs.status.composerAvailable,
          turnBusy: obs.status.turnBusy,
          tabId: obs.tabId,
          uiState: obs.uiState,
        },
        ownedTargetTabId: obs.tabId,
        ownedTargetId: obs.targetId,
        ownedProfileId: obs.profileId,
        matchingWritableTargetCount: obs.matchingWritableTargetCount,
        sharedWritableProfile: obs.sharedWritableProfile,
      },
      bootstrap: {
        ownedTargetId: obs.targetId,
        ownedProfileId: obs.profileId,
        ownedTargetTabId: obs.tabId,
        matchingWritableTargetCount: obs.matchingWritableTargetCount,
        profileIsolated: !obs.sharedWritableProfile,
        sharedWritableProfile: obs.sharedWritableProfile,
        current: {
          targetId: obs.targetId,
          profileId: obs.profileId,
          tabId: obs.tabId,
          observedAt: obs.status.observedAt,
          url: obs.status.url,
          uiState: obs.uiState,
          visible: obs.status.visible,
          composerAvailable: obs.status.composerAvailable,
          turnBusy: obs.status.turnBusy,
        },
        ...(this.lastFenceCommitReceipt ? { fenceCommitReceipt: { ...this.lastFenceCommitReceipt } } : {}),
        ...(this.lastFirstMessageReceipt ? { firstMessageReceipt: { ...this.lastFirstMessageReceipt } } : {}),
      },
    };
  }

  async observeContinuation(nowIso: string): Promise<ContinuationBrowserObservation> {
    const obs = await this.fetchTargetStatus(nowIso);
    return {
      ownedTargetId: obs.targetId,
      ownedProfileId: obs.profileId,
      ownedTargetTabId: obs.tabId,
      matchingWritableTargetCount: obs.matchingWritableTargetCount,
      profileIsolated: !obs.sharedWritableProfile,
      sharedWritableProfile: obs.sharedWritableProfile,
      current: {
        targetId: obs.targetId,
        profileId: obs.profileId,
        tabId: obs.tabId,
        observedAt: obs.status.observedAt,
        url: obs.status.url,
        uiState: obs.uiState,
        visible: obs.status.visible,
        composerAvailable: obs.status.composerAvailable,
        turnBusy: obs.status.turnBusy,
      },
      ...(this.lastFenceCommitReceipt ? { fenceCommitReceipt: { ...this.lastFenceCommitReceipt } } : {}),
      ...(this.lastContinuationReceipt ? { continuationReceipt: { ...this.lastContinuationReceipt } } : {}),
    };
  }

  async submitOnce(
    prompt: string,
    binding: {
      attemptId: string;
      fenceId: string;
      claimId: string;
      targetId: string;
      profileId: string;
      targetTabId: number;
      fenceCommitSha?: string;
      sendClaimCommitSha?: string;
    },
  ): Promise<{ status: "SENT" | "UNCERTAIN"; receipt: FirstMessageConversationReceipt | null }> {
    if (this.submittedAttemptIds.has(binding.attemptId)) {
      return { status: "UNCERTAIN", receipt: null };
    }
    this.submittedAttemptIds.add(binding.attemptId);
    this.submitCounter += 1;

    const cmd = this.nextEnvelope("DISPATCH_FIRST_MESSAGE", {
      pr_number: this.config.prNumber,
      head_sha: this.config.headSha,
      attempt_id: binding.attemptId,
      fence_id: binding.fenceId,
      claim_id: binding.claimId,
      target_id: binding.targetId,
      profile_id: binding.profileId,
      target_tab_id: binding.targetTabId,
      prompt,
    });

    try {
      const res = await this.dispatcher.sendCommand(cmd);
      if (!res.ok || res.uncertain || !res.payload) {
        return { status: "UNCERTAIN", receipt: null };
      }
      const p = res.payload;
      const beforeUrl = typeof p.beforeUrl === "string" ? p.beforeUrl : "";
      const afterUrl = typeof p.afterUrl === "string" ? p.afterUrl : "";
      const conversationId = typeof p.conversationId === "string" ? p.conversationId : "";
      const sendStartedAt = typeof p.sendStartedAt === "string" ? p.sendStartedAt : "";
      const confirmedAt = typeof p.confirmedAt === "string" ? p.confirmedAt : "";
      if (!beforeUrl || !afterUrl || !conversationId || !sendStartedAt || !confirmedAt) {
        return { status: "UNCERTAIN", receipt: null };
      }
      const receipt: FirstMessageConversationReceipt = {
        event: "FIRST_MESSAGE_CREATED_CONVERSATION",
        attemptId: binding.attemptId,
        workerId: this.config.workerId,
        headSha: this.config.headSha,
        fenceId: binding.fenceId,
        fenceCommitSha: binding.fenceCommitSha ?? this.config.headSha,
        sendClaimId: binding.claimId,
        sendClaimCommitSha: binding.sendClaimCommitSha ?? this.config.headSha,
        targetId: binding.targetId,
        profileId: binding.profileId,
        targetTabId: binding.targetTabId,
        beforeUrl,
        afterUrl,
        conversationId,
        sendStartedAt,
        confirmedAt,
      };
      this.activeConversationId = conversationId;
      this.lastFirstMessageReceipt = receipt;
      return { status: "SENT", receipt };
    } catch {
      return { status: "UNCERTAIN", receipt: null };
    }
  }

  async submitContinuationOnce(
    prompt: string,
    binding: {
      attemptId: string;
      fenceId: string;
      claimId: string;
      targetId: string;
      profileId: string;
      targetTabId: number;
      expectedConversationId: string;
      expectedTurnNumber: number;
      fenceCommitSha?: string;
      sendClaimCommitSha?: string;
    },
  ): Promise<{ status: "SENT" | "UNCERTAIN"; receipt: ContinuationTurnReceipt | null }> {
    if (this.submittedAttemptIds.has(binding.attemptId)) {
      return { status: "UNCERTAIN", receipt: null };
    }
    this.submittedAttemptIds.add(binding.attemptId);
    this.submitCounter += 1;

    const cmd = this.nextEnvelope("DISPATCH_CONTINUATION", {
      pr_number: this.config.prNumber,
      head_sha: this.config.headSha,
      attempt_id: binding.attemptId,
      fence_id: binding.fenceId,
      claim_id: binding.claimId,
      target_id: binding.targetId,
      profile_id: binding.profileId,
      target_tab_id: binding.targetTabId,
      expected_conversation_id: binding.expectedConversationId ?? this.activeConversationId ?? "",
      expected_turn_number: binding.expectedTurnNumber ?? this.activeTurnNumber,
      prompt,
    });

    try {
      const res = await this.dispatcher.sendCommand(cmd);
      if (!res.ok || res.uncertain || !res.payload) {
        return { status: "UNCERTAIN", receipt: null };
      }
      const p = res.payload;
      const beforeUrl = typeof p.beforeUrl === "string" ? p.beforeUrl : "";
      const afterUrl = typeof p.afterUrl === "string" ? p.afterUrl : "";
      const conversationId = typeof p.conversationId === "string" ? p.conversationId : "";
      const sendStartedAt = typeof p.sendStartedAt === "string" ? p.sendStartedAt : "";
      const confirmedAt = typeof p.confirmedAt === "string" ? p.confirmedAt : "";
      if (!beforeUrl || !afterUrl || !conversationId || !sendStartedAt || !confirmedAt) {
        return { status: "UNCERTAIN", receipt: null };
      }
      const receipt: ContinuationTurnReceipt = {
        event: "CONTINUATION_SENT_IN_SAME_CONVERSATION",
        attemptId: binding.attemptId,
        workerId: this.config.workerId,
        headSha: this.config.headSha,
        turnNumber: binding.expectedTurnNumber ?? this.activeTurnNumber,
        fenceId: binding.fenceId,
        fenceCommitSha: binding.fenceCommitSha ?? this.config.headSha,
        sendClaimId: binding.claimId,
        sendClaimCommitSha: binding.sendClaimCommitSha ?? this.config.headSha,
        targetId: binding.targetId,
        profileId: binding.profileId,
        targetTabId: binding.targetTabId,
        conversationId,
        beforeUrl,
        afterUrl,
        sendStartedAt,
        confirmedAt,
      };
      this.lastContinuationReceipt = receipt;
      return { status: "SENT", receipt };
    } catch {
      return { status: "UNCERTAIN", receipt: null };
    }
  }

  asFirstMessagePort(): FirstMessageBrowserPort {
    const adapterRef = this;
    return {
      observe: (nowIso: string) => this.observeFirstMessage(nowIso),
      get submissionCount() {
        return adapterRef.submissionCount;
      },
      submitOnce: (prompt, binding) => this.submitOnce(prompt, binding),
    };
  }

  asContinuationPort(): ContinuationBrowserPort {
    const adapterRef = this;
    return {
      observe: (nowIso: string) => this.observeContinuation(nowIso),
      get submissionCount() {
        return adapterRef.submissionCount;
      },
      submitContinuationOnce: (prompt, binding) => this.submitContinuationOnce(prompt, binding),
    };
  }
}
