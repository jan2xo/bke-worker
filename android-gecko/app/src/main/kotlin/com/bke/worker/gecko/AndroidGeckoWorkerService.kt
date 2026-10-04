package com.bke.worker.gecko

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.os.Binder
import android.os.Build
import android.os.IBinder
import android.util.Log
import org.json.JSONObject
import org.mozilla.geckoview.GeckoResult
import org.mozilla.geckoview.GeckoSession
import org.mozilla.geckoview.WebExtension
import java.net.URI

data class AndroidWorkerStatusSnapshot(
    val workerId: String,
    val chatGptState: String,
    val relayState: String,
)

class AndroidGeckoWorkerService : Service() {
    companion object {
        private const val TAG = "BkeWorkerGecko"
        private const val CHANNEL_ID = "bke_worker_gecko_probe"
        private const val NOTIFICATION_ID = 41801

        private const val DEFAULT_WORKER_ID = "android-worker-a"
        private const val CHATGPT_URL = "https://chatgpt.com/"
        private const val EXTENSION_URI = "resource://android/assets/worker-extension/"
        private const val EXTENSION_ID = "bke-worker-gecko-probe@jl-bke.com"
        private const val NATIVE_APP = "bke.worker.gecko"

        private const val ACTION_ENSURE_BROWSER = "bke.worker.ensure_browser"
        private const val ACTION_APPLY_RELAY_CONFIG = "bke.worker.apply_relay_config"
        private const val ACTION_START_RELAY = "bke.worker.start_relay"
        private const val ACTION_STOP_RELAY = "bke.worker.stop_relay"

        private const val EXTRA_WORKER_ID = "bke.worker.worker_id"
        private const val EXTRA_RELAY_URL = "bke.worker.relay_url"
        private const val EXTRA_RELAY_TOKEN = "bke.worker.relay_token"

        private const val STATE_STARTING = "STARTING"
        private const val STATE_READY = "READY"
        private const val STATE_BUSY = "BUSY"
        private const val STATE_NO_COMPOSER = "NO_COMPOSER"
        private const val STATE_FAILED = "FAILED"

        private const val RECENT_DELIVERY_LIMIT = 64

        @Volatile
        var isRunning: Boolean = false
            private set

        fun ensureBrowserRunning(context: Context) {
            startServiceAction(
                context,
                Intent(context.applicationContext, AndroidGeckoWorkerService::class.java)
                    .setAction(ACTION_ENSURE_BROWSER),
            )
        }

        fun applyRelayConfig(
            context: Context,
            workerId: String,
            relayUrl: String,
            relayToken: String,
        ) {
            startServiceAction(
                context,
                Intent(context.applicationContext, AndroidGeckoWorkerService::class.java)
                    .setAction(ACTION_APPLY_RELAY_CONFIG)
                    .putExtra(EXTRA_WORKER_ID, workerId)
                    .putExtra(EXTRA_RELAY_URL, relayUrl)
                    .putExtra(EXTRA_RELAY_TOKEN, relayToken),
            )
        }

        fun startRelay(context: Context) {
            startServiceAction(
                context,
                Intent(context.applicationContext, AndroidGeckoWorkerService::class.java)
                    .setAction(ACTION_START_RELAY),
            )
        }

        fun stopRelay(context: Context) {
            startServiceAction(
                context,
                Intent(context.applicationContext, AndroidGeckoWorkerService::class.java)
                    .setAction(ACTION_STOP_RELAY),
            )
        }

        private fun startServiceAction(context: Context, intent: Intent) {
            val app = context.applicationContext
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                app.startForegroundService(intent)
            } else {
                app.startService(intent)
            }
        }

