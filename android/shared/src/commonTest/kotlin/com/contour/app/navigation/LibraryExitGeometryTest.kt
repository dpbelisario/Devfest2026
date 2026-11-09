package com.contour.app.navigation

import kotlin.test.*
import kotlin.math.PI

class LibraryExitGeometryTest {
    @Test fun entranceIsSouthOfPeerSupportAndRotatesWithSavedImage() {
        val northUp = LibraryExitGeometry.entrance(35.0,137.0,100.0,0.7,0.0)
        assertTrue(northUp.longitude > 137.0)
        assertTrue(northUp.latitude < 35.0)
        val rotated = LibraryExitGeometry.entrance(35.0,137.0,100.0,0.7,90.0)
        assertTrue(rotated.longitude < 137.0)
        assertTrue(rotated.latitude < 35.0)
    }
    @Test fun northAndEastBearingsAndUncertainFixes() {
        assertEquals(0.0,LibraryExitGeometry.bearing(35.0,137.0,3.0,ExitCoordinate(35.0005,137.0)),1e-6)
        assertEquals(PI/2,LibraryExitGeometry.bearing(35.0,137.0,3.0,ExitCoordinate(35.0,137.0005)),1e-6)
        assertTrue(LibraryExitGeometry.bearing(35.0,137.0,30.0,ExitCoordinate(35.0005,137.0)).isNaN())
        assertTrue(LibraryExitGeometry.bearing(35.0,137.0,20.0,ExitCoordinate(35.0001,137.0)).isNaN())
        assertTrue(LibraryExitGeometry.bearing(Double.NaN,137.0,2.0,ExitCoordinate(35.0,137.0)).isNaN())
    }
}
