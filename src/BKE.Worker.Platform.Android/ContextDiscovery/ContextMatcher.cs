using BKE.Worker.Core;

namespace BKE.Worker.Platform.Android.ContextDiscovery;

public sealed record ContextMatchResult(bool Success, ContextTarget? Target, string? FailureCode = null);

public sealed class ContextMatcher
{
    public ContextMatchResult Match(ContextTarget requested, IEnumerable<ContextTarget> candidates)
    {
        var list = candidates.ToArray();
        if (requested.Type == ContextTargetType.NewChat)
            return new(true, requested);

        var matches = list.Where(candidate =>
            candidate.Type == requested.Type &&
            Normalize(candidate.Conversation) == Normalize(requested.Conversation) &&
            (requested.Type != ContextTargetType.ProjectChat ||
             Normalize(candidate.Project) == Normalize(requested.Project))).ToArray();

        return matches.Length switch
        {
            1 => new(true, matches[0]),
            0 => new(false, null, requested.Type == ContextTargetType.ProjectChat ? "PROJECT_OR_CONVERSATION_NOT_FOUND" : "CONTEXT_NOT_FOUND"),
            _ => new(false, null, "CONVERSATION_AMBIGUOUS")
        };
    }

    private static string Normalize(string? value) =>
        string.Join(' ', (value ?? string.Empty).Split((char[]?)null, StringSplitOptions.RemoveEmptyEntries)).Trim().ToUpperInvariant();
}
