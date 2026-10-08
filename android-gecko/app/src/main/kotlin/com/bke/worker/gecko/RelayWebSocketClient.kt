package com.bke.worker.gecko

import android.os.Handler
import android.os.Looper
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.Response
import okhttp3.WebSocket
import okhttp3.WebSocketListener
import java.net.URI
import java.util.UUID
import java.util.concurrent.TimeUnit
import kotlin.math.min

class RelayWebSocketClient(
    private val config: RelayConfig,
    private val onWake: (RelayWake) -> Unit,
    private val onRecovery: (RelayRecovery) -> Unit,
    private val onState: (String) -> Unit,
) {
    private val mainHandler = Handler(Looper.getMainLooper())
    private val client = OkHttpClient.Builder()
        .pingInterval(25, TimeUnit.SECONDS)
        .build()
    private val sessionId = UUID.randomUUID().toString()
    private val validAckStates = setOf("accepted", "deferred", "rejected", "completed")

    private var socket: WebSocket? = null
    private var stopped = false
    private var reconnectAttempt = 0
    private var reconnectScheduled = false

    private val reconnectRunnable = Runnable {
        reconnectScheduled = false
        if (!stopped && socket == null) {
            connect()
        }
    }

    fun start() {
        if (config.relayUrl.isBlank() || stopped || socket != null) return
        connect()
    }

    fun stop() {
        stopped = true
        reconnectScheduled = false
        mainHandler.removeCallbacks(reconnectRunnable)
        val current = socket
        socket = null
        current?.close(1000, "worker stopping")
        client.dispatcher.cancelAll()
        client.dispatcher.executorService.shutdown()
        client.connectionPool.evictAll()
        onState("DISCONNECTED")
    }

    fun sendAck(deliveryId: String, state: String) {
        if (state !in validAckStates) return
        socket?.send(RelayProtocol.ack(config.workerId, deliveryId, state))
    }

    private fun connect() {
        if (stopped || socket != null) return

        reconnectScheduled = false
        mainHandler.removeCallbacks(reconnectRunnable)
        onState("CONNECTING")

        val requestBuilder = Request.Builder().url(config.relayUrl)
        if (config.bearerToken.isNotBlank()) {
            requestBuilder.header("Authorization", "Bearer ${config.bearerToken}")
        }

        val listener = object : WebSocketListener() {
            private fun isCurrent(webSocket: WebSocket): Boolean =
                !stopped && webSocket === socket

            override fun onOpen(webSocket: WebSocket, response: Response) {
                if (!isCurrent(webSocket)) {
                    webSocket.close(1000, "stale relay socket")
                    return
                }
                reconnectAttempt = 0
                reconnectScheduled = false
                mainHandler.removeCallbacks(reconnectRunnable)
                onState("CONNECTED")
                webSocket.send(RelayProtocol.register(config.workerId, sessionId))
                requestRecovery()
            }

            override fun onMessage(webSocket: WebSocket, text: String) {
                if (!isCurrent(webSocket)) return

                val wake = RelayProtocol.parseWake(text, config.workerId)
                if (wake == null) {
                    val rejectedDeliveryId =
                        RelayProtocol.identifiableRejectedDeliveryId(text, config.workerId)
                    if (rejectedDeliveryId != null) {
                        sendAck(rejectedDeliveryId, "rejected")
                    }
                    onState("PROTOCOL_REJECT")
                    return
                }
                mainHandler.post {
                    if (isCurrent(webSocket)) {
                        onWake(wake)
                    }
                }
            }

            override fun onClosing(webSocket: WebSocket, code: Int, reason: String) {
                if (webSocket === socket) {
                    webSocket.close(code, reason)
                }
            }

            override fun onClosed(webSocket: WebSocket, code: Int, reason: String) {
                if (webSocket !== socket) return
                socket = null
                scheduleReconnect()
            }

            override fun onFailure(webSocket: WebSocket, t: Throwable, response: Response?) {
                if (webSocket !== socket) return
                socket = null
                onState("DISCONNECTED")
                scheduleReconnect()
            }
        }

        socket = client.newWebSocket(requestBuilder.build(), listener)
    }

    private fun requestRecovery() {
        val relayUri = runCatching { URI(config.relayUrl) }.getOrNull() ?: return
        val scheme = if (relayUri.scheme.equals("wss", ignoreCase = true)) "https" else "http"
        val path = relayUri.path.trimEnd('/')
        val recoveryUrl = scheme + "://" + relayUri.authority + path + "/recover"
        val request = Request.Builder()
            .url(recoveryUrl)
            .header("Authorization", "Bearer " + config.bearerToken)
            .post(okhttp3.RequestBody.create(null, ByteArray(0)))
            .build()

        client.newCall(request).enqueue(object : okhttp3.Callback {
            override fun onFailure(call: okhttp3.Call, e: java.io.IOException) {
                onState("RECOVERY_FAILED")
            }

            override fun onResponse(call: okhttp3.Call, response: Response) {
                response.use {
                    val body = runCatching { it.body?.string().orEmpty() }.getOrDefault("")
                    if (!it.isSuccessful) {
                        onState("RECOVERY_FAILED")
                        return
                    }
                    val recovery = RelayProtocol.parseRecovery(body, config.workerId)
                    if (recovery == null) {
                        onState("RECOVERY_PROTOCOL_REJECT")
                        return
                    }
                    onRecovery(recovery)
                }
            }
        })
    }

    private fun scheduleReconnect() {
        if (stopped || reconnectScheduled || socket != null) return

        reconnectAttempt += 1
        val exponent = min(reconnectAttempt - 1, 5)
        val delayMs = min(30_000L, 1_000L shl exponent)
        reconnectScheduled = true
        onState("RECONNECTING")
        mainHandler.postDelayed(reconnectRunnable, delayMs)
    }
}
