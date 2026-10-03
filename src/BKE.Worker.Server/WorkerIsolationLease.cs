using System.Security.Cryptography;
using System.Text;

namespace BKE.Worker.Server;

public sealed class WorkerIsolationLease : IDisposable
{
    private readonly List<FileStream> _locks;

    private WorkerIsolationLease(
        List<FileStream> locks)
    {
        _locks = locks;
    }

    public static WorkerIsolationLease Empty { get; } =
        new([]);

    public static WorkerIsolationLease Acquire(
        string lockDirectory,
        IEnumerable<KeyValuePair<string, string>>
            resources)
    {
        Directory.CreateDirectory(
            lockDirectory);

        var acquired = new List<FileStream>();
        try
        {
            foreach (var resource in
                     resources
                         .OrderBy(
                             item => item.Key,
                             StringComparer.Ordinal)
                         .ThenBy(
                             item => item.Value,
                             StringComparer.Ordinal))
            {
                if (string.IsNullOrWhiteSpace(
                        resource.Value))
                {
                    continue;
                }

                var lockName =
                    BuildLockName(
                        resource.Key,
                        resource.Value);
                var path =
                    Path.Combine(
                        lockDirectory,
                        lockName + ".lock");

                try
                {
                    acquired.Add(
                        new FileStream(
                            path,
                            FileMode.OpenOrCreate,
                            FileAccess.ReadWrite,
                            FileShare.None));
                }
                catch (IOException ex)
                {
                    throw new InvalidOperationException(
                        $"WORKER_RESOURCE_IN_USE:{resource.Key}",
                        ex);
                }
            }

            return new WorkerIsolationLease(
                acquired);
        }
        catch
        {
            foreach (var stream in acquired)
                stream.Dispose();
            throw;
        }
    }

    private static string BuildLockName(
        string kind,
        string value)
    {
        var bytes =
            Encoding.UTF8.GetBytes(
                kind + "\n" + value);
        var digest =
            Convert.ToHexString(
                    SHA256.HashData(bytes))
                .ToLowerInvariant();
        return kind + "-" + digest;
    }

    public void Dispose()
    {
        for (
            var index = _locks.Count - 1;
            index >= 0;
            index--)
        {
            _locks[index].Dispose();
        }
    }
}
