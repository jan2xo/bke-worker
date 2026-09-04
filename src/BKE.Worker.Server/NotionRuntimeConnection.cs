using System.Net.Http.Headers;
using BKE.Worker.Notion;

public sealed record NotionConnectRequest(string Secret);

public sealed class NotionRuntimeConnection : INotionChecklistClient, IDisposable
{
    private readonly object _gate = new();
    private readonly Uri _baseAddress;
    private NotionChecklistClient? _client;
    private HttpClient? _checklistHttp;
    private HttpClient? _pageHttp;

    public NotionRuntimeConnection(string baseUrl)
    {
        _baseAddress = new Uri(baseUrl, UriKind.Absolute);
    }

    public bool IsConnected
    {
        get
        {
            lock (_gate)
                return _client is not null;
        }
    }

    public async Task Connect(string secret, CancellationToken cancellationToken)
    {
        if (string.IsNullOrWhiteSpace(secret))
            throw new InvalidOperationException("NOTION_SECRET_REQUIRED");

        var checklistHttp = new HttpClient();
        var client = new NotionChecklistClient(checklistHttp, secret.Trim(), _baseAddress);
        var pageHttp = CreatePageHttp(secret.Trim());

        try
        {
            // Validate the secret before replacing the currently active in-memory connection.
            _ = await client.GetSharedPages(cancellationToken);
        }
        catch
        {
            checklistHttp.Dispose();
            pageHttp.Dispose();
            throw;
        }

        HttpClient? oldChecklist;
        HttpClient? oldPage;
        lock (_gate)
        {
            oldChecklist = _checklistHttp;
            oldPage = _pageHttp;
            _checklistHttp = checklistHttp;
            _pageHttp = pageHttp;
            _client = client;
        }

        oldChecklist?.Dispose();
        oldPage?.Dispose();
    }

    public void Disconnect()
    {
        HttpClient? checklist;
        HttpClient? page;
        lock (_gate)
        {
            checklist = _checklistHttp;
            page = _pageHttp;
            _checklistHttp = null;
            _pageHttp = null;
            _client = null;
        }

        checklist?.Dispose();
        page?.Dispose();
    }

    public Task<IReadOnlyList<NotionPageSummary>> GetSharedPages(CancellationToken cancellationToken) =>
        RequireClient().GetSharedPages(cancellationToken);

    public Task<IReadOnlyList<NotionChecklistTask>> GetTasks(
        string pageIdOrUrl,
        bool includeChecked,
        CancellationToken cancellationToken) =>
        RequireClient().GetTasks(pageIdOrUrl, includeChecked, cancellationToken);

    public Task<NotionChecklistTask?> GetTask(string blockId, CancellationToken cancellationToken) =>
        RequireClient().GetTask(blockId, cancellationToken);

    public Task<IReadOnlyList<NotionInstructionTemplate>> GetInstructionTemplates(
        string pageIdOrUrl,
        CancellationToken cancellationToken) =>
        RequireClient().GetInstructionTemplates(pageIdOrUrl, cancellationToken);

    public Task<NotionExecutionTarget> GetExecutionTarget(
        string pageIdOrUrl,
        CancellationToken cancellationToken) =>
        RequireClient().GetExecutionTarget(pageIdOrUrl, cancellationToken);

    public async Task<HttpResponseMessage> GetPage(string normalizedPageId, CancellationToken cancellationToken)
    {
        HttpClient pageHttp;
        lock (_gate)
            pageHttp = _pageHttp ?? throw new InvalidOperationException("NOTION_NOT_CONNECTED");

        return await pageHttp.GetAsync(
            $"v1/pages/{Uri.EscapeDataString(normalizedPageId)}",
            cancellationToken);
    }

    public void Dispose() => Disconnect();

    private NotionChecklistClient RequireClient()
    {
        lock (_gate)
            return _client ?? throw new InvalidOperationException("NOTION_NOT_CONNECTED");
    }

    private HttpClient CreatePageHttp(string secret)
    {
        var http = new HttpClient { BaseAddress = _baseAddress };
        http.DefaultRequestHeaders.Authorization = new AuthenticationHeaderValue("Bearer", secret);
        http.DefaultRequestHeaders.Add("Notion-Version", NotionChecklistClient.ApiVersion);
        return http;
    }
}
