global using Xunit;
using System.Net;
using BKE.Worker.Notion;

namespace BKE.Worker.Notion.Tests;

public sealed class NotionChecklistClientTests
{
    [Theory]
    [InlineData("3cc9faa6ec14810e9031e0ae22360e96")]
    [InlineData("3cc9faa6-ec14-810e-9031-e0ae22360e96")]
    [InlineData("https://app.notion.com/p/3cc9faa6ec14810e9031e0ae22360e96?pvs=204")]
    [InlineData("https://example.notion.site/Execution-Checklist-3cc9faa6ec14810e9031e0ae22360e96")]
    public void NormalizeNotionId_AcceptsSupportedShapes(string input)
    {
        Assert.Equal(
            "3cc9faa6-ec14-810e-9031-e0ae22360e96",
            NotionChecklistClient.NormalizeNotionId(input));
    }

    [Fact]
    public async Task GetSharedPages_ReturnsPageTitles()
    {
        const string response = """
        {
          "object":"list",
          "results":[
            {
              "object":"page",
              "id":"3cc9faa6-ec14-810e-9031-e0ae22360e96",
              "url":"https://www.notion.so/3cc9faa6ec14810e9031e0ae22360e96",
              "properties":{
                "Name":{
                  "type":"title",
                  "title":[{"plain_text":"Digital Solutions V2 — Orchestrator Execution Checklist"}]
                }
              }
            }
          ],
          "has_more":false,
          "next_cursor":null
        }
        """;

        using var http = new HttpClient(new StubHandler(_ => Json(response)));
        var client = new NotionChecklistClient(http, "test-token");

        var pages = await client.GetSharedPages(CancellationToken.None);

        var page = Assert.Single(pages);
        Assert.Equal("3cc9faa6-ec14-810e-9031-e0ae22360e96", page.PageId);
        Assert.Equal("Digital Solutions V2 — Orchestrator Execution Checklist", page.Title);
    }

    [Fact]
    public async Task GetTasks_ReturnsUncheckedTodosIncludingNestedContainers()
    {
        const string rootResponse = """
        {
          "object":"list",
          "results":[
            {
              "object":"block",
              "id":"aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
              "type":"to_do",
              "has_children":false,
              "to_do":{
                "checked":false,
                "rich_text":[{"plain_text":"First open task"}]
              }
            },
            {
              "object":"block",
              "id":"bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb",
              "type":"to_do",
              "has_children":false,
              "to_do":{
                "checked":true,
                "rich_text":[{"plain_text":"Already done"}]
              }
            },
            {
              "object":"block",
              "id":"cccccccc-cccc-cccc-cccc-cccccccccccc",
              "type":"toggle",
              "has_children":true,
              "toggle":{"rich_text":[{"plain_text":"Nested work"}]}
            }
          ],
          "has_more":false,
          "next_cursor":null
        }
        """;

        const string nestedResponse = """
        {
          "object":"list",
          "results":[
            {
              "object":"block",
              "id":"dddddddd-dddd-dddd-dddd-dddddddddddd",
              "type":"to_do",
              "has_children":false,
              "to_do":{
                "checked":false,
                "rich_text":[{"plain_text":"Nested open task"}]
              }
            }
          ],
          "has_more":false,
          "next_cursor":null
        }
        """;

        using var http = new HttpClient(new StubHandler(request =>
            request.RequestUri?.AbsolutePath.Contains("cccccccc-cccc-cccc-cccc-cccccccccccc", StringComparison.Ordinal) == true
                ? Json(nestedResponse)
                : Json(rootResponse)));
        var client = new NotionChecklistClient(http, "test-token");

        var tasks = await client.GetTasks(
            "3cc9faa6ec14810e9031e0ae22360e96",
            includeChecked: false,
            CancellationToken.None);

        Assert.Equal(2, tasks.Count);
        Assert.Equal("First open task", tasks[0].Text);
        Assert.Equal("Nested open task", tasks[1].Text);
        Assert.All(tasks, task => Assert.False(task.Checked));
    }

    private static HttpResponseMessage Json(string value) => new(HttpStatusCode.OK)
    {
        Content = new StringContent(value, System.Text.Encoding.UTF8, "application/json")
    };

    private sealed class StubHandler(Func<HttpRequestMessage, HttpResponseMessage> respond) : HttpMessageHandler
    {
        protected override Task<HttpResponseMessage> SendAsync(
            HttpRequestMessage request,
            CancellationToken cancellationToken) =>
            Task.FromResult(respond(request));
    }
}
