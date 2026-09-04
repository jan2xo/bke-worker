using System.Diagnostics;
using System.Net;
using System.Text.Json;

public enum ChatGptAuthorizationState
{
    UNKNOWN,
    LOGIN_REQUIRED,
    LOGIN_IN_PROGRESS,
    AUTHORIZED
}

public sealed record ChatGptBrowserStatus(
    bool Running,
    bool CdpReady,
    bool WorkerOwned,
    ChatGptAuthorizationState Authorization,
    bool ProfileExists,
    string Message);

public sealed class ChatGptBrowserRuntime(WorkerServerSettings settings) : IDisposable
{
    private readonly SemaphoreSlim _mutex = new(1, 1);
    private readonly HttpClient _http = new() { Timeout = TimeSpan.FromSeconds(2) };
    private Process? _process;
    private ChatGptAuthorizationState _authorization = ChatGptAuthorizationState.UNKNOWN;

    public ChatGptAuthorizationState Authorization => _authorization;

    public async Task<ChatGptBrowserStatus> GetStatus(CancellationToken cancellationToken)
    {
        var cdpReady = await IsCdpReady(cancellationToken);
        var running = cdpReady || (_process is { HasExited: false });
        if (!running && _authorization != ChatGptAuthorizationState.LOGIN_REQUIRED)
            _authorization = ChatGptAuthorizationState.UNKNOWN;

        return new ChatGptBrowserStatus(
            running,
            cdpReady,
            WorkerOwned: _process is { HasExited: false },
            _authorization,
            Directory.Exists(settings.ChatGptProfileDirectory),
            running ? (cdpReady ? "CHATGPT_BROWSER_CDP_READY" : "CHATGPT_BROWSER_STARTING") : "CHATGPT_BROWSER_STOPPED");
    }

    public async Task<ChatGptBrowserStatus> Start(CancellationToken cancellationToken)
    {
        await _mutex.WaitAsync(cancellationToken);
        try
        {
            if (await IsCdpReady(cancellationToken))
                return await GetStatus(cancellationToken);

            if (_process is { HasExited: false })
            {
                await WaitForCdp(cancellationToken);
                return await GetStatus(cancellationToken);
            }

            var endpoint = GetCdpUri();
            if (!string.Equals(endpoint.Scheme, Uri.UriSchemeHttp, StringComparison.OrdinalIgnoreCase))
                throw new InvalidOperationException("CHATGPT_BROWSER_LAUNCH_REQUIRES_HTTP_CDP");

            var executable = ResolveChromiumExecutable();
            Directory.CreateDirectory(settings.ChatGptProfileDirectory);

            var startInfo = new ProcessStartInfo
            {
                FileName = executable,
                UseShellExecute = false,
                RedirectStandardOutput = false,
                RedirectStandardError = false,
                CreateNoWindow = false
            };
            startInfo.ArgumentList.Add($"--remote-debugging-address={endpoint.Host}");
            startInfo.ArgumentList.Add($"--remote-debugging-port={endpoint.Port}");
            startInfo.ArgumentList.Add($"--user-data-dir={settings.ChatGptProfileDirectory}");
            startInfo.ArgumentList.Add("--no-first-run");
            startInfo.ArgumentList.Add("--no-default-browser-check");
            startInfo.ArgumentList.Add("--disable-dev-shm-usage");
            startInfo.ArgumentList.Add(settings.ChatGptBaseUrl);

            _process = Process.Start(startInfo)
                ?? throw new InvalidOperationException("CHATGPT_BROWSER_PROCESS_START_FAILED");
            _authorization = ChatGptAuthorizationState.UNKNOWN;
            await WaitForCdp(cancellationToken);
            return await GetStatus(cancellationToken);
        }
        finally
        {
            _mutex.Release();
        }
    }

    public async Task<ChatGptBrowserStatus> BeginLogin(CancellationToken cancellationToken)
    {
        await Start(cancellationToken);
        _authorization = ChatGptAuthorizationState.LOGIN_IN_PROGRESS;
        return await GetStatus(cancellationToken);
    }

    public void MarkAuthorized() => _authorization = ChatGptAuthorizationState.AUTHORIZED;
    public void MarkLoginRequired() => _authorization = ChatGptAuthorizationState.LOGIN_REQUIRED;

