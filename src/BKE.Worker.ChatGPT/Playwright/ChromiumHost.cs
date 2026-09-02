using Microsoft.Playwright;

namespace BKE.Worker.ChatGPT.Playwright;

public sealed record ChromiumHostOptions(
    string ProfileDirectory,
    bool Headless = true,
    string ChatGptBaseUrl = "https://chatgpt.com/");

public sealed class ChromiumHost(ChromiumHostOptions options) : IAsyncDisposable
{
    private readonly SemaphoreSlim _mutex = new(1, 1);
    private IPlaywright? _playwright;
    private IBrowserContext? _context;
    private IPage? _page;

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

    private async Task LaunchUnsafe(CancellationToken cancellationToken)
    {
        cancellationToken.ThrowIfCancellationRequested();
        Directory.CreateDirectory(Options.ProfileDirectory);

        _playwright ??= await Microsoft.Playwright.Playwright.CreateAsync();
        _context = await _playwright.Chromium.LaunchPersistentContextAsync(
            Options.ProfileDirectory,
            new BrowserTypeLaunchPersistentContextOptions
            {
                Headless = Options.Headless,
                Args = ["--disable-dev-shm-usage"]
            });

        _page = _context.Pages.FirstOrDefault() ?? await _context.NewPageAsync();
    }

    private async Task CloseUnsafe()
    {
        _page = null;
        if (_context is not null)
        {
            try
            {
                await _context.CloseAsync();
            }
            catch (PlaywrightException)
            {
                // The browser may already be disconnected. The persistent profile remains intact.
            }
            _context = null;
        }

        _playwright?.Dispose();
        _playwright = null;
    }

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
