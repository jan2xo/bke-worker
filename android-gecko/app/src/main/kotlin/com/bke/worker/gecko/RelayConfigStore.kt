package com.bke.worker.gecko

import android.content.Context
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import android.util.Base64
import java.security.KeyStore
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec

class RelayConfigStore(context: Context) {
    companion object {
        private const val PREFS = "bke.worker.relay.config.v1"
        private const val KEY_WORKER_ID = "worker_id"
        private const val KEY_RELAY_URL = "relay_url"
        private const val KEY_TOKEN_CIPHERTEXT = "token_ciphertext"
        private const val KEY_TOKEN_IV = "token_iv"
        private const val KEY_RELAY_REQUESTED = "relay_requested"

        private const val KEY_ALIAS = "bke.worker.relay.token.v1"
        private const val KEYSTORE = "AndroidKeyStore"
        private const val TRANSFORMATION = "AES/GCM/NoPadding"
        private const val GCM_TAG_BITS = 128
    }

    private val preferences =
        context.applicationContext.getSharedPreferences(PREFS, Context.MODE_PRIVATE)

    fun saveConfig(config: RelayConfig) {
        val cipher = Cipher.getInstance(TRANSFORMATION)
        cipher.init(Cipher.ENCRYPT_MODE, getOrCreateKey())

        val plaintext = config.bearerToken.toByteArray(Charsets.UTF_8)
        try {
            val ciphertext = cipher.doFinal(plaintext)
            val iv = cipher.iv
            preferences.edit()
                .putString(KEY_WORKER_ID, config.workerId)
                .putString(KEY_RELAY_URL, config.relayUrl)
                .putString(KEY_TOKEN_CIPHERTEXT, Base64.encodeToString(ciphertext, Base64.NO_WRAP))
                .putString(KEY_TOKEN_IV, Base64.encodeToString(iv, Base64.NO_WRAP))
                .apply()
        } finally {
            plaintext.fill(0)
        }
    }

    fun loadConfig(): RelayConfig? {
        val workerId = preferences.getString(KEY_WORKER_ID, null)?.trim().orEmpty()
        val relayUrl = preferences.getString(KEY_RELAY_URL, null)?.trim().orEmpty()
        val encodedCiphertext = preferences.getString(KEY_TOKEN_CIPHERTEXT, null)
        val encodedIv = preferences.getString(KEY_TOKEN_IV, null)

        if (
            workerId.isBlank() ||
            relayUrl.isBlank() ||
            encodedCiphertext.isNullOrBlank() ||
            encodedIv.isNullOrBlank()
        ) {
            return null
        }

        return runCatching {
            val ciphertext = Base64.decode(encodedCiphertext, Base64.NO_WRAP)
            val iv = Base64.decode(encodedIv, Base64.NO_WRAP)
            try {
                val cipher = Cipher.getInstance(TRANSFORMATION)
                cipher.init(
                    Cipher.DECRYPT_MODE,
                    getOrCreateKey(),
                    GCMParameterSpec(GCM_TAG_BITS, iv),
                )
                val plaintext = cipher.doFinal(ciphertext)
                try {
                    RelayConfig(
                        workerId = workerId,
                        relayUrl = relayUrl,
                        bearerToken = plaintext.toString(Charsets.UTF_8),
                    )
                } finally {
                    plaintext.fill(0)
                }
            } finally {
                ciphertext.fill(0)
                iv.fill(0)
            }
        }.getOrNull()
    }

    fun saveRelayRequested(requested: Boolean) {
        preferences.edit()
            .putBoolean(KEY_RELAY_REQUESTED, requested)
            .apply()
    }

    fun loadRelayRequested(): Boolean =
        preferences.getBoolean(KEY_RELAY_REQUESTED, false)

    private fun getOrCreateKey(): SecretKey {
        val keyStore = KeyStore.getInstance(KEYSTORE).apply { load(null) }
        (keyStore.getKey(KEY_ALIAS, null) as? SecretKey)?.let { return it }

        val generator = KeyGenerator.getInstance(
            KeyProperties.KEY_ALGORITHM_AES,
            KEYSTORE,
        )
        val spec = KeyGenParameterSpec.Builder(
            KEY_ALIAS,
            KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT,
        )
            .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
            .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
            .setKeySize(256)
            .build()
        generator.init(spec)
        return generator.generateKey()
    }
}
