package com.contour.app.ar

import org.junit.Assert.*
import org.junit.Test

class TrackingQualityTest {
    @Test fun waitsForStableAccuracyAndUsesHysteresis() {
        val quality = TrackingQuality()
        assertFalse(quality.update(true, 2.0, 4.0, 8.0, 100))
        assertFalse(quality.update(true, 2.0, 4.0, 8.0, 2099))
        assertTrue(quality.update(true, 2.0, 4.0, 8.0, 2100))
        assertTrue(quality.update(true, 4.0, 7.0, 14.0, 2200))
        assertFalse(quality.update(true, 5.1, 7.0, 14.0, 2300))
        assertFalse(quality.update(true, 4.0, 7.0, 14.0, 8000))
    }

    @Test fun trackingLossRequiresLocalizationAgain() {
        val quality = TrackingQuality()
        quality.update(true, 1.0, 1.0, 1.0, 0)
        assertTrue(quality.update(true, 1.0, 1.0, 1.0, 2000))
        assertFalse(quality.update(false, 1.0, 1.0, 1.0, 2100))
        assertFalse(quality.update(true, 1.0, 1.0, 1.0, 2200))
        assertTrue(quality.update(true, 1.0, 1.0, 1.0, 4200))
    }

    @Test fun rejectsInvalidAccuracyAndResetsTheDwellTimer() {
        val quality = TrackingQuality()
        for (bad in listOf(Double.NaN, Double.POSITIVE_INFINITY, -1.0)) {
            assertFalse(quality.update(true, bad, 1.0, 1.0, 0))
            assertFalse(quality.update(true, 1.0, bad, 1.0, 5000))
            assertFalse(quality.update(true, 1.0, 1.0, bad, 10000))
        }
        assertFalse(quality.update(true, 1.0, 1.0, 1.0, 11000))
        quality.reset()
        assertFalse(quality.update(true, 1.0, 1.0, 1.0, 15000))
    }
}
