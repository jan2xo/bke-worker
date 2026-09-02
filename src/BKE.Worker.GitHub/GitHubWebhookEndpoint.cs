using System.Security.Cryptography;
using System.Text;
using BKE.Worker.Core;
using Microsoft.AspNetCore.Http;

namespace BKE.Worker.GitHub;

public sealed record GitHubWebhookOptions(string Secret);

public sealed class GitHubSignatureVerifier
{
    public bool Verify(ReadOnlySpan<byte> body, string? signatureHeader, string secret)
    {
        if (string.IsNullOrWhiteSpace(signatureHeader) || string.IsNullOrWhiteSpace(secret))
            return false;
        if (!signatureHeader.StartsWith("sha256=", StringComparison.OrdinalIgnoreCase))
            return false;

        byte[] supplied;
        try
        {
            supplied = Convert.FromHexString(signatureHeader[7..]);
        }
        catch (FormatException)
        {
            return false;
        }

        using var hmac = new HMACSHA256(Encoding.UTF8.GetBytes(secret));
        var expected = hmac.ComputeHash(body.ToArray());
        return supplied.Length == expected.Length &&
               CryptographicOperations.FixedTimeEquals(supplied, expected);
    }
}

public sealed class GitHubWebhookEndpoint(
    GitHubSignatureVerifier verifier,
    GitHubWebhookOptions options,
    IWorkerWakeSink wakeSink)
{
    public async Task<IResult> Handle(HttpRequest request, CancellationToken cancellationToken)
    {
        if (string.IsNullOrWhiteSpace(options.Secret))
            return Results.StatusCode(StatusCodes.Status503ServiceUnavailable);

        var eventName = request.Headers["X-GitHub-Event"].ToString();
        var deliveryId = request.Headers["X-GitHub-Delivery"].ToString();
        var signature = request.Headers["X-Hub-Signature-256"].ToString();

        if (!string.Equals(eventName, "push", StringComparison.Ordinal))
            return Results.Accepted(value: new { accepted = false, reason = "IGNORED_EVENT" });
        if (string.IsNullOrWhiteSpace(deliveryId))
            return Results.BadRequest(new { error = "GITHUB_DELIVERY_REQUIRED" });

        await using var buffer = new MemoryStream();
        await request.Body.CopyToAsync(buffer, cancellationToken);
        var body = buffer.ToArray();
        if (!verifier.Verify(body, signature, options.Secret))
            return Results.Unauthorized();

        await wakeSink.Enqueue(
            new WorkerWakeEvent(WorkerWakeReason.GitHubPush, deliveryId, DateTimeOffset.UtcNow),
            cancellationToken);

        return Results.Accepted(value: new { accepted = true, delivery = deliveryId });
    }
}
