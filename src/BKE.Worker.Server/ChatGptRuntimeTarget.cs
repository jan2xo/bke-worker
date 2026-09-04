using BKE.Worker.Core;

public sealed record ChatGptTargetRequest(string Url);

public sealed class ChatGptRuntimeTarget
{
    private readonly object _gate = new();
    private string? _url;

    public bool IsConnected
    {
        get
        {
            lock (_gate)
                return !string.IsNullOrWhiteSpace(_url);
        }
    }

    public void Connect(string url)
    {
        var normalized = ValidateAndNormalize(url);
        lock (_gate)
            _url = normalized;
    }

    public void Disconnect()
    {
        lock (_gate)
            _url = null;
    }

    public ContextTarget ResolveContextTarget()
    {
        lock (_gate)
        {
            if (string.IsNullOrWhiteSpace(_url))
                throw new InvalidOperationException("CHATGPT_TARGET_NOT_CONNECTED");

            return ContextTarget.OverrideLink(_url, ChatGptExecutionSurface.Chat);
        }
    }

    public string GetUrl()
    {
        lock (_gate)
            return _url ?? throw new InvalidOperationException("CHATGPT_TARGET_NOT_CONNECTED");
    }

    public static string ValidateAndNormalize(string value)
    {
        ArgumentException.ThrowIfNullOrWhiteSpace(value);
        var trimmed = value.Trim();

        if (!Uri.TryCreate(trimmed, UriKind.Absolute, out var uri) ||
            !string.Equals(uri.Scheme, Uri.UriSchemeHttps, StringComparison.OrdinalIgnoreCase) ||
            !(string.Equals(uri.Host, "chatgpt.com", StringComparison.OrdinalIgnoreCase) ||
              string.Equals(uri.Host, "www.chatgpt.com", StringComparison.OrdinalIgnoreCase)))
        {
            throw new ArgumentException("CHATGPT_TARGET_MUST_BE_HTTPS_CHATGPT_COM", nameof(value));
        }

        var segments = uri.AbsolutePath
            .Split('/', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries);

        var hasConversation = false;
        for (var index = 0; index < segments.Length - 1; index++)
        {
            if (string.Equals(segments[index], "c", StringComparison.OrdinalIgnoreCase) &&
                !string.IsNullOrWhiteSpace(segments[index + 1]))
            {
                hasConversation = true;
                break;
            }
        }

        if (!hasConversation)
            throw new ArgumentException("CHATGPT_TARGET_MUST_CONTAIN_EXACT_CONVERSATION_PATH", nameof(value));

        return trimmed;
    }
}
