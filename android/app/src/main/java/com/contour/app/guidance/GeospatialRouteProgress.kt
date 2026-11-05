package com.contour.app.guidance

import com.contour.app.data.model.Waypoint
import kotlin.math.*

object GeoMath {
    fun distance(latitude: Double, longitude: Double, point: Waypoint): Double {
        val lat1 = Math.toRadians(latitude)
        val lat2 = Math.toRadians(point.latitude)
        val dLat = lat2 - lat1
        val dLon = Math.toRadians(point.longitude - longitude)
        val a = sin(dLat / 2).pow(2) + cos(lat1) * cos(lat2) * sin(dLon / 2).pow(2)
        return 6_371_000 * 2 * asin(sqrt(a.coerceIn(0.0, 1.0)))
    }

    /** Clockwise bearing from north. Renderer uses the east-up-south anchor frame. */
    fun bearing(from: Waypoint, to: Waypoint): Float {
        val lat1 = Math.toRadians(from.latitude)
        val lat2 = Math.toRadians(to.latitude)
        val delta = Math.toRadians(to.longitude - from.longitude)
        return ((Math.toDegrees(atan2(sin(delta) * cos(lat2),
            cos(lat1) * sin(lat2) - sin(lat1) * cos(lat2) * cos(delta))) + 360) % 360).toFloat()
    }

    /** Local tangent-plane distance to a short pedestrian segment, including its endpoints. */
    fun segmentDistance(latitude: Double, longitude: Double, start: Waypoint, end: Waypoint): Double {
        val scale = cos(Math.toRadians(latitude))
        fun x(p: Waypoint) = Math.toRadians((p.longitude - longitude + 540) % 360 - 180) * scale * 6_371_000
        fun y(p: Waypoint) = Math.toRadians(p.latitude - latitude) * 6_371_000
        val ax = x(start); val ay = y(start)
        val dx = x(end) - ax; val dy = y(end) - ay
        val length = dx * dx + dy * dy
        val t = if (length == 0.0) 0.0 else (-(ax * dx + ay * dy) / length).coerceIn(0.0, 1.0)
        return hypot(ax + t * dx, ay + t * dy)
    }
}

/** Sequential demo progress. Call only with a confident pose; proximity is not proof of safe arrival. */
class GeospatialRouteProgress(private val points: List<Waypoint>) {
    init { require(points.size >= 2) }
    var index = 0
        private set
    var complete = false
        private set

    fun update(latitude: Double, longitude: Double) {
        if (complete || GeoMath.distance(latitude, longitude, points[index]) > 5) return
        if (index == points.lastIndex) complete = true else index++
    }

    fun isNearRoute(latitude: Double, longitude: Double): Boolean =
        points.zipWithNext().any { (a, b) -> GeoMath.segmentDistance(latitude, longitude, a, b) <= 20 }
}
