package com.bke.worker.gecko

import android.content.Context
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyInfo
import android.security.keystore.KeyProperties
import android.util.Base64
import java.io.ByteArrayOutputStream
import java.io.DataOutputStream
import java.security.KeyFactory
import java.security.KeyPair
import java.security.KeyPairGenerator
import java.security.KeyStore
import java.security.PrivateKey
import java.security.Signature
import java.security.spec.ECGenParameterSpec
import java.util.UUID

/**
 * Device-side Android Keystore proof for the future Command Center private enrollment exchange.
 *
 * This class emits evidence, not an authorization decision. The server must validate the
 * Android key-attestation certificate chain, package/signing identity, server nonce freshness,
 * and owner-pinned public key before trusting the binding. A signature or a caller-provided
 * "trusted" flag alone is never sufficient.
 */
data class AndroidPeerAttestationEvidence(
    val protocolVersion: Int,
    val workerId: String,
    val sessionId: String,
    val profileId: String,
    val bridgeId: String,
    val targetOrigin: String,
    val challengeBase64Url: String,
    val initialAttestationChallengeBase64Url: String,
    val publicKeyBase64Url: String,
    val attestationChainBase64Url: List<String>,
    val signatureBase64Url: String,
    val hardwareBacked: Boolean,
)

class AndroidPeerAttestor(context: Context) {
    companion object {
        const val PROTOCOL_VERSION = 1
        const val TARGET_ORIGIN = "https://chatgpt.com"
        private const val KEYSTORE = "AndroidKeyStore"
        private const val KEY_ALIAS = "bke.worker.gecko.peer.identity.v1"
        private const val CHALLENGE_BYTES = 32
        private const val INITIAL_ATTESTATION_CHALLENGE_KEY = "bke.worker.gecko.peer.initial_attestation_challenge.v1"
        private val WORKER_ID = Regex("^[a-z0-9][a-z0-9-]{0,62}$")
        private val UUID_PATTERN = Regex("^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}$")
    }

    private val appContext = context.applicationContext

    /**
     * Returns null on any missing/invalid hardware evidence. The caller must supply a fresh,
     * unpredictable 32-byte challenge obtained from the trusted server-side enrollment flow.
     */
    fun attest(
        challenge: ByteArray,
        workerId: String,
        sessionId: String,
        profileId: String,
        bridgeId: String,
        targetOrigin: String,
    ): AndroidPeerAttestationEvidence? {
        if (challenge.size != CHALLENGE_BYTES ||
            !WORKER_ID.matches(workerId) ||
            !UUID_PATTERN.matches(sessionId) ||
            !UUID_PATTERN.matches(profileId) ||
            !UUID_PATTERN.matches(bridgeId) ||
            targetOrigin != TARGET_ORIGIN
        ) return null

        return runCatching {
            val keyPair = loadOrCreateKeyPair(challenge)
            val prefs = appContext.getSharedPreferences("bke.worker.peer.identity.v1", Context.MODE_PRIVATE)
            val initialChallenge = prefs.getString(INITIAL_ATTESTATION_CHALLENGE_KEY, null)
                ?: error("PEER_INITIAL_ATTESTATION_CHALLENGE_UNRECORDED")
            check(decode(initialChallenge).size == CHALLENGE_BYTES) {
                "PEER_INITIAL_ATTESTATION_CHALLENGE_INVALID"
            }
            val privateKey = privateKey() ?: error("PEER_PRIVATE_KEY_UNAVAILABLE")
            val keyInfo = KeyFactory.getInstance(privateKey.algorithm, KEYSTORE)
                .getKeySpec(privateKey, KeyInfo::class.java)
            // Software-only keys do not satisfy the native peer identity contract.
            check(keyInfo.isInsideSecureHardware) { "PEER_KEY_NOT_HARDWARE_BACKED" }

            val chain = keyStore().getCertificateChain(KEY_ALIAS)
                ?.map { Base64.encodeToString(it.encoded, Base64.URL_SAFE or Base64.NO_WRAP or Base64.NO_PADDING) }
                ?: error("PEER_ATTESTATION_CHAIN_UNAVAILABLE")
            check(chain.size >= 2) { "PEER_ATTESTATION_CHAIN_INCOMPLETE" }

            val publicKey = keyPair.public
            val payload = canonicalBinding(
                challenge = challenge,
                workerId = workerId,
                sessionId = sessionId,
                profileId = profileId,
                bridgeId = bridgeId,
                targetOrigin = targetOrigin,
            )
            val signer = Signature.getInstance("SHA256withECDSA")
            signer.initSign(privateKey)
            signer.update(payload)
            val signature = signer.sign()

            AndroidPeerAttestationEvidence(
                protocolVersion = PROTOCOL_VERSION,
                workerId = workerId,
                sessionId = sessionId,
                profileId = profileId,
                bridgeId = bridgeId,
                targetOrigin = targetOrigin,
                challengeBase64Url = encode(challenge),
                initialAttestationChallengeBase64Url = initialChallenge,
                publicKeyBase64Url = encode(publicKey.encoded),
                attestationChainBase64Url = chain,
                signatureBase64Url = encode(signature),
                hardwareBacked = true,
            )
        }.getOrNull()
    }

