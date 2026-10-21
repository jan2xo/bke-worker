package com.bke.worker.gecko

import java.util.concurrent.CompletableFuture
import java.util.concurrent.ConcurrentHashMap

/**
 * Tracks in-flight asynchronous attestation requests so service shutdown cannot strand callers.
 *
 * Completion is one-shot: closing the registry settles every outstanding request with null;
 * a late signer result cannot overwrite that shutdown result.
 */
internal class PendingAttestationFutures<T> {
    private val pending = ConcurrentHashMap.newKeySet<CompletableFuture<T?>>()

    @Volatile
    private var closed = false

    fun create(): CompletableFuture<T?> {
        val future = CompletableFuture<T?>()
        if (closed) {
            future.complete(null)
            return future
        }

        pending.add(future)
        future.whenComplete { _, _ -> pending.remove(future) }

        // Close may race with registration between the first check and pending.add().
        if (closed) {
            future.complete(null)
        }
        return future
    }

    fun complete(future: CompletableFuture<T?>, value: T?): Boolean {
        return future.complete(value)
    }

    fun close() {
        closed = true
        // Concurrent registration performs a second closed check, so every request is settled.
        pending.toList().forEach { it.complete(null) }
        pending.clear()
    }

    internal fun pendingCountForTest(): Int = pending.size
}
