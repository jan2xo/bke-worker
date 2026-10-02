using System.Net.Http.Headers;
using System.Text;
using System.Text.Json;

namespace BKE.Worker.Notion;

public sealed record NotionPageSummary(string PageId, string Title, string? Url);

public sealed record NotionChecklistTask(
    string BlockId,
    string Text,
    bool Checked,
    bool HasChildren);

public sealed record NotionExecutionTarget(
    string Project,
    string Chat,
    string? OverrideUrl);

public interface INotionChecklistClient
{
    Task<IReadOnlyList<NotionPageSummary>> GetSharedPages(CancellationToken cancellationToken);

    Task<IReadOnlyList<NotionChecklistTask>> GetTasks(
        string pageIdOrUrl,
        bool includeChecked,
        CancellationToken cancellationToken);

    Task<NotionExecutionTarget> GetExecutionTarget(
        string pageIdOrUrl,
        CancellationToken cancellationToken);
}

public sealed class NotionChecklistClient : INotionChecklistClient
{
    public const string ApiVersion = "2026-03-11";
    public const string TargetHeader = "[BKE WORKER TARGET]";

    private readonly HttpClient _http;

    public NotionChecklistClient(HttpClient http, string accessToken, Uri? baseAddress = null)
    {
        if (string.IsNullOrWhiteSpace(accessToken))
            throw new ArgumentException("A Notion access token is required.", nameof(accessToken));

        _http = http;
        _http.BaseAddress ??= baseAddress ?? new Uri("https://api.notion.com/");
        _http.DefaultRequestHeaders.Authorization = new AuthenticationHeaderValue("Bearer", accessToken.Trim());
        _http.DefaultRequestHeaders.Remove("Notion-Version");
        _http.DefaultRequestHeaders.Add("Notion-Version", ApiVersion);
    }

    public async Task<IReadOnlyList<NotionPageSummary>> GetSharedPages(CancellationToken cancellationToken)
    {
        var pages = new List<NotionPageSummary>();
        string? cursor = null;

        do
        {
            var request = new Dictionary<string, object?>
            {
                ["page_size"] = 100,
                ["filter"] = new Dictionary<string, string>
                {
                    ["property"] = "object",
                    ["value"] = "page"
                },
                ["sort"] = new Dictionary<string, string>
                {
                    ["direction"] = "descending",
                    ["timestamp"] = "last_edited_time"
                }
            };

            if (!string.IsNullOrWhiteSpace(cursor))
                request["start_cursor"] = cursor;

            using var content = new StringContent(
                JsonSerializer.Serialize(request),
                Encoding.UTF8,
                "application/json");
            using var response = await _http.PostAsync("v1/search", content, cancellationToken);
            var payload = await response.Content.ReadAsStringAsync(cancellationToken);
            if (!response.IsSuccessStatusCode)
                throw new InvalidOperationException($"NOTION_REQUEST_FAILED:{(int)response.StatusCode}");

            using var document = JsonDocument.Parse(payload);
            var root = document.RootElement;
            foreach (var page in root.GetProperty("results").EnumerateArray())
            {
                if (page.TryGetProperty("object", out var objectType)
                    && objectType.GetString() == "page"
                    && page.TryGetProperty("id", out var idProperty))
                {
                    var id = idProperty.GetString() ?? string.Empty;
                    var title = ReadPageTitle(page);
                    var url = page.TryGetProperty("url", out var urlProperty) ? urlProperty.GetString() : null;
                    if (!string.IsNullOrWhiteSpace(id) && !string.IsNullOrWhiteSpace(title))
                        pages.Add(new NotionPageSummary(id, title, url));
                }
            }

            cursor = root.TryGetProperty("has_more", out var hasMore) && hasMore.GetBoolean()
                && root.TryGetProperty("next_cursor", out var nextCursor)
                ? nextCursor.GetString()
                : null;
        }
        while (!string.IsNullOrWhiteSpace(cursor));

        return pages;
    }

