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

    [Fact]
    public async Task GetTask_ReadsOneExactTodoBlockById()
    {
        const string response = """
        {
          "object":"block",
          "id":"aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
          "type":"to_do",
          "has_children":false,
          "to_do":{
            "checked":true,
            "rich_text":[{"plain_text":"Exact watched task"}]
          }
        }
        """;

        HttpRequestMessage? observed = null;
        using var http = new HttpClient(new StubHandler(request =>
        {
            observed = request;
            return Json(response);
        }));
        var client = new NotionChecklistClient(http, "test-token");

        var task = await client.GetTask(
            "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
            CancellationToken.None);

        Assert.NotNull(task);
        Assert.Equal("aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa", task!.BlockId);
        Assert.Equal("Exact watched task", task.Text);
        Assert.True(task.Checked);
        Assert.Equal(
            "/v1/blocks/aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
            observed?.RequestUri?.AbsolutePath);
    }

    [Fact]
    public async Task GetInstructionTemplates_ReadsMatchingTablesOnSamePageAndDoesNotCrossChildPages()
    {
        const string pageResponse = """
        {
          "object":"list",
          "results":[
            {
              "object":"block",
              "id":"aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
              "type":"table",
              "has_children":true,
              "table":{"table_width":3,"has_column_header":true,"has_row_header":false}
            },
            {
              "object":"block",
              "id":"bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb",
              "type":"child_page",
              "has_children":true,
              "child_page":{"title":"Must not be traversed"}
            }
          ],
          "has_more":false,
          "next_cursor":null
        }
        """;

        const string tableResponse = """
        {
          "object":"list",
          "results":[
            {
              "object":"block",
              "id":"cccccccc-cccc-cccc-cccc-cccccccccccc",
              "type":"table_row",
              "has_children":false,
              "table_row":{"cells":[
                [{"plain_text":"KEY"}],
                [{"plain_text":"NAME"}],
                [{"plain_text":"INSTRUCTION"}]
              ]}
            },
            {
              "object":"block",
              "id":"dddddddd-dddd-dddd-dddd-dddddddddddd",
              "type":"table_row",
              "has_children":false,
              "table_row":{"cells":[
                [{"plain_text":"engineering"}],
                [{"plain_text":"Engineering Canonical"}],
                [{"plain_text":"Establish canonical project reality first. Do not merge without owner authorization."}]
              ]}
            }
          ],
          "has_more":false,
          "next_cursor":null
        }
        """;

        var requestedPaths = new List<string>();
        using var http = new HttpClient(new StubHandler(request =>
        {
            var path = request.RequestUri?.AbsolutePath ?? string.Empty;
            requestedPaths.Add(path);
            if (path.Contains("aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa", StringComparison.Ordinal))
                return Json(tableResponse);
            if (path.Contains("bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb", StringComparison.Ordinal))
                throw new Xunit.Sdk.XunitException("Instruction discovery crossed into a child page.");
            return Json(pageResponse);
        }));
        var client = new NotionChecklistClient(http, "test-token");

        var templates = await client.GetInstructionTemplates(
            "3cc9faa6ec14810e9031e0ae22360e96",
            CancellationToken.None);

        var template = Assert.Single(templates);
        Assert.Equal("engineering", template.Key);
        Assert.Equal("Engineering Canonical", template.Name);
        Assert.Contains("canonical project reality", template.Instruction, StringComparison.Ordinal);
        Assert.DoesNotContain(requestedPaths, path => path.Contains("bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb", StringComparison.Ordinal));
    }

    [Fact]
    public async Task GetExecutionTarget_ReadsCanonicalTargetCallout()
    {
        const string response = """
        {
          "object":"list",
          "results":[
            {
              "object":"block",
              "id":"aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
              "type":"callout",
              "has_children":false,
              "callout":{
                "rich_text":[{
                  "plain_text":"[BKE WORKER TARGET]\nPROJECT=BKE Worker\nCHAT=Worker Engineering\nOVERRIDE_URL="
                }]
              }
            }
          ],
          "has_more":false,
          "next_cursor":null
        }
        """;

        using var http = new HttpClient(new StubHandler(_ => Json(response)));
        var client = new NotionChecklistClient(http, "test-token");

        var target = await client.GetExecutionTarget(
            "3cc9faa6ec14810e9031e0ae22360e96",
            CancellationToken.None);

        Assert.Equal("BKE Worker", target.Project);
        Assert.Equal("Worker Engineering", target.Chat);
        Assert.Null(target.OverrideUrl);
    }

    [Fact]
    public async Task GetExecutionTarget_WithoutTargetBlock_SelectsImplicitNewChatMetadata()
    {
        const string response = """
        {
          "object":"list",
          "results":[],
          "has_more":false,
          "next_cursor":null
        }
        """;

        using var http = new HttpClient(new StubHandler(_ => Json(response)));
        var client = new NotionChecklistClient(http, "test-token");

        var target = await client.GetExecutionTarget(
            "3cc9faa6ec14810e9031e0ae22360e96",
            CancellationToken.None);

        Assert.Equal(string.Empty, target.Project);
        Assert.Equal(string.Empty, target.Chat);
        Assert.Null(target.OverrideUrl);
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