    private fun loadOrCreateKeyPair(challenge: ByteArray): KeyPair {
        val store = keyStore()
        val existingPrivate = store.getKey(KEY_ALIAS, null) as? PrivateKey
        val existingCertificate = store.getCertificate(KEY_ALIAS)
        if (existingPrivate != null && existingCertificate != null) {
            return KeyPair(existingCertificate.publicKey, existingPrivate)
        }

        // Do not replace a partial/corrupt identity silently: it could change the pinned key.
        check(existingPrivate == null && existingCertificate == null) {
            "PEER_KEYSTORE_IDENTITY_INCONSISTENT"
        }

        val prefs = appContext.getSharedPreferences("bke.worker.peer.identity.v1", Context.MODE_PRIVATE)
        check(prefs.getString(INITIAL_ATTESTATION_CHALLENGE_KEY, null) == null) {
            "PEER_INITIAL_ATTESTATION_CHALLENGE_UNRECORDED"
        }
        val generator = KeyPairGenerator.getInstance(KeyProperties.KEY_ALGORITHM_EC, KEYSTORE)
        val spec = KeyGenParameterSpec.Builder(
            KEY_ALIAS,
            KeyProperties.PURPOSE_SIGN or KeyProperties.PURPOSE_VERIFY,
        )
            .setAlgorithmParameterSpec(ECGenParameterSpec("secp256r1"))
            .setDigests(KeyProperties.DIGEST_SHA256)
            .setAttestationChallenge(challenge.copyOf())
            .setUserAuthenticationRequired(false)
            .build()
        generator.initialize(spec)
        val pair = generator.generateKeyPair()
        val saved = prefs.edit()
            .putString(INITIAL_ATTESTATION_CHALLENGE_KEY, encode(challenge))
            .commit()
        check(saved) { "PEER_INITIAL_ATTESTATION_CHALLENGE_STORE_FAILED" }
        return pair
    }

    private fun decode(value: String): ByteArray =
        Base64.decode(value, Base64.URL_SAFE or Base64.NO_WRAP or Base64.NO_PADDING)

    private fun privateKey(): PrivateKey? =
        keyStore().getKey(KEY_ALIAS, null) as? PrivateKey

    private fun keyStore(): KeyStore =
        KeyStore.getInstance(KEYSTORE).apply { load(null) }

    private fun encode(value: ByteArray): String =
        Base64.encodeToString(value, Base64.URL_SAFE or Base64.NO_WRAP or Base64.NO_PADDING)

    /**
     * Binary, length-prefixed canonical format; field order is part of protocol v1.
     * Layout: int version, then challenge, workerId, sessionId, profileId, bridgeId, targetOrigin.
     */
    internal fun canonicalBinding(
        challenge: ByteArray,
        workerId: String,
        sessionId: String,
        profileId: String,
        bridgeId: String,
        targetOrigin: String,
    ): ByteArray {
        val bytes = ByteArrayOutputStream()
        DataOutputStream(bytes).use { out ->
            out.writeInt(PROTOCOL_VERSION)
            listOf(
                challenge,
                workerId.toByteArray(Charsets.UTF_8),
                sessionId.toByteArray(Charsets.UTF_8),
                profileId.toByteArray(Charsets.UTF_8),
                bridgeId.toByteArray(Charsets.UTF_8),
                targetOrigin.toByteArray(Charsets.UTF_8),
            ).forEach { field ->
                out.writeInt(field.size)
                out.write(field)
            }
        }
        return bytes.toByteArray()
    }
}
