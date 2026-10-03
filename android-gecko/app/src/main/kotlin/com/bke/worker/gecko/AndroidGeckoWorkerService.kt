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

class AndroidGeckoWorkerService : Service() {
    companion object {
        private const val TAG = "BkeWorkerGecko"
        private const val CHANNEL_ID = "bke_worker_gecko_probe"
        private const val NOTIFICATION_ID = 41801

        private const val WORKER_ID = "android-worker-a"
        private const val CHATGPT_URL = "https://chatgpt.com/"
        private const val EXTENSION_URI = "resource://android/assets/worker-extension/"
        private const val EXTENSION_ID = "bke-worker-gecko-probe@jl-bke.com"
        private const val NATIVE_APP = "bke.worker.gecko"

        private const val STATE_STARTING = "STARTING"
        private const val STATE_READY = "READY"
        private const val STATE_BUSY = "BUSY"
        private const val STATE_NO_COMPOSER = "NO_COMPOSER"
        private const val STATE_FAILED = "FAILED"

        @Volatile
        var isRunning: Boolean = false
            private set

        fun ensureRunning(context: Context) {
            val app = context.applicationContext
            val intent = Intent(app, AndroidGeckoWorkerService::class.java)
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                app.startForegroundService(intent)
            } else {
                app.startService(intent)
            }
        }

        fun stop(context: Context) {
            context.applicationContext.stopService(
                Intent(context.applicationContext, AndroidGeckoWorkerService::class.java),
            )
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
    private var workerState = STATE_STARTING

    fun session(): GeckoSession = workerSession

    private val messageDelegate = object : WebExtension.MessageDelegate {
        override fun onMessage(
            nativeApp: String,
            message: Any,
            sender: WebExtension.MessageSender,
        ): GeckoResult<Any>? {
            if (nativeApp != NATIVE_APP || message !is JSONObject) {
                return null
            }

            val expectedKeys = setOf(
                "type",
                "protocolVersion",
                "observedAt",
                "pageUrl",
                "composerAvailable",
                "turnBusy",
            )
            val actualKeys = buildSet {
                val iterator = message.keys()
                while (iterator.hasNext()) add(iterator.next())
            }

            if (actualKeys != expectedKeys ||
                message.optString("type") != "worker_status" ||
                message.optInt("protocolVersion", -1) != 1
            ) {
                Log.w(TAG, "Rejected malformed Worker probe message")
                return null
            }

            val pageUrl = message.optString("pageUrl")
            if (!isChatGptUrl(pageUrl)) {
                Log.w(TAG, "Rejected non-ChatGPT Worker probe message")
                return null
            }

            if (message.optString("observedAt").isBlank() ||
                !message.has("composerAvailable") ||
                !message.has("turnBusy")
            ) {
                Log.w(TAG, "Rejected incomplete Worker probe message")
                return null
            }

            val composerAvailable = message.optBoolean("composerAvailable")
            val turnBusy = message.optBoolean("turnBusy")
            workerState = when {
                turnBusy -> STATE_BUSY
                composerAvailable -> STATE_READY
                else -> STATE_NO_COMPOSER
            }
            updateNotification()
            Log.d(TAG, "worker=$WORKER_ID state=$workerState")
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
        return START_STICKY
    }

    override fun onBind(intent: Intent?): IBinder = binder

    override fun onDestroy() {
        isRunning = false
        runCatching { workerSession.close() }
            .onFailure { Log.w(TAG, "Unable to close Worker GeckoSession cleanly", it) }
        super.onDestroy()
    }

    private fun createNotificationChannel() {
        val manager = getSystemService(NotificationManager::class.java)
        val channel = NotificationChannel(
            CHANNEL_ID,
            "BKE Worker Gecko",
            NotificationManager.IMPORTANCE_LOW,
        ).apply {
            description = "Keeps the experimental BKE Worker Gecko session alive."
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
            .setContentText("$WORKER_ID • $workerState")
            .setContentIntent(pendingIntent)
            .setCategory(Notification.CATEGORY_SERVICE)
            .setOngoing(true)
            .setOnlyAlertOnce(true)
            .build()
    }
}
