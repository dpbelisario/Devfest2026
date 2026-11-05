package com.contour.app.ar

/** Requires two seconds of accurate poses; drops precision immediately on tracking loss. */
class TrackingQuality {
    private var stableSince: Long? = null
    private var ready = false

    fun update(tracking: Boolean, horizontal: Double, vertical: Double, yaw: Double, nowMillis: Long): Boolean {
        val finite = listOf(horizontal, vertical, yaw).all { it.isFinite() && it >= 0 }
        val acceptable = tracking && finite && horizontal <= (if (ready) 5.0 else 3.0) &&
            vertical <= (if (ready) 8.0 else 5.0) && yaw <= (if (ready) 15.0 else 10.0)
        if (!acceptable) {
            reset()
            return false
        }
        val since = stableSince ?: nowMillis.also { stableSince = it }
        ready = ready || nowMillis - since >= 2_000
        return ready
    }

    fun reset() { stableSince = null; ready = false }
}
