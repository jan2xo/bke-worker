using System.Net.Http.Json;
using Microsoft.Playwright;
using Xunit;

namespace BKE.Worker.Server.Ui.Tests;

public sealed class OperatorUiTests
{
    private static readonly string WorkerBaseUrl =
        Environment.GetEnvironmentVariable("BKE_WORKER_UI_BASE_URL") ?? "http://127.0.0.1:5084";

    private static readonly string FixtureBaseUrl =
        Environment.GetEnvironmentVariable("BKE_WORKER_UI_FIXTURE_URL") ?? "http://127.0.0.1:5094";

    [Fact]
    public async Task Operator_surface_renders_live_worker_state_probe_is_non_mutating_and_manual_reconcile_works()
    {
        using var playwright = await Playwright.CreateAsync();
        await using var browser = await playwright.Chromium.LaunchAsync(new BrowserTypeLaunchOptions
        {
            Headless = true
        });

        var page = await browser.NewPageAsync();
        await page.GotoAsync(WorkerBaseUrl, new PageGotoOptions { WaitUntil = WaitUntilState.NetworkIdle });

        await Assertions.Expect(page.GetByRole(AriaRole.Heading, new() { Name = "BKE Worker" })).ToBeVisibleAsync();
        await Assertions.Expect(page.GetByText("Operator Control Surface")).ToBeVisibleAsync();
        await Assertions.Expect(page.GetByText("WAITING_FOR_ENGINEERING_EVENT")).ToBeVisibleAsync();
        await Assertions.Expect(page.GetByText("BKE Worker", new() { Exact = true }).Last).ToBeVisibleAsync();
        await Assertions.Expect(page.GetByText("Worker Engineering", new() { Exact = true })).ToBeVisibleAsync();
        await Assertions.Expect(page.GetByText("Configured", new() { Exact = true }).First).ToBeVisibleAsync();

        var initialPromptCount = await PromptCount();
        Assert.Equal(1, initialPromptCount);

        await page.GetByRole(AriaRole.Button, new() { Name = "Probe ChatGPT Adapter" }).ClickAsync();
        await Assertions.Expect(page.GetByText("ChatGPT adapter compatible. No prompt was sent.", new() { Exact = true })).ToBeVisibleAsync();
        await Assertions.Expect(page.GetByText("Compatible", new() { Exact = true })).ToBeVisibleAsync();
        await Assertions.Expect(page.GetByText("Authenticated", new() { Exact = true })).ToBeVisibleAsync();
        Assert.Equal(initialPromptCount, await PromptCount());

        await page.GetByRole(AriaRole.Button, new() { Name = "Force Reconcile" }).ClickAsync();
        await Assertions.Expect(page.GetByText("Manual reconciliation queued.", new() { Exact = true })).ToBeVisibleAsync();

        for (var attempt = 0; attempt < 30; attempt++)
        {
            if (await PromptCount() == 2)
                break;

            await Task.Delay(250);
        }

        Assert.Equal(2, await PromptCount());
        await Assertions.Expect(page.GetByText("WAITING_FOR_ENGINEERING_EVENT")).ToBeVisibleAsync();

        var html = await page.ContentAsync();
        Assert.DoesNotContain("phase4-fixture-token", html, StringComparison.Ordinal);
        Assert.DoesNotContain("phase4-ci-secret", html, StringComparison.Ordinal);
    }

    private static async Task<int> PromptCount()
    {
        using var client = new HttpClient();
        var state = await client.GetFromJsonAsync<FixtureState>($"{FixtureBaseUrl}/admin/state");
        return state?.Prompts?.Length ?? 0;
    }

    private sealed record FixtureState(string[] Prompts);
}
