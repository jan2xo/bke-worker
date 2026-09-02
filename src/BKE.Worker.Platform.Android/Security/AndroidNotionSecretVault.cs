using System.Text;
using Android.App;
using Android.Content;
using Android.Hardware.Biometrics;
using Android.OS;
using Android.Security.Keystore;
using Java.Security;
using Javax.Crypto;
using Javax.Crypto.Spec;

namespace BKE.Worker.Platform.Android.Security;

public enum NotionSecretState
{
    NotConfigured,
    Locked,
    Unlocked
}

public sealed class AndroidNotionSecretVault(Activity activity)
{
    private const string PreferenceName = "bke.worker.secure.notion";
    private const string CiphertextPreference = "ciphertext";
    private const string IvPreference = "iv";
    private const string KeyAlias = "bke.worker.notion.token.v1";
    private const string AndroidKeyStore = "AndroidKeyStore";
    private const string CipherTransformation = "AES/GCM/NoPadding";
    private const int AuthenticationWindowSeconds = 30;
    private const int GcmTagBits = 128;

    private string? _unlockedToken;

    public NotionSecretState State => !IsConfigured
        ? NotionSecretState.NotConfigured
        : _unlockedToken is null
            ? NotionSecretState.Locked
            : NotionSecretState.Unlocked;

    public bool IsConfigured
    {
        get
        {
            var preferences = Preferences;
            return !string.IsNullOrWhiteSpace(preferences.GetString(CiphertextPreference, null))
                && !string.IsNullOrWhiteSpace(preferences.GetString(IvPreference, null));
        }
    }

    public string? GetUnlockedToken() => _unlockedToken;

    public void Lock() => _unlockedToken = null;

    public async Task SaveAsync(string token, CancellationToken cancellationToken)
    {
        if (string.IsNullOrWhiteSpace(token))
            throw new ArgumentException("A Notion access token is required.", nameof(token));

        EnsureSecureAuthenticationSupported();
        EnsureKeyExists();
        await Authenticate(activity, "Save Notion connection", cancellationToken);

        var keyStore = LoadKeyStore();
        var key = keyStore.GetKey(KeyAlias, null)
            ?? throw new InvalidOperationException("NOTION_SECRET_KEY_UNAVAILABLE");
        var cipher = Cipher.GetInstance(CipherTransformation)
            ?? throw new InvalidOperationException("NOTION_SECRET_CIPHER_UNAVAILABLE");
        cipher.Init(CipherMode.EncryptMode, key);

        var plaintext = Encoding.UTF8.GetBytes(token.Trim());
        try
        {
            var encrypted = cipher.DoFinal(plaintext)
                ?? throw new InvalidOperationException("NOTION_SECRET_ENCRYPT_FAILED");
            var iv = cipher.GetIV()
                ?? throw new InvalidOperationException("NOTION_SECRET_IV_UNAVAILABLE");

            Preferences.Edit()?
                .PutString(CiphertextPreference, Convert.ToBase64String(encrypted))?
                .PutString(IvPreference, Convert.ToBase64String(iv))?
                .Apply();

            _unlockedToken = token.Trim();
        }
        finally
        {
            Array.Clear(plaintext, 0, plaintext.Length);
        }
    }

    public async Task<string> UnlockAsync(CancellationToken cancellationToken)
    {
        if (!IsConfigured)
            throw new InvalidOperationException("NOTION_SECRET_NOT_CONFIGURED");

        EnsureSecureAuthenticationSupported();
        EnsureKeyExists();
        await Authenticate(activity, "Unlock Notion", cancellationToken);

        var encodedCiphertext = Preferences.GetString(CiphertextPreference, null);
        var encodedIv = Preferences.GetString(IvPreference, null);
        if (string.IsNullOrWhiteSpace(encodedCiphertext) || string.IsNullOrWhiteSpace(encodedIv))
            throw new InvalidOperationException("NOTION_SECRET_NOT_CONFIGURED");

        var ciphertext = Convert.FromBase64String(encodedCiphertext);
        var iv = Convert.FromBase64String(encodedIv);
        var keyStore = LoadKeyStore();
        var key = keyStore.GetKey(KeyAlias, null)
            ?? throw new InvalidOperationException("NOTION_SECRET_KEY_UNAVAILABLE");
        var cipher = Cipher.GetInstance(CipherTransformation)
            ?? throw new InvalidOperationException("NOTION_SECRET_CIPHER_UNAVAILABLE");
        var parameters = new GCMParameterSpec(GcmTagBits, iv);
        cipher.Init(CipherMode.DecryptMode, key, parameters);

        var plaintext = cipher.DoFinal(ciphertext)
            ?? throw new InvalidOperationException("NOTION_SECRET_DECRYPT_FAILED");
        try
        {
            _unlockedToken = Encoding.UTF8.GetString(plaintext);
            return _unlockedToken;
        }
        finally
        {
            Array.Clear(plaintext, 0, plaintext.Length);
            Array.Clear(ciphertext, 0, ciphertext.Length);
            Array.Clear(iv, 0, iv.Length);
        }
    }

