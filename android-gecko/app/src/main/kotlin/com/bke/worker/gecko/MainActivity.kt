package com.bke.worker.gecko

import android.Manifest
import android.app.Activity
import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.content.ServiceConnection
import android.content.pm.PackageManager
import android.graphics.Color
import android.graphics.Typeface
import android.graphics.drawable.GradientDrawable
import android.os.Build
import android.os.Bundle
import android.os.Handler
import android.os.IBinder
import android.os.Looper
import android.text.InputType
import android.view.View
import android.view.ViewGroup
import android.view.WindowInsets
import android.widget.Button
import android.widget.EditText
import android.widget.LinearLayout
import android.widget.TextView
import org.mozilla.geckoview.GeckoView

class MainActivity : Activity() {
    private lateinit var root: LinearLayout
    private lateinit var geckoView: GeckoView
    private lateinit var status: TextView
    private lateinit var workerIdInput: EditText
    private lateinit var relayUrlInput: EditText
    private lateinit var relayTokenInput: EditText

    private var workerService: AndroidGeckoWorkerService? = null
    private var bound = false
    private var browserAttached = false
    private var renderedRecoverySequence = 0

    private val statusHandler = Handler(Looper.getMainLooper())
    private val statusPoll = object : Runnable {
        override fun run() {
            renderWorkerStatus()
            if (bound) {
                statusHandler.postDelayed(this, 500)
            }
        }
    }

    private val connection = object : ServiceConnection {
        override fun onServiceConnected(name: ComponentName?, binder: IBinder?) {
            val local = binder as? AndroidGeckoWorkerService.LocalBinder ?: return
            workerService = local.service()
            bound = true
            hydrateAppliedConfig()
            attachSession()
            startStatusUpdates()
        }

        override fun onServiceDisconnected(name: ComponentName?) {
            stopStatusUpdates()
            detachSession()
            workerService = null
            bound = false
            renderWorkerStatus()
        }
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)