    public async Task<IReadOnlyList<NotionChecklistTask>> GetTasks(
        string pageIdOrUrl,
        bool includeChecked,
        CancellationToken cancellationToken)
    {
        var pageId = NormalizeNotionId(pageIdOrUrl);
        var tasks = new List<NotionChecklistTask>();
        await ReadChildren(pageId, includeChecked, tasks, cancellationToken);
        return tasks;
    }

    public async Task<NotionExecutionTarget> GetExecutionTarget(
        string pageIdOrUrl,
        CancellationToken cancellationToken)
    {
        var pageId = NormalizeNotionId(pageIdOrUrl);
        var targetBlocks = new List<string>();
        string? cursor = null;

        do
        {
            var path = $"v1/blocks/{Uri.EscapeDataString(pageId)}/children?page_size=100";
            if (!string.IsNullOrWhiteSpace(cursor))
                path += $"&start_cursor={Uri.EscapeDataString(cursor)}";

            using var response = await _http.GetAsync(path, cancellationToken);
            var payload = await response.Content.ReadAsStringAsync(cancellationToken);
            if (!response.IsSuccessStatusCode)
                throw new InvalidOperationException($"NOTION_REQUEST_FAILED:{(int)response.StatusCode}");

            using var document = JsonDocument.Parse(payload);
            var root = document.RootElement;
            foreach (var block in root.GetProperty("results").EnumerateArray())
            {
                if (!block.TryGetProperty("type", out var typeProperty))
                    continue;

                var type = typeProperty.GetString();
                if (type is not ("callout" or "paragraph" or "code"))
                    continue;
                if (!block.TryGetProperty(type!, out var body))
                    continue;

                var text = ReadPlainText(body).Trim();
                if (text.StartsWith(TargetHeader, StringComparison.Ordinal))
                    targetBlocks.Add(text);
            }

            cursor = root.TryGetProperty("has_more", out var hasMore) && hasMore.GetBoolean()
                && root.TryGetProperty("next_cursor", out var nextCursor)
                ? nextCursor.GetString()
                : null;
        }
        while (!string.IsNullOrWhiteSpace(cursor));

        if (targetBlocks.Count == 0)
            return new NotionExecutionTarget(string.Empty, string.Empty, null);
        if (targetBlocks.Count > 1)
            throw new InvalidOperationException("NOTION_TARGET_BLOCK_AMBIGUOUS");

        return ParseExecutionTarget(targetBlocks[0]);
    }

    private async Task ReadChildren(
        string blockId,
        bool includeChecked,
        ICollection<NotionChecklistTask> tasks,
        CancellationToken cancellationToken)
    {
        string? cursor = null;

        do
        {
            var path = $"v1/blocks/{Uri.EscapeDataString(blockId)}/children?page_size=100";
            if (!string.IsNullOrWhiteSpace(cursor))
                path += $"&start_cursor={Uri.EscapeDataString(cursor)}";

            using var response = await _http.GetAsync(path, cancellationToken);
            var payload = await response.Content.ReadAsStringAsync(cancellationToken);
            if (!response.IsSuccessStatusCode)
                throw new InvalidOperationException($"NOTION_REQUEST_FAILED:{(int)response.StatusCode}");

            using var document = JsonDocument.Parse(payload);
            var root = document.RootElement;

            foreach (var block in root.GetProperty("results").EnumerateArray())
            {
                var id = block.GetProperty("id").GetString() ?? string.Empty;
                var type = block.GetProperty("type").GetString();
                var hasChildren = block.TryGetProperty("has_children", out var childFlag) && childFlag.GetBoolean();

                if (type == "to_do" && block.TryGetProperty("to_do", out var todo))
                {
                    var isChecked = todo.TryGetProperty("checked", out var checkedProperty) && checkedProperty.GetBoolean();
                    if (includeChecked || !isChecked)
                    {
                        var text = ReadPlainText(todo);
                        if (!string.IsNullOrWhiteSpace(text))
                            tasks.Add(new NotionChecklistTask(id, text, isChecked, hasChildren));
                    }
                }

                var isNestedPageOrDatabase = type is "child_page" or "child_database";
                if (hasChildren && !isNestedPageOrDatabase && !string.IsNullOrWhiteSpace(id))
                    await ReadChildren(id, includeChecked, tasks, cancellationToken);
            }

            cursor = root.TryGetProperty("has_more", out var hasMore) && hasMore.GetBoolean()
                && root.TryGetProperty("next_cursor", out var nextCursor)
                ? nextCursor.GetString()
                : null;
        }
        while (!string.IsNullOrWhiteSpace(cursor));
    }