    public async Task<ChatGptBrowserStatus> ClearProfile(CancellationToken cancellationToken)
    {
        await _mutex.WaitAsync(cancellationToken);
        try
        {
            if (await IsCdpReady(cancellationToken) && _process is not { HasExited: false })
                throw new InvalidOperationException("CHATGPT_BROWSER_EXTERNALLY_OWNED");

            await StopOwnedProcess(cancellationToken);
            if (await IsCdpReady(cancellationToken))
                throw new InvalidOperationException("CHATGPT_BROWSER_STILL_RUNNING");

            if (Directory.Exists(settings.ChatGptProfileDirectory))
                Directory.Delete(settings.ChatGptProfileDirectory, recursive: true);

            _authorization = ChatGptAuthorizationState.LOGIN_REQUIRED;
            return await GetStatus(cancellationToken);
        }
        finally
        {
            _mutex.Release();
        }
    }

    private async Task StopOwnedProcess(CancellationToken cancellationToken)
    {
        if (_process is null)
            return;

        try
        {
            if (!_process.HasExited)
            {
                _process.Kill(entireProcessTree: true);
                await _process.WaitForExitAsync(cancellationToken);
            }
        }
        finally
        {
            _process.Dispose();
            _process = null;
        }
    }

    private async Task WaitForCdp(CancellationToken cancellationToken)
    {
        for (var attempt = 0; attempt < 30; attempt++)
        {
            if (await IsCdpReady(cancellationToken))
                return;
            if (_process is { HasExited: true })
                throw new InvalidOperationException($"CHATGPT_BROWSER_EXITED:{_process.ExitCode}");
            await Task.Delay(250, cancellationToken);
        }

        throw new InvalidOperationException("CHATGPT_BROWSER_CDP_START_TIMEOUT");
    }

    private async Task<bool> IsCdpReady(CancellationToken cancellationToken)
    {
        try
        {
            using var response = await _http.GetAsync(new Uri(GetCdpUri(), "/json/version"), cancellationToken);
            if (!response.IsSuccessStatusCode)
                return false;
            var payload = await response.Content.ReadAsStringAsync(cancellationToken);
            using var document = JsonDocument.Parse(payload);
            return document.RootElement.TryGetProperty("webSocketDebuggerUrl", out var websocket) &&
                IsLoopbackWebSocket(websocket.GetString());
        }
        catch (Exception ex) when (ex is HttpRequestException or TaskCanceledException or JsonException)
        {
            return false;
        }
    }

    private Uri GetCdpUri()
    {
        if (!Uri.TryCreate(settings.BrowserCdpEndpoint, UriKind.Absolute, out var endpoint) || !endpoint.IsLoopback)
            throw new InvalidOperationException("BROWSER_CDP_ENDPOINT_MUST_BE_LOOPBACK");
        return endpoint;
    }

    private static bool IsLoopbackWebSocket(string? value)
    {
        if (!Uri.TryCreate(value, UriKind.Absolute, out var uri) ||
            !string.Equals(uri.Scheme, "ws", StringComparison.OrdinalIgnoreCase))
            return false;

        return IPAddress.TryParse(uri.Host.Trim('[', ']'), out var address)
            ? IPAddress.IsLoopback(address)
            : string.Equals(uri.Host, "localhost", StringComparison.OrdinalIgnoreCase);
    }

    private static string ResolveChromiumExecutable()
    {
        var candidates = new[] { "chromium", "chromium-browser", "google-chrome", "google-chrome-stable" };
        var path = Environment.GetEnvironmentVariable("PATH") ?? string.Empty;
        foreach (var candidate in candidates)
        {
            foreach (var directory in path.Split(Path.PathSeparator, StringSplitOptions.RemoveEmptyEntries))
            {
                var fullPath = Path.Combine(directory, candidate);
                if (File.Exists(fullPath))
                    return fullPath;
            }
        }

        throw new InvalidOperationException("CHATGPT_BROWSER_EXECUTABLE_NOT_FOUND");
    }

    public void Dispose()
    {
        _http.Dispose();
        _process?.Dispose();
        _mutex.Dispose();
    }
}