        root = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setBackgroundColor(COLOR_BACKGROUND)
            setPadding(dp(18), dp(18), dp(18), dp(20))
            setOnApplyWindowInsetsListener { view, insets ->
                val topInset = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
                    insets.getInsets(
                        WindowInsets.Type.statusBars() or WindowInsets.Type.displayCutout(),
                    ).top
                } else {
                    @Suppress("DEPRECATION")
                    val statusBarInset = insets.systemWindowInsetTop
                    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) {
                        @Suppress("DEPRECATION")
                        maxOf(statusBarInset, insets.displayCutout?.safeInsetTop ?: 0)
                    } else {
                        statusBarInset
                    }
                }

                view.setPadding(
                    view.paddingLeft,
                    topInset + dp(12),
                    view.paddingRight,
                    view.paddingBottom,
                )
                insets
            }
        }

        val header = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(0, 0, 0, dp(8))
        }
        header.addView(TextView(this).apply {
            text = "BKE WORKER"
            textSize = 12f
            setTextColor(COLOR_ACCENT)
            typeface = Typeface.DEFAULT_BOLD
            letterSpacing = 0.08f
        })
        root.addView(header)

        val statusCard = compactCardContainer()
        statusCard.addView(cardEyebrow("LIVE STATUS"))
        status = TextView(this).apply {
            text = "BROWSER: DETACHED\nCHAT: STARTING\nRELAY: STOPPED\nLAST RECOVERY: NONE\nRECOVERY SEQ: 0\nWORKER ID: android-worker-a"
            textSize = 12f
            setTextColor(COLOR_TEXT_SECONDARY)
            typeface = Typeface.MONOSPACE
        }
        statusCard.addView(status)

        val runtimeControls = LinearLayout(this).apply {
            orientation = LinearLayout.HORIZONTAL
            setPadding(0, dp(8), 0, 0)
        }

        val startRelay = Button(this).apply {
            text = "Start"
            textSize = 12f
            setAllCaps(false)
            typeface = Typeface.DEFAULT_BOLD
            setOnClickListener {
                requestNotificationPermissionIfNeeded()
                AndroidGeckoWorkerService.startRelay(this@MainActivity)
                bindWorker()
            }
        }
        runtimeControls.addView(
            startRelay,
            LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f).apply {
                marginEnd = dp(4)
            },
        )

        val stopRelay = Button(this).apply {
            text = "Stop"
            textSize = 12f
            setAllCaps(false)
            typeface = Typeface.DEFAULT_BOLD
            setOnClickListener {
                AndroidGeckoWorkerService.stopRelay(this@MainActivity)
                renderWorkerStatus()
            }
        }
        runtimeControls.addView(
            stopRelay,
            LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f).apply {
                marginStart = dp(4)
            },
        )
        statusCard.addView(runtimeControls)
        root.addView(statusCard)

        val configCard = compactCardContainer()
        configCard.visibility = View.GONE

        val configToggle = TextView(this).apply {
            text = "WORKER CONFIGURATION ▾"
            textSize = 12f
            setTextColor(COLOR_ACCENT)
            typeface = Typeface.DEFAULT_BOLD
            letterSpacing = 0.08f
            setPadding(dp(2), dp(2), 0, dp(8))
            setOnClickListener {
                val expanded = configCard.visibility == View.VISIBLE
                configCard.visibility = if (expanded) View.GONE else View.VISIBLE
                text = if (expanded) "WORKER CONFIGURATION ▾" else "WORKER CONFIGURATION ▴"
            }
        }
        root.addView(configToggle)

        workerIdInput = EditText(this).apply {
            hint = "Worker ID"
            setText("android-worker-a")
            isSingleLine = true
        }
        configCard.addView(workerIdInput, fieldLayoutParams())

        relayUrlInput = EditText(this).apply {
            hint = "Relay URL"
            isSingleLine = true
            inputType = InputType.TYPE_CLASS_TEXT or InputType.TYPE_TEXT_VARIATION_URI
        }
        configCard.addView(relayUrlInput, fieldLayoutParams())

        relayTokenInput = EditText(this).apply {
            hint = "Runtime relay token"
            isSingleLine = true
            inputType = InputType.TYPE_CLASS_TEXT or InputType.TYPE_TEXT_VARIATION_PASSWORD
        }
        configCard.addView(relayTokenInput, fieldLayoutParams())

        val apply = Button(this).apply {
            text = "Apply"
            textSize = 12f
            setAllCaps(false)
            typeface = Typeface.DEFAULT_BOLD
            setOnClickListener {
                requestNotificationPermissionIfNeeded()
                AndroidGeckoWorkerService.applyRelayConfig(
                    context = this@MainActivity,
                    workerId = workerIdInput.text.toString().trim(),
                    relayUrl = relayUrlInput.text.toString().trim(),
                    relayToken = relayTokenInput.text.toString(),
                )
                bindWorker()
            }
        }
        configCard.addView(apply, fieldLayoutParams(last = true))
        root.addView(configCard)

        geckoView = GeckoView(this)
        root.addView(
            geckoView,
            LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT,
                0,
                1f,
            ).apply {
                topMargin = dp(2)
            },
        )

        setContentView(root)
        root.requestApplyInsets()
    }

    override fun onStart() {
        super.onStart()
        requestNotificationPermissionIfNeeded()
        AndroidGeckoWorkerService.ensureBrowserRunning(this)
        bindWorker()
    }

    override fun onStop() {
        stopStatusUpdates()
        detachSession()
        unbindWorker()
        super.onStop()
    }

    private fun bindWorker() {
        if (bound) {
            hydrateAppliedConfig()
            attachSession()
            startStatusUpdates()
            return
        }

        bindService(
            Intent(this, AndroidGeckoWorkerService::class.java),
            connection,
            Context.BIND_AUTO_CREATE,
        )
    }

    private fun unbindWorker() {
        if (!bound) return
        unbindService(connection)
        bound = false
        workerService = null
    }

    private fun hydrateAppliedConfig() {
        val config = workerService?.appliedRelayConfig() ?: return
        workerIdInput.setText(config.workerId)
        relayUrlInput.setText(config.relayUrl)
        relayTokenInput.setText(config.bearerToken)
    }

    private fun attachSession() {
        val session = workerService?.session() ?: return
        runCatching {
            geckoView.setSession(session)
        }.onSuccess {
            browserAttached = true
            renderWorkerStatus()
        }.onFailure {
            browserAttached = false
            status.text = "BROWSER: ATTACH_FAILED\nCHAT: UNKNOWN\nRELAY: UNKNOWN\nWORKER ID: —"
        }
    }

    private fun detachSession() {
        runCatching {
            geckoView.releaseSession()
        }
        browserAttached = false
    }

    private fun startStatusUpdates() {
        statusHandler.removeCallbacks(statusPoll)
        renderWorkerStatus()
        statusHandler.postDelayed(statusPoll, 500)
    }

    private fun stopStatusUpdates() {
        statusHandler.removeCallbacks(statusPoll)
    }

    private fun renderWorkerStatus() {
        val snapshot = workerService?.statusSnapshot()
        if (snapshot == null) {
            status.text = buildString {
                appendLine("BROWSER: " + if (browserAttached) "ATTACHED" else "DETACHED")
                appendLine("CHAT: STARTING")
                appendLine("RELAY: STOPPED")
                appendLine("LAST RECOVERY: NONE")
                appendLine("RECOVERY SEQ: 0")
                append("WORKER ID: android-worker-a")
            }
            return
        }

        status.text = buildString {
            appendLine("BROWSER: " + if (browserAttached) "ATTACHED" else "DETACHED")
            appendLine("CHAT: " + snapshot.chatGptState)
            appendLine("RELAY: " + snapshot.relayState)
            appendLine("LAST RECOVERY: " + (snapshot.lastRecoveryReason ?: "NONE"))
            appendLine("RECOVERY SEQ: " + snapshot.recoverySequence)
            append("WORKER ID: " + snapshot.workerId)
        }

        if (snapshot.recoverySequence > renderedRecoverySequence &&
            (snapshot.chatGptState == "READY" || snapshot.chatGptState == "BUSY")
        ) {
            reattachGeckoSurfaceAfterRecovery(snapshot.recoverySequence)
        }
    }

    private fun reattachGeckoSurfaceAfterRecovery(recoverySequence: Int) {
        val session = workerService?.session() ?: return
        geckoView.post {
            runCatching {
                geckoView.releaseSession()
                geckoView.setSession(session)
                root.requestLayout()
                root.invalidate()
                geckoView.requestLayout()
                geckoView.invalidate()
                geckoView.postInvalidateOnAnimation()
            }.onSuccess {
                browserAttached = true
                renderedRecoverySequence = recoverySequence
            }.onFailure {
                browserAttached = false
                status.text =
                    "BROWSER: ATTACH_FAILED\nCHAT: UNKNOWN\nRELAY: UNKNOWN\nWORKER ID: —"
            }
        }
    }

    private fun compactCardContainer(): LinearLayout = LinearLayout(this).apply {
        orientation = LinearLayout.VERTICAL
        setPadding(dp(12), dp(10), dp(12), dp(10))
        background = roundedBackground(COLOR_CARD, COLOR_CARD_STROKE, 16)
        layoutParams = LinearLayout.LayoutParams(
            ViewGroup.LayoutParams.MATCH_PARENT,
            ViewGroup.LayoutParams.WRAP_CONTENT,
        ).apply {
            bottomMargin = dp(10)
        }
    }

    private fun cardEyebrow(label: String): TextView = TextView(this).apply {
        text = label
        textSize = 11f
        setTextColor(COLOR_ACCENT)
        typeface = Typeface.DEFAULT_BOLD
        letterSpacing = 0.08f
        setPadding(0, 0, 0, dp(5))
    }

    private fun fieldLayoutParams(last: Boolean = false): LinearLayout.LayoutParams =
        LinearLayout.LayoutParams(
            ViewGroup.LayoutParams.MATCH_PARENT,
            ViewGroup.LayoutParams.WRAP_CONTENT,
        ).apply {
            bottomMargin = if (last) dp(8) else dp(6)
        }

    private fun roundedBackground(fillColor: Int, strokeColor: Int, radiusDp: Int): GradientDrawable =
        GradientDrawable().apply {
            shape = GradientDrawable.RECTANGLE
            setColor(fillColor)
            cornerRadius = dp(radiusDp).toFloat()
            setStroke(dp(1), strokeColor)
        }

    private fun dp(value: Int): Int =
        (value * resources.displayMetrics.density + 0.5f).toInt()

    private fun requestNotificationPermissionIfNeeded() {
        if (Build.VERSION.SDK_INT >= 33 &&
            checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED
        ) {
            requestPermissions(
                arrayOf(Manifest.permission.POST_NOTIFICATIONS),
                41802,
            )
        }
    }

    companion object {
        private val COLOR_BACKGROUND = Color.rgb(17, 20, 23)
        private val COLOR_CARD = Color.rgb(24, 29, 33)
        private val COLOR_CARD_STROKE = Color.rgb(49, 58, 65)
        private val COLOR_TEXT_PRIMARY = Color.rgb(242, 245, 247)
        private val COLOR_TEXT_SECONDARY = Color.rgb(180, 190, 198)
        private val COLOR_ACCENT = Color.rgb(121, 216, 196)
    }
}
