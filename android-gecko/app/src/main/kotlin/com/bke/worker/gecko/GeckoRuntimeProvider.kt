package com.bke.worker.gecko

import android.content.Context
import org.mozilla.geckoview.GeckoRuntime

/**
 * Gecko permits one active runtime per Android process.
 * Keep it at application lifetime rather than Activity lifetime.
 */
object GeckoRuntimeProvider {
    @Volatile
    private var instance: GeckoRuntime? = null

    fun get(context: Context): GeckoRuntime {
        instance?.let { return it }

        return synchronized(this) {
            instance ?: GeckoRuntime.create(context.applicationContext).also {
                instance = it
            }
        }
    }
}