    private static NotionExecutionTarget ParseExecutionTarget(string text)
    {
        var normalized = text.Replace("\r\n", "\n", StringComparison.Ordinal);
        var lines = normalized.Split('\n');
        if (lines.Length == 0 || !string.Equals(lines[0].Trim(), TargetHeader, StringComparison.Ordinal))
            throw new InvalidOperationException("NOTION_TARGET_BLOCK_INVALID");

        var values = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
        for (var index = 1; index < lines.Length; index++)
        {
            var line = lines[index].Trim();
            if (line.Length == 0)
                continue;

            var separator = line.IndexOf('=');
            if (separator <= 0)
                throw new InvalidOperationException("NOTION_TARGET_BLOCK_INVALID");

            var key = line[..separator].Trim();
            var value = line[(separator + 1)..].Trim();
            if (key is not ("PROJECT" or "CHAT" or "OVERRIDE_URL"))
                throw new InvalidOperationException("NOTION_TARGET_BLOCK_INVALID");
            if (!values.TryAdd(key, value))
                throw new InvalidOperationException("NOTION_TARGET_BLOCK_INVALID");
        }

        values.TryGetValue("PROJECT", out var project);
        values.TryGetValue("CHAT", out var chat);
        values.TryGetValue("OVERRIDE_URL", out var overrideUrl);

        return new NotionExecutionTarget(
            project ?? string.Empty,
            chat ?? string.Empty,
            string.IsNullOrWhiteSpace(overrideUrl) ? null : overrideUrl);
    }

    private static string ReadPageTitle(JsonElement page)
    {
        if (!page.TryGetProperty("properties", out var properties))
            return string.Empty;

        foreach (var property in properties.EnumerateObject())
        {
            var value = property.Value;
            if (!value.TryGetProperty("type", out var type) || type.GetString() != "title")
                continue;
            if (!value.TryGetProperty("title", out var titleItems))
                continue;

            return string.Concat(
                titleItems.EnumerateArray()
                    .Select(item => item.TryGetProperty("plain_text", out var text) ? text.GetString() : null)
                    .Where(text => !string.IsNullOrEmpty(text)));
        }

        return string.Empty;
    }

    private static string ReadPlainText(JsonElement blockType)
    {
        if (!blockType.TryGetProperty("rich_text", out var richText))
            return string.Empty;

        return string.Concat(
            richText.EnumerateArray()
                .Select(item => item.TryGetProperty("plain_text", out var text) ? text.GetString() : null)
                .Where(value => !string.IsNullOrEmpty(value)));
    }

    public static string NormalizeNotionId(string pageIdOrUrl)
    {
        if (string.IsNullOrWhiteSpace(pageIdOrUrl))
            throw new ArgumentException("A Notion page ID or URL is required.", nameof(pageIdOrUrl));

        var candidate = pageIdOrUrl.Trim();
        if (Uri.TryCreate(candidate, UriKind.Absolute, out var uri))
            candidate = uri.AbsolutePath.Trim('/').Split('/').LastOrDefault() ?? string.Empty;

        candidate = new string(candidate.Where(Uri.IsHexDigit).ToArray());
        if (candidate.Length > 32)
            candidate = candidate[^32..];

        if (candidate.Length != 32)
            throw new ArgumentException("Notion page ID must contain exactly 32 hexadecimal characters.", nameof(pageIdOrUrl));

        return $"{candidate[..8]}-{candidate[8..12]}-{candidate[12..16]}-{candidate[16..20]}-{candidate[20..]}";
    }
}
