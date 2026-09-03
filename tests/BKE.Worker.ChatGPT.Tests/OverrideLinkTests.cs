using BKE.Worker.ChatGPT.Playwright;
using BKE.Worker.Core;
using Xunit;

namespace BKE.Worker.ChatGPT.Tests;

public sealed class OverrideLinkTests
{
    [Theory]
    [InlineData("https://example.com/c/conversation")]
    [InlineData("http://chatgpt.com/c/conversation")]
    [InlineData("https://chatgpt.com/projects")]
    [InlineData("https://chatgpt.com/g/g-p-project/project")]
    public async Task Override_link_rejects_non_chatgpt_or_non_conversation_urls(string overrideUrl)
    {
        var profile = CreateProfileDirectory();
        var host = new ChromiumHost(new ChromiumHostOptions(
            profile,
            Headless: true,
            "http://127.0.0.1:1/"));
        var driver = new ChatGPTWebDriver(
            host,
            new ProjectNavigator(),
            new ConversationNavigator(),
            new ComposerDriver());

        try
        {
            var exception = await Assert.ThrowsAsync<InvalidOperationException>(() =>
                driver.OpenContext(
                    ContextTarget.OverrideLink(overrideUrl),
                    CancellationToken.None));

            Assert.Equal("CHATGPT_OVERRIDE_URL_INVALID", exception.Message);
        }
        finally
        {
            await host.DisposeAsync();
            DeleteProfileDirectory(profile);
        }
    }

    [Fact]
    public async Task Work_surface_override_is_rejected_before_navigation()
    {
        var profile = CreateProfileDirectory();
        var host = new ChromiumHost(new ChromiumHostOptions(
            profile,
            Headless: true,
            "http://127.0.0.1:1/"));
        var driver = new ChatGPTWebDriver(
            host,
            new ProjectNavigator(),
            new ConversationNavigator(),
            new ComposerDriver());

        try
        {
            var exception = await Assert.ThrowsAsync<InvalidOperationException>(() =>
                driver.OpenContext(
                    ContextTarget.OverrideLink(
                        "https://chatgpt.com/g/g-p-project/c/conversation",
                        ChatGptExecutionSurface.Work),
                    CancellationToken.None));

            Assert.Equal("CHATGPT_EXECUTION_SURFACE_MISMATCH", exception.Message);
        }
        finally
        {
            await host.DisposeAsync();
            DeleteProfileDirectory(profile);
        }
    }

    private static string CreateProfileDirectory()
    {
        var path = Path.Combine(
            Path.GetTempPath(),
            "bke-worker-override-link",
            Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(path);
        return path;
    }

    private static void DeleteProfileDirectory(string path)
    {
        if (Directory.Exists(path))
            Directory.Delete(path, recursive: true);
    }
}
