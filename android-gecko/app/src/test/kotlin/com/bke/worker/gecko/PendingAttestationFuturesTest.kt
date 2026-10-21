package com.bke.worker.gecko

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import java.util.concurrent.CompletableFuture

class PendingAttestationFuturesTest {
    @Test
    fun closeSettlesOutstandingFutureAndLateSignerResultCannotReplaceIt() {
        val registry = PendingAttestationFutures<String>()
        val future = registry.create()

        assertFalse(future.isDone)
        assertEquals(1, registry.pendingCountForTest())

        registry.close()

        assertTrue(future.isDone)
        assertNull(future.get())
        assertFalse(registry.complete(future, "late-evidence"))
        assertNull(future.get())
        assertEquals(0, registry.pendingCountForTest())
    }

    @Test
    fun futureCreatedAfterCloseIsImmediatelySettled() {
        val registry = PendingAttestationFutures<String>()
        registry.close()

        val future = registry.create()

        assertTrue(future.isDone)
        assertNull(future.get())
        assertEquals(0, registry.pendingCountForTest())
    }

    @Test
    fun successfulCompletionRemovesFutureFromPendingRegistry() {
        val registry = PendingAttestationFutures<String>()
        val future = registry.create()

        assertTrue(registry.complete(future, "evidence"))
        assertEquals("evidence", future.get())
        assertEquals(0, registry.pendingCountForTest())
        assertFalse(registry.complete(future, null))
    }

    @Test
    fun closeSettlesEveryOutstandingFuture() {
        val registry = PendingAttestationFutures<String>()
        val futures = List(8) { registry.create() }

        registry.close()

        assertTrue(futures.all { it.isDone && it.get() == null })
        assertEquals(0, registry.pendingCountForTest())
    }
}
