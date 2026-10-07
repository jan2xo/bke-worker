package com.bke.worker.gecko

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.ApplicationInfo
import android.os.Binder
import android.os.Build
import android.os.Handler
import android.os.IBinder
import android.os.Looper
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

        private const val CERTIFICATION_PACKAGE_SUFFIX = ".recoverycert"
        private const val ACTION_CERT_CRASH_CONTENT = "bke.worker.cert.crash_content"
        private const val ACTION_CERT_SIMULATE_CONTENT_KILL = "bke.worker.cert.simulate_content_kill"
        private const val ACTION_CERT_NO_COMPOSER = "bke.worker.cert.no_composer"
        private const val ACTION_CERT_NATIVE_PORT_LOSS = "bke.worker.cert.native_port_loss"
        private const val ACTION_CERT_EXHAUST_RECOVERY = "bke.worker.cert.exhaust_recovery"
        private const val ACTION_CERT_RESOLVE_UNCERTAIN_REJECT =
            "bke.worker.cert.resolve_uncertain_reject"

        private const val EXTRA_WORKER_ID = "bke.worker.worker_id"
        private const val EXTRA_RELAY_URL = "bke.worker.relay_url"
        private const val EXTRA_RELAY_TOKEN = "bke.worker.relay_token"

        private const val STATE_STARTING = "STARTING"
        private const val STATE_READY = "READY"
        private const val STATE_BUSY = "BUSY"
        private const val STATE_NO_COMPOSER = "NO_COMPOSER"
        private const val STATE_RECOVERING = "RECOVERING"
        private const val STATE_BLOCKED_UNCERTAIN = "BLOCKED_UNCERTAIN_TURN"
        private const val STATE_FAILED = "FAILED"

        private const val RECENT_DELIVERY_LIMIT = 64
        private const val CHAT_RECOVERY_MAX_ATTEMPTS = 3
        private const val CHAT_RECOVERY_RETRY_DELAY_MS = 2_000L
        private const val CHAT_READY_TIMEOUT_MS = 15_000L
        private const val NATIVE_PORT_RECOVERY_TIMEOUT_MS = 10_000L

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
    private val relayConfigStore by lazy { RelayConfigStore(applicationContext) }
    private val workerSession = GeckoSession()
    private val mainHandler = Handler(Looper.getMainLooper())

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
    private var workerExtension: WebExtension? = null
    private var workerPort: WebExtension.Port? = null
    private var relayClient: RelayWebSocketClient? = null
    private var chatRecoveryAttempt = 0
    private var chatRecoveryGeneration = 0
    private var readinessWatchGeneration = 0
    private var certificationNativePortLossArmed = false

    private val recentDeliveryIds = LinkedHashSet<String>()
    private var activeWake: RelayWake? = null
    private var activeSawBusy = false
    private var activeWakeUncertain = false
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
            if (port !== workerPort) return
            workerPort = null
            scheduleNativePortRecovery()
        }
    }

    private val messageDelegate = object : WebExtension.MessageDelegate {
        override fun onConnect(port: WebExtension.Port) {
            if (port.name != NATIVE_APP || port.sender.session !== workerSession) {
                port.disconnect()
                return
            }

            if (certificationNativePortLossArmed && certificationHooksAllowed()) {
                Log.w(
                    TAG,
                    "Recovery certification: suppressing native-port reconnect until bounded recovery starts",
                )
                port.disconnect()
                return
            }

            workerPort?.disconnect()
            workerPort = port
            port.setDelegate(portDelegate)
            readinessWatchGeneration += 1
            scheduleChatReadyTimeout("NATIVE_PORT_CONNECTED")
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
            Log.e(TAG, "Worker GeckoSession crashed; scheduling bounded recovery")
            scheduleChatRecovery("SESSION_CRASHED")
        }

        override fun onKill(session: GeckoSession) {
            Log.e(TAG, "Worker GeckoSession was killed; scheduling bounded recovery")
            scheduleChatRecovery("SESSION_KILLED")
        }
    }

    override fun onCreate() {
        super.onCreate()
        isRunning = true
        createNotificationChannel()
        startForeground(NOTIFICATION_ID, buildNotification())

        restoreRelayState()

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

                    workerExtension = extension
                    bindWorkerExtension(extension)
                    workerSession.loadUri(CHATGPT_URL)
                    scheduleChatReadyTimeout("INITIAL_LOAD")
                },
                { error ->
                    workerState = STATE_FAILED
                    updateNotification()
                    Log.e(TAG, "Unable to install Worker WebExtension", error)
                },
            )

        if (relayRequested) {
            connectRelay()
        }
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        startForeground(NOTIFICATION_ID, buildNotification())

        if (handleCertificationAction(intent?.action)) {
            return START_STICKY
        }

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
        chatRecoveryGeneration += 1
        readinessWatchGeneration += 1
        mainHandler.removeCallbacksAndMessages(null)
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

        runCatching { relayConfigStore.saveConfig(config) }
            .onFailure {
                relayClient?.stop()
                relayClient = null
                relayState = "PAIRING_STORE_FAILED"
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
        relayConfigStore.saveRelayRequested(true)
        connectRelay()
    }

    private fun stopRelay() {
        relayRequested = false
        relayConfigStore.saveRelayRequested(false)
        relayClient?.stop()
        relayClient = null
        relayState = if (appliedRelayConfig.relayUrl.isBlank()) "UNPAIRED" else "STOPPED"
        updateNotification()
    }

    private fun restoreRelayState() {
        val restored = relayConfigStore.loadConfig()
        if (restored != null && RelayProtocol.validateConfig(restored) == null) {
            appliedRelayConfig = restored
            activeWorkerId = restored.workerId
            relayRequested = relayConfigStore.loadRelayRequested()
            relayState = if (relayRequested) "CONNECTING" else "STOPPED"
        } else {
            relayRequested = false
            relayState = "UNPAIRED"
        }
        updateNotification()
    }

    private fun certificationHooksAllowed(): Boolean =
        (applicationInfo.flags and ApplicationInfo.FLAG_DEBUGGABLE) != 0 &&
            packageName.endsWith(CERTIFICATION_PACKAGE_SUFFIX)

    private fun handleCertificationAction(action: String?): Boolean {
        if (action == null || !action.startsWith("bke.worker.cert.")) {
            return false
        }
        if (!certificationHooksAllowed()) {
            Log.w(TAG, "Ignoring recovery-cert action outside debug recovery sidecar")
            return true
        }

        when (action) {
            ACTION_CERT_CRASH_CONTENT -> {
                Log.w(TAG, "Recovery certification: crashing Gecko content process")
                workerSession.loadUri("about:crashcontent")
            }
            ACTION_CERT_SIMULATE_CONTENT_KILL -> {
                Log.w(TAG, "Recovery certification: simulating Gecko content kill callback")
                contentDelegate.onKill(workerSession)
            }
            ACTION_CERT_NO_COMPOSER -> {
                Log.w(TAG, "Recovery certification: injecting bounded NO_COMPOSER status")
                handleWorkerStatus(
                    JSONObject()
                        .put("type", "worker_status")
                        .put("protocolVersion", RelayProtocol.VERSION)
                        .put("observedAt", "recovery-cert-" + System.currentTimeMillis())
                        .put("pageUrl", CHATGPT_URL)
                        .put("composerAvailable", false)
                        .put("turnBusy", false),
                )
            }
            ACTION_CERT_NATIVE_PORT_LOSS -> {
                Log.w(TAG, "Recovery certification: forcing persistent native-port loss")
                certificationNativePortLossArmed = true
                val port = workerPort
                workerPort = null
                runCatching { port?.disconnect() }
                scheduleNativePortRecovery()
            }
            ACTION_CERT_EXHAUST_RECOVERY -> {
                Log.w(TAG, "Recovery certification: forcing exhausted recovery boundary")
                activeWake = null
                activeSawBusy = false
                activeWakeUncertain = false
                chatRecoveryAttempt = CHAT_RECOVERY_MAX_ATTEMPTS
                scheduleChatRecovery("CERTIFICATION_EXHAUSTED")
            }
            ACTION_CERT_RESOLVE_UNCERTAIN_REJECT -> {
                val active = activeWake
                if (!activeWakeUncertain || active == null) {
                    Log.w(TAG, "Recovery certification: no uncertain wake to resolve")
                } else {
                    Log.w(TAG, "Recovery certification: explicitly rejecting uncertain wake")
                    relayClient?.sendAck(active.deliveryId, "rejected")
                    activeWake = null
                    activeSawBusy = false
                    activeWakeUncertain = false
                    workerState = STATE_RECOVERING
                    updateNotification()
                    scheduleChatRecovery("CERTIFICATION_UNCERTAIN_RESOLVED")
                }
            }
            else -> Log.w(TAG, "Ignoring unknown recovery-cert action")
        }
        return true
    }

    private fun scheduleNativePortRecovery() {
        val generation = ++readinessWatchGeneration
        mainHandler.postDelayed(
            {
                if (!isRunning) {
                    certificationNativePortLossArmed = false
                    return@postDelayed
                }
                if (generation != readinessWatchGeneration) {
                    certificationNativePortLossArmed = false
                    return@postDelayed
                }
                if (workerPort != null || activeWakeUncertain) {
                    certificationNativePortLossArmed = false
                    return@postDelayed
                }

                certificationNativePortLossArmed = false
                scheduleChatRecovery("NATIVE_PORT_DISCONNECTED")
            },
            NATIVE_PORT_RECOVERY_TIMEOUT_MS,
        )
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

    private fun bindWorkerExtension(extension: WebExtension) {
        workerSession.getWebExtensionController().setMessageDelegate(
            extension,
            messageDelegate,
            NATIVE_APP,
        )
    }

    private fun scheduleChatRecovery(reason: String) {
        if (!isRunning) return

        if (activeWake != null) {
            activeWakeUncertain = true
            activeSawBusy = false
        }

        workerPort?.disconnect()
        workerPort = null
        readinessWatchGeneration += 1

        if (chatRecoveryAttempt >= CHAT_RECOVERY_MAX_ATTEMPTS) {
            workerState = if (activeWakeUncertain) {
                STATE_BLOCKED_UNCERTAIN
            } else {
                STATE_FAILED
            }
            updateNotification()
            Log.e(
                TAG,
                "Chat target recovery exhausted after $chatRecoveryAttempt attempts: $reason",
            )
            return
        }

        workerState = if (activeWakeUncertain) {
            STATE_BLOCKED_UNCERTAIN
        } else {
            STATE_RECOVERING
        }
        updateNotification()

        val generation = ++chatRecoveryGeneration
        val delayMs = CHAT_RECOVERY_RETRY_DELAY_MS * chatRecoveryAttempt
        mainHandler.postDelayed(
            {
                if (!isRunning || generation != chatRecoveryGeneration) {
                    return@postDelayed
                }
                chatRecoveryAttempt += 1
                recoverChatTarget(generation, reason)
            },
            delayMs,
        )
    }

    private fun recoverChatTarget(generation: Int, reason: String) {
        runCatching {
            if (!workerSession.isOpen) {
                workerSession.open(runtime)
            }
            workerExtension?.let(::bindWorkerExtension)
            workerSession.loadUri(CHATGPT_URL)
        }.onFailure { error ->
            Log.e(TAG, "Unable to recover ChatGPT target: $reason", error)
            scheduleChatRecovery("RECOVERY_OPEN_FAILED")
            return
        }

        scheduleChatReadyTimeout("RECOVERY_ATTEMPT_$chatRecoveryAttempt", generation)
    }

    private fun scheduleChatReadyTimeout(
        reason: String,
        recoveryGeneration: Int = chatRecoveryGeneration,
    ) {
        val readinessGeneration = ++readinessWatchGeneration
        mainHandler.postDelayed(
            {
                if (!isRunning ||
                    recoveryGeneration != chatRecoveryGeneration ||
                    readinessGeneration != readinessWatchGeneration ||
                    workerState == STATE_READY ||
                    workerState == STATE_BUSY ||
                    workerState == STATE_BLOCKED_UNCERTAIN
                ) {
                    return@postDelayed
                }
                scheduleChatRecovery("CHAT_READY_TIMEOUT:$reason")
            },
            CHAT_READY_TIMEOUT_MS,
        )
    }

    private fun markChatSurfaceResponsive() {
        chatRecoveryAttempt = 0
        chatRecoveryGeneration += 1
        readinessWatchGeneration += 1
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

        val previousState = workerState
        val composerAvailable = message.optBoolean("composerAvailable")
        val turnBusy = message.optBoolean("turnBusy")
        val observedState = when {
            turnBusy -> STATE_BUSY
            composerAvailable -> STATE_READY
            else -> STATE_NO_COMPOSER
        }

        workerState = if (activeWakeUncertain && observedState == STATE_READY) {
            STATE_BLOCKED_UNCERTAIN
        } else {
            observedState
        }

        if (observedState == STATE_READY || observedState == STATE_BUSY) {
            markChatSurfaceResponsive()
        } else if (!activeWakeUncertain && previousState != STATE_NO_COMPOSER) {
            scheduleChatReadyTimeout("NO_COMPOSER")
        }

        val active = activeWake
        if (active != null && !activeWakeUncertain) {
            if (turnBusy) {
                activeSawBusy = true
            } else if (activeSawBusy && workerState == STATE_READY) {
                relayClient?.sendAck(active.deliveryId, "completed")
                activeWake = null
                activeSawBusy = false
                activeWakeUncertain = false
                maybeDispatchPendingWake()
            }
        } else if (active == null && workerState == STATE_READY) {
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
        activeWakeUncertain = false
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
        activeWakeUncertain = false

        runCatching { port.postMessage(command) }
            .onFailure {
                relayClient?.sendAck(wake.deliveryId, "rejected")
                activeWake = null
                activeSawBusy = false
                activeWakeUncertain = false
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
