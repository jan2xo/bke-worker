package com.bke.worker.gecko

import org.json.JSONObject
import java.net.URI

data class RelayConfig(
    val workerId: String,
    val relayUrl: String,
    val bearerToken: String,
)

data class RelayWake(
    val workerId: String,
    val repo: String,
    val prNumber: Int,
    val expectedHeadSha: String,
    val reason: String,
    val deliveryId: String,
)

data class RelayRecovery(
    val state: String,
    val workerId: String,
    val prNumber: Int?,
    val headRef: String?,
    val headSha: String?,
    val deliveryId: String?,
    val activePhase: String?,
)

object RelayProtocol {
    const val VERSION = 1
    const val CONTROL_REPOSITORY = "jan2xo/bke-worker"
    private val CONTROL_REPOSITORIES = setOf(
        CONTROL_REPOSITORY,
        "jan2xo/bke-demo-app",
    )

    private val workerIdPattern = Regex("^[a-z0-9][a-z0-9-]{0,62}$")
    private val shaPattern = Regex("^[0-9a-f]{40}$")
    private val reasonPattern = Regex("^[a-z0-9._:-]{1,64}$")
    private val deliveryPattern = Regex("^[A-Za-z0-9._:-]{1,128}$")

    fun validateConfig(config: RelayConfig): String? {
        if (!workerIdPattern.matches(config.workerId)) return "WORKER_ID_INVALID"
        if (config.relayUrl.isBlank()) return null

        val uri = runCatching { URI(config.relayUrl) }.getOrNull()
            ?: return "RELAY_URL_INVALID"
        if (uri.userInfo != null || uri.fragment != null || uri.host.isNullOrBlank()) {
            return "RELAY_URL_INVALID"
        }

        val loopback = uri.host.equals("127.0.0.1", ignoreCase = true) ||
            uri.host.equals("localhost", ignoreCase = true)

        if (uri.scheme.equals("ws", ignoreCase = true) && !loopback) {
            return "RELAY_URL_INSECURE"
        }
        if (!uri.scheme.equals("wss", ignoreCase = true) &&
            !uri.scheme.equals("ws", ignoreCase = true)
        ) {
            return "RELAY_URL_INVALID"
        }

        if (!loopback && config.bearerToken.isBlank()) {
            return "RELAY_TOKEN_REQUIRED"
        }

        return null
    }

    fun parseWake(text: String, expectedWorkerId: String): RelayWake? {
        val json = runCatching { JSONObject(text) }.getOrNull() ?: return null
        val keys = buildSet {
            val iterator = json.keys()
            while (iterator.hasNext()) add(iterator.next())
        }
        val expectedKeys = setOf(
            "protocol",
            "type",
            "worker_id",
            "repo",
            "pr_number",
            "expected_head_sha",
            "reason",
            "delivery_id",
        )
        if (keys != expectedKeys) return null
        if (json.optInt("protocol", -1) != VERSION) return null
        if (json.optString("type") != "wake") return null

        val workerId = json.optString("worker_id")
        val repo = json.optString("repo")
        val prNumber = json.optInt("pr_number", -1)
        val expectedHeadSha = json.optString("expected_head_sha")
        val reason = json.optString("reason")
        val deliveryId = json.optString("delivery_id")

        if (workerId != expectedWorkerId || !workerIdPattern.matches(workerId)) return null
        if (repo !in CONTROL_REPOSITORIES) return null
        if (prNumber <= 0) return null
        if (!shaPattern.matches(expectedHeadSha)) return null
        if (!reasonPattern.matches(reason)) return null
        if (!deliveryPattern.matches(deliveryId)) return null

        return RelayWake(
            workerId = workerId,
            repo = repo,
            prNumber = prNumber,
            expectedHeadSha = expectedHeadSha,
            reason = reason,
            deliveryId = deliveryId,
        )
    }

    fun identifiableRejectedDeliveryId(text: String, expectedWorkerId: String): String? {
        val json = runCatching { JSONObject(text) }.getOrNull() ?: return null
        if (json.optInt("protocol", -1) != VERSION) return null
        if (json.optString("type") != "wake") return null

        val workerId = json.optString("worker_id")
        val deliveryId = json.optString("delivery_id")
        if (workerId != expectedWorkerId || !workerIdPattern.matches(workerId)) return null
        if (!deliveryPattern.matches(deliveryId)) return null
        return deliveryId
    }

    fun register(workerId: String, sessionId: String): String =
        JSONObject()
            .put("protocol", VERSION)
            .put("type", "register")
            .put("worker_id", workerId)
            .put("session_id", sessionId)
            .toString()

    fun parseRecovery(text: String, expectedWorkerId: String): RelayRecovery? {
        val json = runCatching { JSONObject(text) }.getOrNull() ?: return null
        val state = json.optString("state")
        val workerId = json.optString("worker_id")
        if (state.isBlank() || workerId != expectedWorkerId || !workerIdPattern.matches(workerId)) {
            return null
        }

        val assignment = json.optJSONObject("assignment")
        val prNumber = assignment?.optInt("number", -1)?.takeIf { it > 0 }
        val headRef = assignment?.optString("headRef")?.takeIf { it.isNotBlank() }
        val headSha = assignment?.optString("headSha")?.takeIf { shaPattern.matches(it) }
        val deliveryId = json.optString("delivery_id").takeIf { deliveryPattern.matches(it) }
        val activePhase = json.optString("active_phase").takeIf { it.isNotBlank() }

        return RelayRecovery(
            state = state,
            workerId = workerId,
            prNumber = prNumber,
            headRef = headRef,
            headSha = headSha,
            deliveryId = deliveryId,
            activePhase = activePhase,
        )
    }

    fun ack(workerId: String, deliveryId: String, state: String): String =
        JSONObject()
            .put("protocol", VERSION)
            .put("type", "ack")
            .put("worker_id", workerId)
            .put("delivery_id", deliveryId)
            .put("state", state)
            .toString()

    fun continuationPrompt(wake: RelayWake): String {
        val context = JSONObject()
            .put("repo", wake.repo)
            .put("pr_number", wake.prNumber)
            .put("worker_id", wake.workerId)
            .put("expected_head_sha", wake.expectedHeadSha)
            .put("wake_reason", wake.reason)

        return buildString {
            appendLine("CONTINUE FROM PR")
            appendLine()
            appendLine(context.toString(2))
            appendLine()
            appendLine("Recover the canonical execution contract from current main and recover live GitHub state.")
            appendLine("Verify ownership and exact head before engineering action.")
            append("Continue the authorized mission until no runnable authorized work remains.")
        }
    }
}
