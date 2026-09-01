using BKE.Worker.Core;

namespace BKE.Worker.Platform.Android.Execution;

public enum AndroidExecutionState
{
    Idle,
    LaunchingChatGPT,
    SelectingContext,
    SelectingReasoning,
    EnteringInstruction,
    Submitting,
    WaitingForResponse,
    CapturingResponse,
    Completed,
    Failed
}

public enum AndroidFailureCode
{
    CHATGPT_NOT_INSTALLED,
    CHATGPT_LAUNCH_FAILED,
    ACCESSIBILITY_PERMISSION_MISSING,
    CONTEXT_DISCOVERY_FAILED,
    CONTEXT_NOT_FOUND,
    PROJECT_NOT_FOUND,
    CONVERSATION_AMBIGUOUS,
    REASONING_SELECTOR_NOT_FOUND,
    REASONING_PROFILE_NOT_AVAILABLE,
    REASONING_VERIFICATION_FAILED,
    COMPOSER_NOT_FOUND,
    SUBMIT_FAILED,
    GENERATION_TIMEOUT,
    RESPONSE_CAPTURE_FAILED,
    CHATGPT_AUTH_REQUIRED
}

public sealed record ChatGPTExecutionResult(
    ContextTarget Context,
    ReasoningProfile Reasoning,
    AndroidExecutionState State,
    string? Response,
    DateTimeOffset StartedAt,
    DateTimeOffset? CompletedAt,
    AndroidFailureCode? FailureCode = null,
    string? FailureReason = null);
