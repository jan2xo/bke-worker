package com.bke.worker.gecko

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class PeerTargetObservationGateTest {
    private val chat = "https://chatgpt.com/"
    private val other = "https://example.com/"

    @Test
    fun delayedOldPageStatusCannotRestoreTargetAfterNavigationAway() {
        val gate = PeerTargetObservationGate()
        gate.locationChanged(chat, 100L)
        assertEquals(PeerStatusAcceptance.ACCEPTED, gate.acceptStatus(chat, 200L, 1L, 201L))
        assertTrue(gate.isObservationCurrent(202L))

        gate.navigationStarted(300L)
        gate.locationChanged(other, 310L)
        // A status generated before navigation arrives later with a newer transport sequence.
        assertEquals(PeerStatusAcceptance.REJECTED, gate.acceptStatus(chat, 250L, 2L, 320L))
        assertFalse(gate.isObservationCurrent(321L))
    }

    @Test
    fun delayedOldStatusCannotRestoreTargetAfterSameOriginNavigation() {
        val gate = PeerTargetObservationGate()
        gate.locationChanged(chat, 100L)
        assertEquals(PeerStatusAcceptance.ACCEPTED, gate.acceptStatus(chat, 200L, 1L, 201L))

        gate.navigationStarted(300L)
        gate.locationChanged("https://chatgpt.com/new", 310L)
        assertEquals(PeerStatusAcceptance.REJECTED, gate.acceptStatus(chat, 250L, 2L, 320L))
        assertFalse(gate.isObservationCurrent(321L))

        // Only an observation timestamped after the latest trusted navigation can recover.
        assertEquals(
            PeerStatusAcceptance.ACCEPTED,
            gate.acceptStatus("https://chatgpt.com/new", 311L, 3L, 320L),
        )
        assertTrue(gate.isObservationCurrent(321L))
    }

    @Test
    fun delayedOutOfOrderStatusDoesNotOverwriteNewerObservation() {
        val gate = PeerTargetObservationGate()
        gate.locationChanged(chat, 100L)
        assertEquals(PeerStatusAcceptance.ACCEPTED, gate.acceptStatus(chat, 200L, 2L, 201L))
        val accepted = gate.snapshot()

        assertEquals(
            PeerStatusAcceptance.IGNORED_OUT_OF_ORDER,
            gate.acceptStatus(other, 190L, 1L, 202L),
        )
        assertEquals(accepted, gate.snapshot())
        assertTrue(gate.isObservationCurrent(203L))
    }

    @Test
    fun snapshotBecomesInvalidWhileSignerIsRunningAndNavigationArrives() {
        val gate = PeerTargetObservationGate()
        gate.locationChanged(chat, 1_000L)
        assertEquals(PeerStatusAcceptance.ACCEPTED, gate.acceptStatus(chat, 1_100L, 1L, 1_101L))
        val snapshotBeforeSigning = gate.snapshot()
        assertTrue(gate.matches(snapshotBeforeSigning, 1_102L))

        // Models the main-thread navigation callback running while the expensive signer is
        // on a worker thread. Release must compare against the exact pre-sign snapshot.
        gate.navigationStarted(1_103L)
        gate.locationChanged(other, 1_104L)
        assertFalse(gate.matches(snapshotBeforeSigning, 1_105L))
    }

    @Test
    fun staleFutureWrongOriginAndMissingReportsFailClosed() {
        val gate = PeerTargetObservationGate()
        gate.locationChanged(chat, 1_000L)
        assertEquals(PeerStatusAcceptance.REJECTED, gate.acceptStatus(chat, 999L, 1L, 1_010L))
        assertEquals(PeerStatusAcceptance.REJECTED, gate.acceptStatus(chat, 1_011L, 2L, 1_010L))
        assertEquals(PeerStatusAcceptance.REJECTED, gate.acceptStatus(other, 1_012L, 3L, 1_013L))
        assertFalse(gate.isObservationCurrent(1_014L))
    }

    @Test
    fun onlyFreshExactOriginReportFollowingLocationChangeIsUsable() {
        val gate = PeerTargetObservationGate()
        gate.navigationStarted(5_000L)
        gate.locationChanged(chat, 5_010L)
        assertEquals(PeerStatusAcceptance.ACCEPTED, gate.acceptStatus(chat, 5_011L, 1L, 5_012L))
        assertTrue(gate.isObservationCurrent(5_013L))
        assertFalse(gate.isObservationCurrent(15_012L))
    }
}
