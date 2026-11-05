package com.contour.app.ar

import com.contour.app.data.model.Waypoint
import com.contour.app.guidance.GeoMath
import com.contour.app.guidance.GeospatialRouteProgress
import org.junit.Assert.*
import org.junit.Test

class GeospatialRouteProgressTest {
    private val points = listOf(
        Waypoint(35.68, 139.767, "Start"),
        Waypoint(35.6803, 139.767, "Turn east"),
        Waypoint(35.6803, 139.7676, "End"),
    )

    @Test fun advancesSequentiallyAndOnlyCompletesAtTheFinalPoint() {
        val progress = GeospatialRouteProgress(points)
        progress.update(points[2].latitude, points[2].longitude)
        assertEquals(0, progress.index)
        assertFalse(progress.complete)
        points.forEachIndexed { index, point ->
            progress.update(point.latitude, point.longitude)
            assertEquals(minOf(index + 1, 2), progress.index)
            assertEquals(index == 2, progress.complete)
        }
    }

    @Test fun corridorIncludesSegmentsButExcludesDistantPositions() {
        val progress = GeospatialRouteProgress(points)
        assertTrue(progress.isNearRoute(35.68015, 139.767))
        assertTrue(progress.isNearRoute(35.6803, 139.7673))
        assertFalse(progress.isNearRoute(35.682, 139.77))
        assertFalse(progress.isNearRoute(35.679, 139.767))
    }

    @Test fun bearingsMatchTheEastUpSouthRendererConvention() {
        val origin = Waypoint(0.0, 0.0, "")
        assertEquals(0f, GeoMath.bearing(origin, Waypoint(0.001, 0.0, "")), 0.01f)
        assertEquals(90f, GeoMath.bearing(origin, Waypoint(0.0, 0.001, "")), 0.01f)
        assertEquals(180f, GeoMath.bearing(origin, Waypoint(-0.001, 0.0, "")), 0.01f)
        assertEquals(270f, GeoMath.bearing(origin, Waypoint(0.0, -0.001, "")), 0.01f)
        assertEquals(111.2, GeoMath.distance(0.0, 0.0, Waypoint(0.001, 0.0, "")), 0.1)
    }
}