    public void Forget()
    {
        Lock();
        Preferences.Edit()?.Clear()?.Apply();

        var keyStore = LoadKeyStore();
        if (keyStore.ContainsAlias(KeyAlias))
            keyStore.DeleteEntry(KeyAlias);
    }

    private ISharedPreferences Preferences =>
        activity.GetSharedPreferences(PreferenceName, FileCreationMode.Private)
        ?? throw new InvalidOperationException("NOTION_SECRET_STORAGE_UNAVAILABLE");

    private static void EnsureSecureAuthenticationSupported()
    {
        if (Build.VERSION.SdkInt < BuildVersionCodes.R)
            throw new InvalidOperationException("NOTION_SECURE_STORAGE_REQUIRES_ANDROID_11");
    }

    private static KeyStore LoadKeyStore()
    {
        var keyStore = KeyStore.GetInstance(AndroidKeyStore)
            ?? throw new InvalidOperationException("NOTION_SECRET_KEYSTORE_UNAVAILABLE");
        keyStore.Load(null);
        return keyStore;
    }

    private static void EnsureKeyExists()
    {
        var keyStore = LoadKeyStore();
        if (keyStore.ContainsAlias(KeyAlias))
            return;

        var generator = KeyGenerator.GetInstance("AES", AndroidKeyStore)
            ?? throw new InvalidOperationException("NOTION_SECRET_KEYGEN_UNAVAILABLE");
        var builder = new KeyGenParameterSpec.Builder(
                KeyAlias,
                KeyStorePurpose.Encrypt | KeyStorePurpose.Decrypt)
            .SetBlockModes("GCM")
            .SetEncryptionPaddings("NoPadding")
            .SetUserAuthenticationRequired(true)
            .SetUserAuthenticationParameters(
                AuthenticationWindowSeconds,
                (int)(KeyPropertiesAuthType.BiometricStrong | KeyPropertiesAuthType.DeviceCredential));

        generator.Init(builder.Build());
        generator.GenerateKey();
    }

    private static async Task Authenticate(
        Activity activity,
        string title,
        CancellationToken cancellationToken)
    {
        var completion = new TaskCompletionSource<bool>(TaskCreationOptions.RunContinuationsAsynchronously);
        using var cancellationSignal = new CancellationSignal();
        using var registration = cancellationToken.Register(cancellationSignal.Cancel);
        using var callback = new AuthenticationCallback(completion);

        var authenticators = (int)(
            BiometricManagerAuthenticators.BiometricStrong |
            BiometricManagerAuthenticators.DeviceCredential);

        var prompt = new BiometricPrompt.Builder(activity)
            .SetTitle(title)
            .SetSubtitle("BKE Worker uses your device authentication to unlock the Notion connection.")
            .SetAllowedAuthenticators(authenticators)
            .Build();

        prompt.Authenticate(cancellationSignal, activity.MainExecutor, callback);
        await completion.Task.WaitAsync(cancellationToken);
    }

    private sealed class AuthenticationCallback(TaskCompletionSource<bool> completion)
        : BiometricPrompt.AuthenticationCallback
    {
        public override void OnAuthenticationSucceeded(BiometricPrompt.AuthenticationResult? result) =>
            completion.TrySetResult(true);

        public override void OnAuthenticationError(BiometricErrorCode errorCode, Java.Lang.ICharSequence? errString) =>
            completion.TrySetException(new InvalidOperationException($"NOTION_AUTH_FAILED:{(int)errorCode}"));

        public override void OnAuthenticationFailed()
        {
            // The system prompt remains open so the user can retry.
        }
    }
}
