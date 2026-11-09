package com.contour.app.indoor

import org.junit.Assert.*
import org.junit.Test
import kotlin.math.exp

class FloorEstimatorTest {
    @Test fun trustedSdkFloorAnchorsRelativeMotionAndTrackingPauseKeepsTheFloor() {
        val estimator = FloorEstimator()
        estimator.observeIndoorFloor(3)
        estimator.observeVisualHeight(10.0, 0)
        estimator.observeVisualHeight(6.5, 1000)
        estimator.observeVisualHeight(6.5, 4000)
        assertEquals(2, estimator.estimate().floor)
        estimator.observeVisualHeight(null, 5000)
        estimator.observeVisualHeight(25.0, 6000)
        assertEquals(2, estimator.estimate().floor)
        estimator.correctFloor(4)
        assertEquals(4, estimator.estimate().floor)
        assertEquals("corrected", estimator.estimate().source)
    }

    @Test fun cameraMotionUpdatesCorrectedFloorButTrackingLossRebasesTheWorldOrigin() {
        val estimator = FloorEstimator()
        estimator.observeVisualHeight(0.0, 0)
        estimator.observeVisualHeight(-3.5, 5000)
        assertNull(estimator.estimate().floor)
        estimator.correctFloor(3)
        estimator.observeVisualHeight(0.0, 0)
        estimator.observeVisualHeight(-3.5, 1000)
        estimator.observeVisualHeight(-3.5, 4000)
        assertEquals(2, estimator.estimate().floor)
        assertEquals("camera-motion-estimate", estimator.estimate().source)
        estimator.observeVisualHeight(null, 5000)
        estimator.observeVisualHeight(30.0, 6000)
        estimator.observeVisualHeight(30.0, 10000)
        assertEquals(2, estimator.estimate().floor)
    }
    @Test fun stepsAndPressureAloneDoNotInventStartingFloor() {
        val estimator = FloorEstimator()
        repeat(30) { estimator.step(); estimator.observePressure(1000.0 - it, it * 1000L) }
        assertNull(estimator.estimate().floor)
    }

    @Test fun altitudeEstimateCarriesUncertaintyAndRejectsInvalidValues() {
        val estimator = FloorEstimator()
        estimator.observeMslAltitude(Double.NaN, 1.0)
        estimator.observeMslAltitude(42.1, 30.0)
        assertNull(estimator.estimate().floor)
        estimator.observeMslAltitude(42.1, 5.0)
        assertEquals(2, estimator.estimate().floor)
        assertEquals(2, estimator.estimate().uncertaintyFloors)
    }

    @Test fun floorCorrectionWinsOverGpsAndPressureNeedsWalkingEvidence() {
        val estimator = FloorEstimator()
        estimator.observePressure(1000.0, 0)
        estimator.correctFloor(3)
        estimator.observeMslAltitude(38.6, 0.1)
        val downstairsPressure = 1000.0 * exp(3.5 / 8434.5)
        repeat(80) { estimator.observePressure(downstairsPressure, it * 100L) }
        assertEquals(3, estimator.estimate().floor)
        repeat(12) { estimator.step() }
        repeat(80) { estimator.observePressure(downstairsPressure, 8000L + it * 100L) }
        assertEquals(2, estimator.estimate().floor)
        assertEquals("pressure-and-steps-estimate", estimator.estimate().source)
        estimator.correctFloor(4)
        assertEquals(4, estimator.estimate().floor)
    }
}
