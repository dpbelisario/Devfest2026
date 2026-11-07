package com.contour.app.indoor

/** A point in the original IndoorAtlas floor image, not screen coordinates. */
data class IndoorPosition(val x: Float, val y: Float, val accuracyPixels: Float)

/** Reject unusable fixes rather than pinning an outdoor/other-floor position to a map edge. */
fun usableIndoorFix(
    latitude: Double,
    longitude: Double,
    accuracy: Float,
    fixFloor: Int?,
    mapFloor: Int,
    x: Float,
    y: Float,
    width: Int,
    height: Int,
): Boolean = latitude.isFinite() && latitude in -90.0..90.0 &&
    longitude.isFinite() && longitude in -180.0..180.0 &&
    accuracy.isFinite() && accuracy > 0f && fixFloor == mapFloor &&
    width > 0 && height > 0 && x.isFinite() && y.isFinite() &&
    x in 0f..width.toFloat() && y in 0f..height.toFloat()

/** Convert a geographic heading into a heading relative to the image's top edge. */
fun floorHeading(heading: Double, mapBearing: Float): Float? =
    if (heading.isFinite() && mapBearing.isFinite())
        (((heading - mapBearing) % 360 + 360) % 360).toFloat()
    else null
