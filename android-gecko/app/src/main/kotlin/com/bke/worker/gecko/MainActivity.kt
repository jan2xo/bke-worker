package com.bke.worker.gecko

import android.Manifest
import android.app.Activity
import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.content.ServiceConnection
import android.content.pm.PackageManager
import android.os.Build
import android.os.Bundle
import android.os.IBinder
import android.text.InputType
import android.view.ViewGroup
import android.widget.Button
import android.widget.EditText
import android.widget.LinearLayout
import android.widget.TextView
import org.mozilla.geckoview.GeckoView

class MainActivity : Activity() {
    private lateinit var geckoView: GeckoView
    private lateinit var status: TextView
    private lateinit var workerIdInput: EditText
    private lateinit var relayUrlInput: EditText
    private lateinit var relayTokenInput: EditText

    private var workerService: AndroidGeckoWorkerService? = null
    private var bound = false

    private val connection = object : ServiceConnection {
        override fun onServiceConnected(name: ComponentName?, binder: IBinder?) {
            val local = binder as? AndroidGeckoWorkerService.LocalBinder ?: return
            workerService = local.service()
            bound = true
            attachSession()
            status.text = "Worker: CONNECTED — browser session attached"
        }

        override fun onServiceDisconnected(name: ComponentName?) {
            detachSession()
            workerService = null
            bound = false
            status.text = "Worker: DISCONNECTED"
        }
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)

        val root = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(20, 28, 20, 20)
        }

        status = TextView(this).apply {
            text = "Worker: STOPPED"
            textSize = 16f
        }
        root.addView(status)

        workerIdInput = EditText(this).apply {
            hint = "Worker ID"
            setText("android-worker-a")
            isSingleLine = true
        }
        root.addView(workerIdInput)

        relayUrlInput = EditText(this).apply {
            hint = "Relay URL (future wss://...) — blank = browser only"
            isSingleLine = true
            inputType = InputType.TYPE_CLASS_TEXT or InputType.TYPE_TEXT_VARIATION_URI
        }
        root.addView(relayUrlInput)

        relayTokenInput = EditText(this).apply {
            hint = "Runtime relay token (not persisted)"
            isSingleLine = true
            inputType = InputType.TYPE_CLASS_TEXT or InputType.TYPE_TEXT_VARIATION_PASSWORD
        }
        root.addView(relayTokenInput)

        val start = Button(this).apply {
            text = "START / APPLY WORKER"
            setOnClickListener {
                requestNotificationPermissionIfNeeded()
                AndroidGeckoWorkerService.ensureRunning(
                    context = this@MainActivity,
                    workerId = workerIdInput.text.toString().trim(),
                    relayUrl = relayUrlInput.text.toString().trim(),
                    relayToken = relayTokenInput.text.toString(),
                )
                bindWorker()
            }
        }
        root.addView(start)

        val stop = Button(this).apply {
            text = "STOP WORKER"
            setOnClickListener {
                detachSession()
                unbindWorker()
                AndroidGeckoWorkerService.stop(this@MainActivity)
                status.text = "Worker: STOPPED"
            }
        }
        root.addView(stop)

        val note = TextView(this).apply {
            text = "ChatGPT authentication is manual. The relay token stays in service memory only. Backgrounding detaches this view without closing the service-owned GeckoSession."
        }
        root.addView(note)

        geckoView = GeckoView(this)
        root.addView(
            geckoView,
            LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT,
                0,
                1f,
            ),
        )

        setContentView(root)
    }

    override fun onStart() {
        super.onStart()
        if (AndroidGeckoWorkerService.isRunning) {
            bindWorker()
        }
    }

    override fun onStop() {
        detachSession()
        unbindWorker()
        super.onStop()
    }

    private fun bindWorker() {
        if (bound) {
            attachSession()
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

    private fun attachSession() {
        val session = workerService?.session() ?: return
        runCatching {
            geckoView.setSession(session)
        }.onFailure {
            status.text = "Worker: SESSION_ATTACH_FAILED"
        }
    }

    private fun detachSession() {
        runCatching {
            geckoView.releaseSession()
        }
    }

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
}
