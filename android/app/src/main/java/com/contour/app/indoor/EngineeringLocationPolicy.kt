package com.contour.app.indoor

import kotlin.math.asin
import kotlin.math.cos
import kotlin.math.sin
import kotlin.math.sqrt

/** Coarse surveyed-building gate, in addition to the authenticated IndoorAtlas venue ID. */
internal object EngineeringLocationPolicy {
    fun contains(latitude: Double, longitude: Double): Boolean {
        if (!latitude.isFinite() || !longitude.isFinite() || latitude !in -90.0..90.0 || longitude !in -180.0..180.0) return false
        val lat = Math.toRadians(latitude)
        val center = Math.toRadians(35.15561139)
        val deltaLat = lat - center
        val deltaLon = Math.toRadians(longitude - 136.96476536)
        val a = sin(deltaLat / 2) * sin(deltaLat / 2) + cos(lat) * cos(center) * sin(deltaLon / 2) * sin(deltaLon / 2)
        val distance = 6_371_000.0 * 2 * asin(sqrt(a.coerceIn(0.0, 1.0)))
        return distance <= 100.0
    }
}
