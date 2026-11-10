package com.contour.app.indoor

import kotlin.math.abs
import kotlin.math.asin
import kotlin.math.atan2
import kotlin.math.cos
import kotlin.math.sin
import kotlin.math.sqrt

/** What an IndoorAtlas navigation session heads to. Chosen by the page's bridge command. */
enum class IndoorTarget {
    /** The room 221 POI (`start221`). */
    ROOM_221,
    /** The nearest exit of the detected venue (`startNearestExit`). */
    NEAREST_EXIT;

    companion object {
        /** Bridge command → target, or null for other commands. */
        fun fromCommand(type: String): IndoorTarget? = when (type) {
            "start221" -> ROOM_221
            "startNearestExit" -> NEAREST_EXIT
            else -> null
        }
    }
}

/**
 * A resolved exit destination. [mode] ROUTE asks the IndoorAtlas SDK for a wayfinding route to
 * ([latitude], [longitude], [floor]); DIRECT shows only a straight bearing ("direct direction, not a
 * route") because the venue has no wayfinding graph or the SDK found no route.
 */
data class ExitDestination(
    val exit: IndoorVenueExit,
    val latitude: Double,
    val longitude: Double,
    val floor: Int,
    val mode: Mode,
) {
    enum class Mode { ROUTE, DIRECT }
}

/** Pure target selection and geometry, unit-tested without the SDK. */
object IndoorTargets {
    private const val EARTH_RADIUS_M = 6_371_000.0

    /** Great-circle (haversine) distance in metres; NaN for invalid input. */
    fun distanceMeters(lat1: Double, lng1: Double, lat2: Double, lng2: Double): Double {
        if (!validPoint(lat1, lng1) || !validPoint(lat2, lng2)) return Double.NaN
        val a1 = Math.toRadians(lat1)
        val a2 = Math.toRadians(lat2)
        val dLat = a2 - a1
        val dLng = Math.toRadians(lng2 - lng1)
        val h = sin(dLat / 2) * sin(dLat / 2) + cos(a1) * cos(a2) * sin(dLng / 2) * sin(dLng / 2)
        return EARTH_RADIUS_M * 2 * asin(sqrt(h.coerceIn(0.0, 1.0)))
    }

    /** Initial bearing in degrees clockwise from true north (0..360); NaN for invalid input. */
    fun bearingDegrees(lat1: Double, lng1: Double, lat2: Double, lng2: Double): Double {
        if (!validPoint(lat1, lng1) || !validPoint(lat2, lng2)) return Double.NaN
        val a1 = Math.toRadians(lat1)
        val a2 = Math.toRadians(lat2)
        val dLng = Math.toRadians(lng2 - lng1)
        val y = sin(dLng) * cos(a2)
        val x = cos(a1) * sin(a2) - sin(a1) * cos(a2) * cos(dLng)
        return (Math.toDegrees(atan2(y, x)) + 360) % 360
    }

    /**
     * The exit to head for from ([latitude], [longitude]) on [floor]: the closest exit on the current
     * floor; when none is on this floor, the exit on the nearest other floor (fewest floors away, then
     * closest). With an unknown floor, simply the closest. Null when the venue lists no usable exits or
     * the position is invalid.
     */
    fun nearestExit(exits: List<IndoorVenueExit>, latitude: Double, longitude: Double, floor: Int?): IndoorVenueExit? {
        if (!validPoint(latitude, longitude)) return null
        val candidates = exits.mapNotNull { exit ->
            distanceMeters(latitude, longitude, exit.latitude, exit.longitude).takeIf { it.isFinite() }?.let { exit to it }
        }
        if (candidates.isEmpty()) return null
        if (floor == null) return candidates.minByOrNull { it.second }?.first
        return candidates.minWithOrNull(compareBy({ abs(it.first.floorLevel - floor) }, { it.second }))?.first
    }

    /**
     * Wayfinding destination for [exit] in [venue]: ROUTE unless the server says the venue has no
     * wayfinding graph (`hasWayfinding == false`), then DIRECT. Unknown (null) tries the SDK route first.
     */
    fun destination(venue: IndoorVenueConfig, exit: IndoorVenueExit): ExitDestination =
        ExitDestination(exit, exit.latitude, exit.longitude, exit.floorLevel,
            if (venue.hasWayfinding == false) ExitDestination.Mode.DIRECT else ExitDestination.Mode.ROUTE)

    private fun validPoint(lat: Double, lng: Double) =
        lat.isFinite() && lng.isFinite() && lat in -90.0..90.0 && lng in -180.0..180.0
}
