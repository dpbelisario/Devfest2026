package com.contour.app.indoor

import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class EngineeringLocationPolicyTest {
    @Test fun permitsBuildingCenterAndRejectsDistantSdkPositions() {
        assertTrue(EngineeringLocationPolicy.contains(35.15561139, 136.96476536))
        assertTrue(EngineeringLocationPolicy.contains(35.15583615, 136.9646781))
        assertFalse(EngineeringLocationPolicy.contains(35.16061139, 136.96476536))
        assertFalse(EngineeringLocationPolicy.contains(35.0, 139.0))
    }

    @Test fun rejectsInvalidAndNonFiniteCoordinates() {
        assertFalse(EngineeringLocationPolicy.contains(Double.NaN, 136.96476536))
        assertFalse(EngineeringLocationPolicy.contains(35.15561139, Double.POSITIVE_INFINITY))
        assertFalse(EngineeringLocationPolicy.contains(95.0, 136.96476536))
    }
}
