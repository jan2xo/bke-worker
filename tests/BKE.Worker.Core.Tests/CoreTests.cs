using BKE.Worker.Core;
namespace BKE.Worker.Core.Tests;
public class CoreTests
{
    [Fact] public void Default_reasoning_is_high() => Assert.Equal(ReasoningProfile.HIGH, new WorkerPolicy().DefaultReasoning);
    [Theory] [InlineData(ContextTargetType.RecentChat)] [InlineData(ContextTargetType.ProjectChat)] [InlineData(ContextTargetType.NewChat)] public void Context_targets_are_supported(ContextTargetType type) => Assert.Equal(type, new ContextTarget(type).Type);
    [Fact] public void Default_resolves_to_policy() => Assert.Equal(ReasoningProfile.HIGH, new ReasoningResolver().Resolve(ReasoningProfile.DEFAULT, new WorkerPolicy()));
}
