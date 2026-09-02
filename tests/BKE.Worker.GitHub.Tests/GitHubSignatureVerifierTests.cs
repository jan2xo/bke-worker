global using Xunit;
using System.Security.Cryptography;
using System.Text;

namespace BKE.Worker.GitHub.Tests;

public sealed class GitHubSignatureVerifierTests
{
    [Fact]
    public void Valid_sha256_signature_is_accepted()
    {
        var body = Encoding.UTF8.GetBytes("{\"ref\":\"refs/heads/main\"}");
        const string secret = "test-secret";
        using var hmac = new HMACSHA256(Encoding.UTF8.GetBytes(secret));
        var signature = "sha256=" + Convert.ToHexString(hmac.ComputeHash(body)).ToLowerInvariant();

        Assert.True(new GitHubSignatureVerifier().Verify(body, signature, secret));
    }

    [Fact]
    public void Tampered_payload_is_rejected()
    {
        var body = Encoding.UTF8.GetBytes("original");
        var tampered = Encoding.UTF8.GetBytes("tampered");
        const string secret = "test-secret";
        using var hmac = new HMACSHA256(Encoding.UTF8.GetBytes(secret));
        var signature = "sha256=" + Convert.ToHexString(hmac.ComputeHash(body));

        Assert.False(new GitHubSignatureVerifier().Verify(tampered, signature, secret));
    }

    [Theory]
    [InlineData(null)]
    [InlineData("")]
    [InlineData("sha1=deadbeef")]
    [InlineData("sha256=not-hex")]
    public void Missing_or_malformed_signature_is_rejected(string? signature)
    {
        Assert.False(new GitHubSignatureVerifier().Verify(
            Encoding.UTF8.GetBytes("payload"),
            signature,
            "secret"));
    }
}
