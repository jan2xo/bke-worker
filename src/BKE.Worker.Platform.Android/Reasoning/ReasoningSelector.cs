using BKE.Worker.Core;

namespace BKE.Worker.Platform.Android.Reasoning;

public interface IAndroidReasoningSelector
{
    Task<IReadOnlyList<ReasoningProfile>> DiscoverAsync(CancellationToken cancellationToken);
    Task<bool> SelectAsync(ReasoningProfile profile, CancellationToken cancellationToken);
    Task<ReasoningProfile?> ReadSelectedAsync(CancellationToken cancellationToken);
}

public sealed class AndroidReasoningVerifier(IAndroidReasoningSelector selector)
{
    public async Task<bool> SelectAndVerifyAsync(ReasoningProfile requested, CancellationToken cancellationToken)
    {
        var available = await selector.DiscoverAsync(cancellationToken);
        if (!available.Contains(requested))
            return false;

        if (await selector.ReadSelectedAsync(cancellationToken) != requested &&
            !await selector.SelectAsync(requested, cancellationToken))
            return false;

        return await selector.ReadSelectedAsync(cancellationToken) == requested;
    }
}
