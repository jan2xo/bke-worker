using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using BKE.Worker.Core;
using Microsoft.AspNetCore.Http;

namespace BKE.Worker.GitHub;

public sealed record GitHubWebhookOptions(
    string Secret,
    WorkerIdentity Worker);

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
    public async Task<IResult> Handle(
        HttpRequest request,
        CancellationToken cancellationToken)
    {
        if (string.IsNullOrWhiteSpace(options.Secret) ||
            !options.Worker.IsValid)
        {
            return Results.StatusCode(
                StatusCodes.Status503ServiceUnavailable);
        }

        var eventName =
            request.Headers["X-GitHub-Event"].ToString();
        if (!string.Equals(
                eventName,
                "push",
                StringComparison.Ordinal) &&
            !string.Equals(
                eventName,
                "pull_request",
                StringComparison.Ordinal))
        {
            return Results.Accepted(
                value: new
                {
                    accepted = false,
                    reason = "IGNORED_EVENT",
                });
        }

        var deliveryId =
            request.Headers[
                "X-GitHub-Delivery"].ToString();
        var signature =
            request.Headers[
                "X-Hub-Signature-256"].ToString();

        if (string.IsNullOrWhiteSpace(deliveryId))
        {
            return Results.BadRequest(
                new
                {
                    error =
                        "GITHUB_DELIVERY_REQUIRED",
                });
        }

        await using var buffer = new MemoryStream();
        await request.Body.CopyToAsync(
            buffer,
            cancellationToken);
        var body = buffer.ToArray();
        if (!verifier.Verify(
                body,
                signature,
                options.Secret))
        {
            return Results.Unauthorized();
        }

        try
        {
            using var document =
                JsonDocument.Parse(body);

            return string.Equals(
                    eventName,
                    "push",
                    StringComparison.Ordinal)
                ? await HandlePush(
                    document.RootElement,
                    deliveryId,
                    cancellationToken)
                : await HandlePullRequest(
                    document.RootElement,
                    deliveryId,
                    cancellationToken);
        }
        catch (JsonException)
        {
            return Results.BadRequest(
                new
                {
                    error =
                        "GITHUB_PAYLOAD_INVALID",
                });
        }
    }

    private async Task<IResult> HandlePush(
        JsonElement root,
        string deliveryId,
        CancellationToken cancellationToken)
    {
        if (!root.TryGetProperty(
                "ref",
                out var refElement) ||
            refElement.ValueKind !=
                JsonValueKind.String ||
            string.IsNullOrWhiteSpace(
                refElement.GetString()))
        {
            return Results.BadRequest(
                new
                {
                    error =
                        "GITHUB_PUSH_REF_REQUIRED",
                });
        }

        var gitHubRef = refElement.GetString()!;

        await wakeSink.Enqueue(
            new WorkerWakeEvent(
                WorkerWakeReason.GitHubPush,
                deliveryId,
                DateTimeOffset.UtcNow,
                GitHubRef: gitHubRef),
            cancellationToken);

        return Results.Accepted(
            value: new
            {
                accepted = true,
                delivery = deliveryId,
                routedBy = "active-pr-head-ref",
            });
    }

    private async Task<IResult> HandlePullRequest(
        JsonElement root,
        string deliveryId,
        CancellationToken cancellationToken)
    {
        if (!root.TryGetProperty(
                "pull_request",
                out var pullRequest) ||
            pullRequest.ValueKind !=
                JsonValueKind.Object)
        {
            return Results.BadRequest(
                new
                {
                    error =
                        "GITHUB_PULL_REQUEST_REQUIRED",
                });
        }

        var number =
            ReadInt(root, "number") ??
            ReadInt(pullRequest, "number");
        if (number is null || number <= 0)
        {
            return Results.BadRequest(
                new
                {
                    error =
                        "GITHUB_PULL_REQUEST_NUMBER_REQUIRED",
                });
        }

        var action =
            ReadString(root, "action") ??
            string.Empty;

        if (string.Equals(
                action,
                "closed",
                StringComparison.Ordinal))
        {
            await wakeSink.Enqueue(
                new WorkerWakeEvent(
                    WorkerWakeReason
                        .AssignmentRevoked,
                    deliveryId,
                    DateTimeOffset.UtcNow,
                    PullRequestNumber: number),
                cancellationToken);

            return Results.Accepted(
                value: new
                {
                    accepted = true,
                    delivery = deliveryId,
                    reason =
                        "PULL_REQUEST_CLOSED",
                });
        }

        if (string.Equals(
                action,
                "unlabeled",
                StringComparison.Ordinal) &&
            root.TryGetProperty(
                "label",
                out var removedLabel) &&
            string.Equals(
                ReadString(
                    removedLabel,
                    "name"),
                options.Worker.AssignmentLabel,
                StringComparison.OrdinalIgnoreCase))
        {
            await wakeSink.Enqueue(
                new WorkerWakeEvent(
                    WorkerWakeReason
                        .AssignmentRevoked,
                    deliveryId,
                    DateTimeOffset.UtcNow,
                    PullRequestNumber: number),
                cancellationToken);

            return Results.Accepted(
                value: new
                {
                    accepted = true,
                    delivery = deliveryId,
                    reason =
                        "WORKER_ASSIGNMENT_REMOVED",
                });
        }

        var workerLabels =
            ReadLabels(pullRequest)
                .Where(label =>
                    label.StartsWith(
                        WorkerIdentity
                            .AssignmentLabelPrefix,
                        StringComparison
                            .OrdinalIgnoreCase))
                .Distinct(
                    StringComparer
                        .OrdinalIgnoreCase)
                .ToArray();

        if (workerLabels.Length > 1)
        {
            if (workerLabels.Contains(
                    options.Worker.AssignmentLabel,
                    StringComparer.OrdinalIgnoreCase))
            {
                await wakeSink.Enqueue(
                    new WorkerWakeEvent(
                        WorkerWakeReason
                            .AssignmentConflict,
                        deliveryId,
                        DateTimeOffset.UtcNow,
                        PullRequestNumber: number),
                    cancellationToken);
            }

            return Results.Conflict(
                new
                {
                    error =
                        "AMBIGUOUS_PR_ASSIGNMENT",
                    pullRequest = number,
                    labels = workerLabels,
                });
        }

        if (workerLabels.Length == 0)
        {
            return Results.Accepted(
                value: new
                {
                    accepted = false,
                    delivery = deliveryId,
                    reason =
                        "UNASSIGNED_PULL_REQUEST",
                    pullRequest = number,
                });
        }

        if (!string.Equals(
                workerLabels[0],
                options.Worker.AssignmentLabel,
                StringComparison.OrdinalIgnoreCase))
        {
            return Results.Accepted(
                value: new
                {
                    accepted = false,
                    delivery = deliveryId,
                    reason =
                        "ASSIGNED_TO_OTHER_WORKER",
                    pullRequest = number,
                });
        }

        var state =
            ReadString(
                pullRequest,
                "state");
        if (!string.Equals(
                state,
                "open",
                StringComparison.OrdinalIgnoreCase))
        {
            return Results.Accepted(
                value: new
                {
                    accepted = false,
                    delivery = deliveryId,
                    reason =
                        "PULL_REQUEST_NOT_OPEN",
                    pullRequest = number,
                });
        }

        if (!pullRequest.TryGetProperty(
                "head",
                out var head) ||
            head.ValueKind !=
                JsonValueKind.Object)
        {
            return Results.BadRequest(
                new
                {
                    error =
                        "GITHUB_PULL_REQUEST_HEAD_REQUIRED",
                });
        }

        var headRef =
            ReadString(head, "ref");
        var headSha =
            ReadString(head, "sha");
        var assignment =
            new PullRequestAssignment(
                number.Value,
                headRef ?? string.Empty,
                headSha ?? string.Empty);

        if (!assignment.IsValid)
        {
            return Results.BadRequest(
                new
                {
                    error =
                        "GITHUB_PULL_REQUEST_HEAD_INVALID",
                });
        }

        await wakeSink.Enqueue(
            new WorkerWakeEvent(
                WorkerWakeReason
                    .GitHubPullRequest,
                deliveryId,
                DateTimeOffset.UtcNow,
                Assignment: assignment,
                PullRequestNumber: number),
            cancellationToken);

        return Results.Accepted(
            value: new
            {
                accepted = true,
                delivery = deliveryId,
                pullRequest = number,
                workerId = options.Worker.Id,
            });
    }

    private static IReadOnlyList<string> ReadLabels(
        JsonElement pullRequest)
    {
        if (!pullRequest.TryGetProperty(
                "labels",
                out var labels) ||
            labels.ValueKind !=
                JsonValueKind.Array)
        {
            return [];
        }

        var result = new List<string>();
        foreach (var label in
                 labels.EnumerateArray())
        {
            var name =
                ReadString(label, "name");
            if (!string.IsNullOrWhiteSpace(name))
                result.Add(name);
        }

        return result;
    }

    private static string? ReadString(
        JsonElement element,
        string propertyName) =>
        element.TryGetProperty(
            propertyName,
            out var value) &&
        value.ValueKind ==
            JsonValueKind.String
            ? value.GetString()
            : null;

    private static int? ReadInt(
        JsonElement element,
        string propertyName) =>
        element.TryGetProperty(
            propertyName,
            out var value) &&
        value.TryGetInt32(
            out var parsed)
            ? parsed
            : null;
}
