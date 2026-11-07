package com.contour.app.indoor

import org.junit.Assert.*
import org.junit.Test

class IndoorPositionTest {
    private fun valid(floor: Int? = 2, x: Float = 20f, accuracy: Float = 3f) =
        usableIndoorFix(35.15, 136.96, accuracy, floor, 2, x, 30f, 100, 200)

    @Test fun acceptsOnlyFiniteOnFloorPositions() {
        assertTrue(valid())
        assertFalse(valid(floor = 1))
        assertFalse(valid(floor = null))
        assertFalse(valid(x = -1f))
        assertFalse(valid(x = 101f))
        assertFalse(valid(x = Float.NaN))
        assertFalse(valid(accuracy = 0f))
        assertFalse(valid(accuracy = Float.POSITIVE_INFINITY))
        assertFalse(usableIndoorFix(Double.NaN, 136.96, 3f, 2, 2, 20f, 30f, 100, 200))
    }

    @Test fun alignsGeographicHeadingWithRotatedFloorImage() {
        assertEquals(0f, floorHeading(90.0, 90f)!!, .001f)
        assertEquals(270f, floorHeading(0.0, 90f)!!, .001f)
        assertEquals(10f, floorHeading(370.0, 0f)!!, .001f)
        assertNull(floorHeading(Double.NaN, 0f))
    }
}
