package com.contour.app.navigation

import kotlin.math.*

data class ExitCoordinate(val latitude: Double, val longitude: Double)
data class PlanOffset(val east: Double, val north: Double)

/** The pictured 2F Entrance Hall doors, not the Peer Support label above them. */
object LibraryExitGeometry {
    const val imageSha256 = "73427f34369579b61003899acf6f420e01456ab604b8709a1f67486d9e9ef0d4"
    const val defaultLatitude = 35.15507092207257
    const val defaultLongitude = 136.96375745011343
    const val defaultWidth = 72.81804487261522
    const val defaultAspect = 0.6935483870967742
    const val defaultAngle = 26.552532957975586

    fun entrance(latitude: Double, longitude: Double, width: Double, aspect: Double, angle: Double): ExitCoordinate {
        // shortcut: door centre digitized on this exact 1178x817 image; replace after an on-site survey.
        val point = planOffset(1034.0 / 1178.0,528.0 / 817.0,width,aspect,angle)
        return ExitCoordinate(latitude + point.north / 6378137 * 180 / PI,
            longitude + point.east / (6378137 * cos(latitude * PI / 180)) * 180 / PI)
    }

    fun planOffset(imageX: Double,imageY: Double,width: Double,aspect: Double,angle: Double): PlanOffset {
        val x = (imageX - 0.5) * width
        val y = (imageY - 0.5) * width * aspect
        val a = angle * PI / 180
        val east = x * cos(a) - y * sin(a)
        val north = -(x * sin(a) + y * cos(a))
        return PlanOffset(east,north)
    }

    fun distance(latitude: Double, longitude: Double, target: ExitCoordinate): Double {
        val north = (target.latitude - latitude) * PI / 180 * 6378137
        val east = (target.longitude - longitude) * PI / 180 * 6378137 * cos(latitude * PI / 180)
        return hypot(east, north)
    }

    /** Reject fixes whose uncertainty could reverse the initial direction. Not indoor localization. */
    fun bearing(latitude: Double, longitude: Double, accuracy: Double, target: ExitCoordinate): Double {
        if (!listOf(latitude,longitude,accuracy,target.latitude,target.longitude).all { it.isFinite() } ||
            abs(latitude) >= 85 || abs(longitude) > 180 || accuracy !in 0.0..25.0) return Double.NaN
        val distance = distance(latitude,longitude,target)
        if (distance < max(4.0,accuracy * 2) || distance > 150) return Double.NaN
        return atan2((target.longitude-longitude)*cos(latitude*PI/180),target.latitude-latitude)
    }
}
