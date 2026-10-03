package com.bke.worker.gecko

import android.os.Handler
import android.os.Looper
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.Response
import okhttp3.WebSocket
import okhttp3.WebSocketListener
import java.util.UUID
import java.util.concurrent.TimeUnit
import kotlin.math.min

class RelayWebSocketClient(
    private val config: RelayConfig,
    private val onWake: (RelayWake) -> Unit,
    private val onState: (String) -> Unit,
) {
    private val mainHandler = Handler(Looper.getMainLooper())
    private val client = OkHttpClient.Builder()
        .pingInterval(25, TimeUnit.SECONDS)
        .build()
    private val sessionId = UUID.randomUUID().toString()

    private var socket: WebSocket? = null
    private var stopped = false
    private var reconnectAttempt = 0

    fun start() {
        if (config.relayUrl.isBlank() || stopped) return
        connect()
    }

    fun stop() {
        stopped = true
        mainHandler.removeCallbacksAndMessages(null)
        socket?.close(1000, "worker stopping")
        socket = null
        client.dispatcher.executorService.shutdown()
        client.connectionPool.evictAll()
        onState("DISCONNECTED")
    }

    fun sendAck(deliveryId: String, state: String) {
        socket?.send(RelayProtocol.ack(config.workerId, deliveryId, state))
    }

    private fun connect() {
        if (stopped) return

        onState("CONNECTING")
        val requestBuilder = Request.Builder().url(config.relayUrl)
        if (config.bearerToken.isNotBlank()) {
            requestBuilder.header("Authorization", "Bearer ${config.bearerToken}")
        }

        socket = client.newWebSocket(
            requestBuilder.build(),
            object : WebSocketListener() {
                override fun onOpen(webSocket: WebSocket, response: Response) {
                    reconnectAttempt = 0
                    onState("CONNECTED")
                    webSocket.send(RelayProtocol.register(config.workerId, sessionId))
                }

                override fun onMessage(webSocket: WebSocket, text: String) {
                    val wake = RelayProtocol.parseWake(text, config.workerId) ?: run {
                        onState("PROTOCOL_REJECT")
                        return
                    }
                    mainHandler.post { onWake(wake) }
                }

                override fun onClosing(webSocket: WebSocket, code: Int, reason: String) {
                    webSocket.close(code, reason)
                }

                override fun onClosed(webSocket: WebSocket, code: Int, reason: String) {
                    socket = null
                    scheduleReconnect()
                }

                override fun onFailure(webSocket: WebSocket, t: Throwable, response: Response?) {
                    socket = null
                    onState("DISCONNECTED")
                    scheduleReconnect()
                }
            },
        )
    }

    private fun scheduleReconnect() {
        if (stopped) return

        reconnectAttempt += 1
        val exponent = min(reconnectAttempt - 1, 5)
        val delayMs = min(30_000L, 1_000L shl exponent)
        onState("RECONNECTING")
        mainHandler.postDelayed({ connect() }, delayMs)
    }
}
