using Microsoft.Playwright;

namespace BKE.Worker.ChatGPT.Playwright;

public sealed record ChromiumHostOptions(
    string ProfileDirectory,
    bool Headless = true,
    string ChatGptBaseUrl = "https://chatgpt.com/",
    string? CdpEndpoint = null);

public sealed class ChromiumHost(ChromiumHostOptions options) : IAsyncDisposable
{
    private const string LiveChatGptRequiresCdp = "LIVE_CHATGPT_REQUIRES_CDP_ATTACH";
    private const string CdpMustBeLoopback = "BROWSER_CDP_ENDPOINT_MUST_BE_LOOPBACK";

    private readonly SemaphoreSlim _mutex = new(1, 1);
    private IPlaywright? _playwright;
    private IBrowser? _browser;
    private IBrowserContext? _context;
    private IPage? _page;
    private bool _attachedOverCdp;

    public ChromiumHostOptions Options { get; } = options;

    public async Task<IPage> GetPage(CancellationToken cancellationToken)
    {
        await _mutex.WaitAsync(cancellationToken);
        try
        {
            if (_page is null || _page.IsClosed)
                await LaunchUnsafe(cancellationToken);

            return _page ?? throw new InvalidOperationException("BROWSER_PAGE_UNAVAILABLE");
        }
        finally
        {
            _mutex.Release();
        }
    }

    public async Task Restart(CancellationToken cancellationToken)
    {
        await _mutex.WaitAsync(cancellationToken);
        try
        {
            await CloseUnsafe();
            await LaunchUnsafe(cancellationToken);
        }
        finally
        {
            _mutex.Release();
        }
    }

    public async Task ShutdownBrowser(CancellationToken cancellationToken)
    {
        await _mutex.WaitAsync(cancellationToken);
        try
        {
            cancellationToken.ThrowIfCancellationRequested();
            if (_browser is null && _context is null)
                await LaunchUnsafe(cancellationToken);

            if (_attachedOverCdp && _browser is not null)
            {
                try
                {
                    await _browser.CloseAsync();
                }
                catch (PlaywrightException)
                {
                    // Browser may already be gone; cleanup below still resets the adapter.
                }
            }
            else if (_context is not null)
            {
                try
                {
                    await _context.CloseAsync();
                }
                catch (PlaywrightException)
                {
                    // Browser may already be gone.
                }
            }

            _page = null;
            _browser = null;
            _context = null;
            _attachedOverCdp = false;
            _playwright?.Dispose();
            _playwright = null;
        }
        finally
        {
            _mutex.Release();
        }
    }

    private async Task LaunchUnsafe(CancellationToken cancellationToken)
    {
        cancellationToken.ThrowIfCancellationRequested();
        _playwright ??= await Microsoft.Playwright.Playwright.CreateAsync();

        if (!string.IsNullOrWhiteSpace(Options.CdpEndpoint))
        {
            var cdpEndpoint = new Uri(Options.CdpEndpoint, UriKind.Absolute);
            if (!cdpEndpoint.IsLoopback)
                throw new InvalidOperationException(CdpMustBeLoopback);

            _browser = await _playwright.Chromium.ConnectOverCDPAsync(cdpEndpoint.ToString());
            _context = _browser.Contexts.FirstOrDefault()
                ?? throw new InvalidOperationException("BROWSER_CONTEXT_UNAVAILABLE");
            _attachedOverCdp = true;
        }
        else
        {
            if (IsLiveChatGpt(Options.ChatGptBaseUrl))
                throw new InvalidOperationException(LiveChatGptRequiresCdp);

            Directory.CreateDirectory(Options.ProfileDirectory);
            _context = await _playwright.Chromium.LaunchPersistentContextAsync(
                Options.ProfileDirectory,
                new BrowserTypeLaunchPersistentContextOptions
                {
                    Headless = Options.Headless,
                    Args = ["--disable-dev-shm-usage"]
                });
            _attachedOverCdp = false;
        }

        _page = FindTargetPage(_context.Pages, Options.ChatGptBaseUrl)
            ?? await _context.NewPageAsync();
    }

    private async Task CloseUnsafe()
    {
        _page = null;

        if (_context is not null && !_attachedOverCdp)
        {
            try
            {
                await _context.CloseAsync();
            }
            catch (PlaywrightException)
            {
                // The browser may already be disconnected. The persistent profile remains intact.
            }
        }

        // Normal adapter disposal only disconnects from CDP. Explicit operator Clear / Logout
        // uses ShutdownBrowser when the dedicated BKE Worker browser must actually be closed.
        _browser = null;
        _context = null;
        _attachedOverCdp = false;

        _playwright?.Dispose();
        _playwright = null;
    }

    private static IPage? FindTargetPage(IReadOnlyList<IPage> pages, string baseUrl)
    {
        if (!Uri.TryCreate(baseUrl, UriKind.Absolute, out var target))
            return pages.FirstOrDefault(page => !page.IsClosed);

        return pages.FirstOrDefault(page =>
                   !page.IsClosed &&
                   Uri.TryCreate(page.Url, UriKind.Absolute, out var current) &&
                   string.Equals(current.Scheme, target.Scheme, StringComparison.OrdinalIgnoreCase) &&
                   string.Equals(current.Host, target.Host, StringComparison.OrdinalIgnoreCase) &&
                   current.Port == target.Port)
               ?? pages.FirstOrDefault(page => !page.IsClosed);
    }

    private static bool IsLiveChatGpt(string baseUrl) =>
        Uri.TryCreate(baseUrl, UriKind.Absolute, out var uri) &&
        string.Equals(uri.Host, "chatgpt.com", StringComparison.OrdinalIgnoreCase);

    public async ValueTask DisposeAsync()
    {
        await _mutex.WaitAsync();
        try
        {
            await CloseUnsafe();
        }
        finally
        {
            _mutex.Release();
            _mutex.Dispose();
        }
    }
}
