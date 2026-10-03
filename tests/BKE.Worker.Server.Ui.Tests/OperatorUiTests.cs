using System.Net.Http.Json;
using Microsoft.Playwright;
using Xunit;

namespace BKE.Worker.Server.Ui.Tests;

public sealed class OperatorUiTests
{
    private static readonly string WorkerBaseUrl =
        Environment.GetEnvironmentVariable(
            "BKE_WORKER_UI_BASE_URL") ??
        "http://127.0.0.1:5084";

    private static readonly string FixtureBaseUrl =
        Environment.GetEnvironmentVariable(
            "BKE_WORKER_UI_FIXTURE_URL") ??
        "http://127.0.0.1:5094";

    [Fact]
    public async Task Operator_surface_exposes_assigned_multi_worker_contract_and_manual_continue()
    {
        using var playwright =
            await Playwright.CreateAsync();
        await using var browser =
            await playwright.Chromium.LaunchAsync(
                new BrowserTypeLaunchOptions
                {
                    Headless = true,
                });

        var page = await browser.NewPageAsync();
        await page.GotoAsync(
            WorkerBaseUrl,
            new PageGotoOptions
            {
                WaitUntil =
                    WaitUntilState.NetworkIdle,
            });

        await Assertions
            .Expect(
                page.GetByRole(
                    AriaRole.Heading,
                    new() { Name = "BKE Worker" }))
            .ToBeVisibleAsync();
        await Assertions
            .Expect(
                page.GetByText(
                    "GitHub-native autonomous engineering",
                    new() { Exact = true }))
            .ToBeVisibleAsync();
        await Assertions
            .Expect(
                page.GetByText(
                    "WAITING_FOR_ENGINEERING_EVENT"))
            .ToBeVisibleAsync();
        await Assertions
            .Expect(
                page.GetByText(
                    "worker-a",
                    new() { Exact = true }))
            .ToBeVisibleAsync();
        await Assertions
            .Expect(
                page.GetByText(
                    "bke-worker:worker-a",
                    new() { Exact = true }))
            .ToBeVisibleAsync();
        await Assertions
            .Expect(
                page.GetByText(
                    "#101 · feat/pr-a",
                    new() { Exact = true }))
            .ToBeVisibleAsync();
        await Assertions
            .Expect(
                page.GetByText(
                    "github",
                    new() { Exact = true }))
            .ToBeVisibleAsync();
        await Assertions
            .Expect(
                page.GetByText(
                    "One worker ↔ one active PR; next wave from current main",
                    new() { Exact = true }))
            .ToBeVisibleAsync();
        await Assertions
            .Expect(
                page.GetByText(
                    "1800 seconds",
                    new() { Exact = true }))
            .ToBeVisibleAsync();

        var initialPromptCount =
            await PromptCount();
        Assert.Equal(1, initialPromptCount);

        await page
            .GetByRole(
                AriaRole.Button,
                new()
                {
                    Name =
                        "Probe ChatGPT Adapter",
                })
            .ClickAsync();

        await Assertions
            .Expect(
                page.GetByText(
                    "ChatGPT adapter compatible. No prompt was sent.",
                    new() { Exact = true }))
            .ToBeVisibleAsync();
        Assert.Equal(
            initialPromptCount,
            await PromptCount());

        await page
            .GetByRole(
                AriaRole.Button,
                new()
                {
                    Name =
                        "Continue Engineering",
                })
            .ClickAsync();

        await Assertions
            .Expect(
                page.GetByText(
                    "Manual autonomous engineering continuation queued.",
                    new() { Exact = true }))
            .ToBeVisibleAsync();

        for (
            var attempt = 0;
            attempt < 30;
            attempt++)
        {
            if (await PromptCount() == 2)
                break;

            await Task.Delay(250);
        }

        Assert.Equal(2, await PromptCount());

        var html = await page.ContentAsync();
        Assert.DoesNotContain(
            "Notion Page",
            html,
            StringComparison.OrdinalIgnoreCase);
        Assert.DoesNotContain(
            "Force Reconcile",
            html,
            StringComparison.OrdinalIgnoreCase);
        Assert.DoesNotContain(
            "phase4-ci-secret",
            html,
            StringComparison.Ordinal);
    }

    private static async Task<int> PromptCount()
    {
        using var client = new HttpClient();
        var state =
            await client
                .GetFromJsonAsync<FixtureState>(
                    $"{FixtureBaseUrl}/admin/state");
        return state?.Prompts?.Length ?? 0;
    }

    private sealed record FixtureState(
        string[] Prompts);
}
