package com.contour.app.ar

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class DepthObstacleClassifierTest {
    private val near = IntArray(25) { if (it < 8) 900 else 3000 }
    private val start = 1_000_000_000L
    private val far = IntArray(25) { 3000 }
    private val unknown = IntArray(25)

    private fun DepthObstacleClassifier.center(
        samples: IntArray, frame: Long, depth: Long, tracking: Boolean, tilt: Float,
    ) = update(unknown, samples, unknown, frame, depth, tracking, tilt).possibleObstacle

    private fun stable(left: IntArray, center: IntArray, right: IntArray): DepthObstacleClassifier.Observation {
        val classifier = DepthObstacleClassifier()
        var result = classifier.update(left, center, right, start, start, true, 0f)
        for (index in 1..2) {
            val time = start + index * 100_000_000L
            result = classifier.update(left, center, right, time, time, true, 0f)
        }
        return result
    }

    @Test fun relativeDirectionsRequireObservedFartherDepthInTheChosenSector() {
        assertEquals(DepthObstacleClassifier.Direction.FORWARD, stable(unknown, far, unknown).direction)
        assertEquals(DepthObstacleClassifier.Direction.CHECK_LEFT, stable(far, near, near).direction)
        assertEquals(DepthObstacleClassifier.Direction.CHECK_RIGHT, stable(near, near, far).direction)
        assertEquals(DepthObstacleClassifier.Direction.STOP, stable(near, near, near).direction)
        assertEquals(DepthObstacleClassifier.Direction.SCAN, stable(unknown, near, unknown).direction)
        assertEquals(DepthObstacleClassifier.Direction.SCAN, stable(far, unknown, far).direction)
        assertEquals(DepthObstacleClassifier.Direction.SCAN, stable(far, IntArray(25) { if (it < 14) 3000 else 0 }, far).direction)
        assertEquals(DepthObstacleClassifier.Direction.SCAN, stable(far, IntArray(25) { if (it == 0) 700 else 3000 }, far).direction)
        assertEquals(DepthObstacleClassifier.Direction.CHECK_RIGHT, stable(far, near, IntArray(25) { 5000 }).direction)
    }

    @Test fun cameraFallbackNeverUsesMissingOrMixedClosePointsAsFarther() {
        val empty=FloatArray(0)
        val farPoints=FloatArray(6) {3f}
        val nearPoints=FloatArray(6) {0.8f}
        fun camera(left:FloatArray,center:FloatArray,right:FloatArray,planes:FloatArray=FloatArray(3) {Float.NaN}):DepthObstacleClassifier.Observation {
            val classifier=DepthObstacleClassifier()
            var result=DepthObstacleClassifier.Observation(false,DepthObstacleClassifier.Direction.SCAN)
            for(index in 0..2) {
                val time=start+index*100_000_000L
                result=classifier.updateCamera(left,center,right,planes,time,time,true,0f)
            }
            return result
        }
        assertEquals(DepthObstacleClassifier.Direction.SCAN,camera(empty,empty,empty).direction)
        assertEquals(DepthObstacleClassifier.Direction.FORWARD,camera(empty,farPoints,empty).direction)
        assertEquals(DepthObstacleClassifier.Direction.STOP,camera(empty,farPoints,empty,floatArrayOf(0.8f,0.8f,0.8f)).direction)
        assertEquals(DepthObstacleClassifier.Direction.SCAN,camera(empty,farPoints,empty,floatArrayOf(Float.NaN,1.3f,Float.NaN)).direction)
        assertEquals(DepthObstacleClassifier.Direction.CHECK_LEFT,camera(farPoints,nearPoints,nearPoints).direction)
        assertEquals(DepthObstacleClassifier.Direction.SCAN,camera(empty,floatArrayOf(0.8f)+farPoints,empty,floatArrayOf(Float.NaN,3f,Float.NaN)).direction)
        assertEquals(DepthObstacleClassifier.Direction.STOP,camera(empty,empty,empty,floatArrayOf(0.8f,0.8f,0.8f)).direction)
        val classifier=DepthObstacleClassifier()
        repeat(5) {assertFalse(classifier.updateCamera(empty,nearPoints,empty,FloatArray(3) {Float.NaN},start,start,true,0f).possibleObstacle)}
        assertEquals(DepthObstacleClassifier.Direction.SCAN,classifier.updateCamera(empty,nearPoints,empty,FloatArray(3) {Float.NaN},start+500_000_000,start,true,0f).direction)
    }

    @Test fun exitBearingCanOrientInPlaceBeforeSideClearanceIsKnown() {
        data class Case(val left:IntArray,val right:IntArray,val relative:Float,val expected:DepthObstacleClassifier.Direction)
        for ((left, right, relative, expected) in listOf(
            Case(far, near, 1f, DepthObstacleClassifier.Direction.FACE_RIGHT),
            Case(unknown, unknown, 1f, DepthObstacleClassifier.Direction.FACE_RIGHT),
            Case(far, far, -1f, DepthObstacleClassifier.Direction.FACE_LEFT),
        )) {
            val classifier = DepthObstacleClassifier()
            var result = DepthObstacleClassifier.Observation(false, DepthObstacleClassifier.Direction.SCAN)
            for (index in 0..2) {
                val time = start + index*100_000_000L
                result = classifier.update(left, far, right, time,time,true,0f,relative)
            }
            assertEquals(expected,result.direction)
        }
    }

    @Test fun missingLocationDoesNotDisableLocalObstaclesOrAllowForwardWalking() {
        for ((center,goal,expected) in listOf(
            Triple(unknown,1f,DepthObstacleClassifier.Direction.FACE_RIGHT),
            Triple(unknown,3f,DepthObstacleClassifier.Direction.TURN_AROUND),
            Triple(far,Float.NaN,DepthObstacleClassifier.Direction.SCAN),
            Triple(near,Float.NaN,DepthObstacleClassifier.Direction.CHECK_LEFT),
        )) {
            val classifier=DepthObstacleClassifier()
            var result=DepthObstacleClassifier.Observation(false,DepthObstacleClassifier.Direction.SCAN)
            repeat(3) {
                val time=start+it*100_000_000L
                result=classifier.update(far,center,near,time,time,true,0f,goal)
            }
            assertEquals(expected,result.direction)
        }
    }

    @Test fun aNewObstacleImmediatelyRemovesTheForwardArrow() {
        val classifier = DepthObstacleClassifier()
        for (index in 0..2) {
            val time = start + index * 100_000_000L
            classifier.update(near, far, far, time, time, true, 0f)
        }
        val next = start + 300_000_000L
        val blocked = classifier.update(near, near, far, next, next, true, 0f)
        assertEquals(DepthObstacleClassifier.Direction.STOP, blocked.direction)
        assertFalse(blocked.possibleObstacle)
        val lost = classifier.update(near, near, far, next + 100_000_000L, next + 100_000_000L, false, 0f)
        assertEquals(DepthObstacleClassifier.Direction.SCAN, lost.direction)
    }

    @Test fun requiresSeveralDistinctFreshObservationsBeforeReportingNearSurface() {
        val classifier = DepthObstacleClassifier()
        assertFalse(classifier.center(near, start, start, true, 0f))
        repeat(5) { assertFalse(classifier.center(near, start + 50_000_000, start, true, 0f)) }
        assertFalse(classifier.center(near, start + 100_000_000, start + 100_000_000, true, 0f))
        assertTrue(classifier.center(near, start + 200_000_000, start + 200_000_000, true, 0f))
        assertFalse(classifier.center(near, start + 500_000_001, start + 200_000_000, true, 0f))
    }

    @Test fun trackingLossTiltAndDepthHolesNeverBecomeAPathClearResult() {
        for ((tracking, tilt) in listOf(false to 0f, true to 0.7f, true to Float.NaN)) {
            val classifier = DepthObstacleClassifier()
            repeat(5) { index ->
                val time = start + index * 100_000_000L
                assertFalse(classifier.center(near, time, time, tracking, tilt))
            }
        }
        for (samples in listOf(IntArray(25), IntArray(25) { 3000 }, IntArray(25) { if (it < 4) 500 else 0 })) {
            val classifier = DepthObstacleClassifier()
            repeat(5) { index ->
                val time = start + index * 100_000_000L
                assertFalse(classifier.center(samples, time, time, true, 0f))
            }
        }
    }

    @Test fun briefNoiseAndReversedTimestampsResetTheEvidenceWindow() {
        val classifier = DepthObstacleClassifier()
        assertFalse(classifier.center(near, start, start, true, 0f))
        assertFalse(classifier.center(IntArray(25) { 5000 }, start + 100_000_000, start + 100_000_000, true, 0f))
        assertFalse(classifier.center(near, start + 200_000_000, start + 200_000_000, true, 0f))
        assertFalse(classifier.center(near, start + 300_000_000, start + 300_000_000, true, 0f))
        assertFalse(classifier.center(near, start + 400_000_000, start + 250_000_000, true, 0f))
        assertFalse(classifier.center(near, start + 500_000_000, start + 500_000_000, true, 0f))
        assertFalse(classifier.center(near, start + 2_000_000_000, start + 2_000_000_000, true, 0f))
    }
}
