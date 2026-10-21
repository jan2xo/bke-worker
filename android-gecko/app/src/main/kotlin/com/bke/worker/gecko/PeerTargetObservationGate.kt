package com.bke.worker.gecko

import java.net.URI

internal enum class PeerStatusAcceptance {
    ACCEPTED,
    IGNORED_OUT_OF_ORDER,
    REJECTED,
}

internal data class PeerTargetGateSnapshot(
    val trustedLocationUrl: String?,
    val lastNavigationAtMs: Long,
    val navigationGeneration: Long,
    val lastReportSequence: Long,
    val observedUrl: String?,
    val observedAtMs: Long?,
)

internal class PeerTargetObservationGate(
    private val maxAgeMs: Long = 10_000L,
) {
    private var trustedLocationUrl: String? = null
    private var lastNavigationAtMs: Long = 0L
    private var navigationGeneration: Long = 0L
    private var lastReportSequence: Long = 0L
    private var observedUrl: String? = null
    private var observedAtMs: Long? = null

    @Synchronized
    fun navigationStarted(nowMs: Long) {
        navigationGeneration += 1
        lastNavigationAtMs = nowMs
        trustedLocationUrl = null
        clearObservation()
    }

    @Synchronized
    fun locationChanged(url: String?, nowMs: Long) {
        navigationGeneration += 1
        lastNavigationAtMs = nowMs
        trustedLocationUrl = url
        clearObservation()
    }

    /** A new native bridge has its own strictly increasing report stream. */
    @Synchronized
    fun resetBridge() {
        lastReportSequence = 0L
        clearObservation()
    }

    /**
     * Accept only a report produced after the latest trusted Gecko navigation event.
     * A report sequence prevents delayed/out-of-order messages from replacing newer state.
     * Invalid newer reports clear the observation; older reports are ignored without erasing
     * a newer valid observation.
     */
    @Synchronized
    fun acceptStatus(
        pageUrl: String,
        observedAt: Long?,
        reportSequence: Long,
        nowMs: Long,
    ): PeerStatusAcceptance {
        if (reportSequence <= 0L) {
            clearObservation()
            return PeerStatusAcceptance.REJECTED
        }
        if (reportSequence <= lastReportSequence) {
            return PeerStatusAcceptance.IGNORED_OUT_OF_ORDER
        }
        lastReportSequence = reportSequence

        val age = observedAt?.let { nowMs - it }
        val valid = isExactChatGptTarget(pageUrl) &&
            isExactChatGptTarget(trustedLocationUrl) &&
            observedAt != null &&
            observedAt > lastNavigationAtMs &&
            age != null &&
            age in 0..maxAgeMs
        if (!valid) {
            clearObservation()
            return PeerStatusAcceptance.REJECTED
        }

        observedUrl = pageUrl
        observedAtMs = observedAt
        return PeerStatusAcceptance.ACCEPTED
    }

    @Synchronized
    fun snapshot(): PeerTargetGateSnapshot = PeerTargetGateSnapshot(
        trustedLocationUrl = trustedLocationUrl,
        lastNavigationAtMs = lastNavigationAtMs,
        navigationGeneration = navigationGeneration,
        lastReportSequence = lastReportSequence,
        observedUrl = observedUrl,
        observedAtMs = observedAtMs,
    )

    @Synchronized
    fun isObservationCurrent(nowMs: Long): Boolean {
        val observedAt = observedAtMs ?: return false
        val age = nowMs - observedAt
        return isExactChatGptTarget(trustedLocationUrl) &&
            isExactChatGptTarget(observedUrl) &&
            observedAt > lastNavigationAtMs &&
            age in 0..maxAgeMs
    }

    @Synchronized
    fun matches(expected: PeerTargetGateSnapshot, nowMs: Long): Boolean =
        snapshot() == expected && isObservationCurrent(nowMs)

    private fun clearObservation() {
        observedUrl = null
        observedAtMs = null
    }

    private fun isExactChatGptTarget(value: String?): Boolean {
        if (value.isNullOrBlank()) return false
        val uri = runCatching { URI(value) }.getOrNull() ?: return false
        return uri.scheme.equals("https", ignoreCase = true) &&
            uri.host.equals("chatgpt.com", ignoreCase = true) &&
            (uri.port == -1 || uri.port == 443) &&
            uri.userInfo == null
    }
}