        private fun isChatGptUrl(value: String): Boolean {
            val uri = runCatching { URI(value) }.getOrNull() ?: return false
            val host = uri.host?.lowercase() ?: return false
            return uri.scheme.equals("https", ignoreCase = true) &&
                (host == "chatgpt.com" || host.endsWith(".chatgpt.com") || host == "chat.openai.com")
        }
    }

    inner class LocalBinder : Binder() {
        fun service(): AndroidGeckoWorkerService = this@AndroidGeckoWorkerService
    }

    private val binder = LocalBinder()
    private val runtime by lazy { GeckoRuntimeProvider.get(applicationContext) }
    private val workerSession = GeckoSession()

    @Volatile
    private var activeWorkerId = DEFAULT_WORKER_ID
    @Volatile
    private var workerState = STATE_STARTING
    @Volatile
    private var relayState = "STOPPED"

    private var appliedRelayConfig = RelayConfig(
        workerId = DEFAULT_WORKER_ID,
        relayUrl = "",
        bearerToken = "",
    )
    private var relayRequested = false
    private var workerPort: WebExtension.Port? = null
    private var relayClient: RelayWebSocketClient? = null

    private val recentDeliveryIds = LinkedHashSet<String>()
    private var activeWake: RelayWake? = null
    private var activeSawBusy = false
    private var pendingWake: RelayWake? = null

    fun session(): GeckoSession = workerSession

    fun appliedRelayConfig(): RelayConfig = appliedRelayConfig

    fun statusSnapshot(): AndroidWorkerStatusSnapshot =
        AndroidWorkerStatusSnapshot(
            workerId = activeWorkerId,
            chatGptState = workerState,
            relayState = relayState,
        )

    private val portDelegate = object : WebExtension.PortDelegate {
        override fun onPortMessage(message: Any, port: WebExtension.Port) {
            if (port !== workerPort || message !is JSONObject) return
            handleExtensionMessage(message)
        }

        override fun onDisconnect(port: WebExtension.Port) {
            if (port === workerPort) {
                workerPort = null
            }
        }
    }

    private val messageDelegate = object : WebExtension.MessageDelegate {
        override fun onConnect(port: WebExtension.Port) {
            if (port.name != NATIVE_APP || port.sender.session !== workerSession) {
                port.disconnect()
                return
            }

            workerPort?.disconnect()
            workerPort = port
            port.setDelegate(portDelegate)
            maybeDispatchPendingWake()
        }

        override fun onMessage(
            nativeApp: String,
            message: Any,
            sender: WebExtension.MessageSender,
        ): GeckoResult<Any>? {
            if (nativeApp != NATIVE_APP || sender.session !== workerSession || message !is JSONObject) {
                return null
            }
            handleExtensionMessage(message)
            return null
        }
    }

    private val contentDelegate = object : GeckoSession.ContentDelegate {
        override fun onCrash(session: GeckoSession) {
            workerState = STATE_FAILED
            updateNotification()
            Log.e(TAG, "Worker GeckoSession crashed")
        }

        override fun onKill(session: GeckoSession) {
            workerState = STATE_FAILED
            updateNotification()
            Log.e(TAG, "Worker GeckoSession was killed")
        }
    }

    override fun onCreate() {
        super.onCreate()
        isRunning = true
        createNotificationChannel()
        startForeground(NOTIFICATION_ID, buildNotification())

        workerSession.setContentDelegate(contentDelegate)
        workerSession.open(runtime)

        runtime.getWebExtensionController()
            .ensureBuiltIn(EXTENSION_URI, EXTENSION_ID)
            .accept(
                { extension ->
                    if (extension == null) {
                        workerState = STATE_FAILED
                        updateNotification()
                        Log.e(TAG, "Worker WebExtension resolved without an extension")
                        return@accept
                    }

                    workerSession.getWebExtensionController().setMessageDelegate(
                        extension,
                        messageDelegate,
                        NATIVE_APP,
                    )
                    workerSession.loadUri(CHATGPT_URL)
                },
                { error ->
                    workerState = STATE_FAILED
                    updateNotification()
                    Log.e(TAG, "Unable to install Worker WebExtension", error)
                },
            )
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        startForeground(NOTIFICATION_ID, buildNotification())

        when (intent?.action) {
            ACTION_APPLY_RELAY_CONFIG -> {
                applyRelayConfig(
                    RelayConfig(
                        workerId = intent.getStringExtra(EXTRA_WORKER_ID)?.trim().orEmpty(),
                        relayUrl = intent.getStringExtra(EXTRA_RELAY_URL)?.trim().orEmpty(),
                        bearerToken = intent.getStringExtra(EXTRA_RELAY_TOKEN).orEmpty(),
                    ),
                )
            }
            ACTION_START_RELAY -> startRelay()
            ACTION_STOP_RELAY -> stopRelay()
            ACTION_ENSURE_BROWSER, null -> updateNotification()
        }

        return START_STICKY
    }

    override fun onBind(intent: Intent?): IBinder = binder

    override fun onDestroy() {
        isRunning = false
        relayRequested = false
        relayClient?.stop()
        relayClient = null
        workerPort?.disconnect()
        workerPort = null
        runCatching { workerSession.close() }
            .onFailure { Log.w(TAG, "Unable to close Worker GeckoSession cleanly", it) }
        super.onDestroy()
    }

    private fun applyRelayConfig(config: RelayConfig) {
        val error = RelayProtocol.validateConfig(config)
        if (error != null) {
            relayClient?.stop()
            relayClient = null
            relayState = error
            updateNotification()
            return
        }

        appliedRelayConfig = config
        activeWorkerId = config.workerId

        if (relayRequested) {
            connectRelay()
        } else {
            relayState = if (config.relayUrl.isBlank()) "UNPAIRED" else "STOPPED"
            updateNotification()
        }
    }

    private fun startRelay() {
        relayRequested = true
        connectRelay()
    }

    private fun stopRelay() {
        relayRequested = false
        relayClient?.stop()
        relayClient = null
        relayState = if (appliedRelayConfig.relayUrl.isBlank()) "UNPAIRED" else "STOPPED"
        updateNotification()
    }

    private fun connectRelay() {
        relayClient?.stop()
        relayClient = null

        val config = appliedRelayConfig
        val error = RelayProtocol.validateConfig(config)
        if (error != null) {
            relayState = error
            updateNotification()
            return
        }

        activeWorkerId = config.workerId
        if (config.relayUrl.isBlank()) {
            relayState = "UNPAIRED"
            updateNotification()
            return
        }

        relayState = "CONNECTING"
        relayClient = RelayWebSocketClient(
            config = config,
            onWake = ::handleRelayWake,
            onState = { state ->
                relayState = state
                updateNotification()
            },
        ).also { it.start() }
        updateNotification()
    }

    private fun handleExtensionMessage(message: JSONObject) {
        when (message.optString("type")) {
            "worker_status" -> handleWorkerStatus(message)
            "dispatch_result" -> handleDispatchResult(message)
        }
    }

    private fun handleWorkerStatus(message: JSONObject) {
        val expectedKeys = setOf(
            "type",
            "protocolVersion",
            "observedAt",
            "pageUrl",
            "composerAvailable",
            "turnBusy",
        )
        if (jsonKeys(message) != expectedKeys ||
            message.optInt("protocolVersion", -1) != RelayProtocol.VERSION
        ) {
            return
        }

        val pageUrl = message.optString("pageUrl")
        if (!isChatGptUrl(pageUrl) || message.optString("observedAt").isBlank()) {
            return
        }

        val composerAvailable = message.optBoolean("composerAvailable")
        val turnBusy = message.optBoolean("turnBusy")
        workerState = when {
            turnBusy -> STATE_BUSY
            composerAvailable -> STATE_READY
            else -> STATE_NO_COMPOSER
        }

        val active = activeWake
        if (active != null) {
            if (turnBusy) {
                activeSawBusy = true
            } else if (activeSawBusy && workerState == STATE_READY) {
                relayClient?.sendAck(active.deliveryId, "completed")
                activeWake = null
                activeSawBusy = false
                maybeDispatchPendingWake()
            }
        } else if (workerState == STATE_READY) {
            maybeDispatchPendingWake()
        }

        updateNotification()
    }

    private fun handleDispatchResult(message: JSONObject) {
        val expectedKeys = setOf(
            "type",
            "protocolVersion",
            "deliveryId",
            "accepted",
            "error",
        )
        if (jsonKeys(message) != expectedKeys ||
            message.optInt("protocolVersion", -1) != RelayProtocol.VERSION
        ) {
            return
        }

        val active = activeWake ?: return
        if (message.optString("deliveryId") != active.deliveryId) return

        if (message.optBoolean("accepted")) {
            rememberDelivery(active.deliveryId)
            relayClient?.sendAck(active.deliveryId, "accepted")
            return
        }

        relayClient?.sendAck(active.deliveryId, "rejected")
        activeWake = null
        activeSawBusy = false
        maybeDispatchPendingWake()
    }

    private fun handleRelayWake(wake: RelayWake) {
        if (wake.workerId != activeWorkerId) return

        if (wake.deliveryId in recentDeliveryIds) {
            relayClient?.sendAck(wake.deliveryId, "accepted")
            return
        }
        if (activeWake?.deliveryId == wake.deliveryId) {
            relayClient?.sendAck(wake.deliveryId, "accepted")
            return
        }
        if (pendingWake?.deliveryId == wake.deliveryId) {
            relayClient?.sendAck(wake.deliveryId, "deferred")
            return
        }

        if (activeWake != null || workerState != STATE_READY || workerPort == null) {
            pendingWake = wake
            relayClient?.sendAck(wake.deliveryId, "deferred")
            return
        }

        dispatchWake(wake)
    }

    private fun dispatchWake(wake: RelayWake) {
        val port = workerPort
        if (port == null || workerState != STATE_READY || activeWake != null) {
            pendingWake = wake
            relayClient?.sendAck(wake.deliveryId, "deferred")
            return
        }

        val command = JSONObject()
            .put("type", "dispatch_prompt")
            .put("protocolVersion", RelayProtocol.VERSION)
            .put("deliveryId", wake.deliveryId)
            .put("prompt", RelayProtocol.continuationPrompt(wake))

        activeWake = wake
        activeSawBusy = false

        runCatching { port.postMessage(command) }
            .onFailure {
                relayClient?.sendAck(wake.deliveryId, "rejected")
                activeWake = null
                activeSawBusy = false
                maybeDispatchPendingWake()
            }
    }

    private fun maybeDispatchPendingWake() {
        if (activeWake != null || workerState != STATE_READY || workerPort == null) return
        val wake = pendingWake ?: return
        pendingWake = null
        dispatchWake(wake)
    }

    private fun rememberDelivery(deliveryId: String) {
        recentDeliveryIds.add(deliveryId)
        while (recentDeliveryIds.size > RECENT_DELIVERY_LIMIT) {
            val oldest = recentDeliveryIds.firstOrNull() ?: break
            recentDeliveryIds.remove(oldest)
        }
    }

    private fun jsonKeys(json: JSONObject): Set<String> = buildSet {
        val iterator = json.keys()
        while (iterator.hasNext()) add(iterator.next())
    }

    private fun createNotificationChannel() {
        val manager = getSystemService(NotificationManager::class.java)
        val channel = NotificationChannel(
            CHANNEL_ID,
            "BKE Worker Gecko",
            NotificationManager.IMPORTANCE_LOW,
        ).apply {
            description = "Keeps the BKE Worker Gecko session and relay connection alive."
            setShowBadge(false)
            lockscreenVisibility = Notification.VISIBILITY_PRIVATE
        }
        manager.createNotificationChannel(channel)
    }

    private fun updateNotification() {
        getSystemService(NotificationManager::class.java)
            .notify(NOTIFICATION_ID, buildNotification())
    }

    private fun buildNotification(): Notification {
        val openApp = Intent(this, MainActivity::class.java).apply {
            flags = Intent.FLAG_ACTIVITY_SINGLE_TOP or Intent.FLAG_ACTIVITY_CLEAR_TOP
        }
        val pendingIntent = PendingIntent.getActivity(
            this,
            41801,
            openApp,
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
        )

        return Notification.Builder(this, CHANNEL_ID)
            .setSmallIcon(android.R.drawable.stat_notify_sync)
            .setContentTitle("BKE Worker")
            .setContentText("$activeWorkerId • $workerState • relay:$relayState")
            .setContentIntent(pendingIntent)
            .setCategory(Notification.CATEGORY_SERVICE)
            .setOngoing(true)
            .setOnlyAlertOnce(true)
            .build()
    }
}
