package com.contour.app.ar

import kotlin.math.abs

/** Camera-relative observations only; no result certifies a walkable route. */
class DepthObstacleClassifier {
    enum class Direction { SCAN, FORWARD, CHECK_LEFT, CHECK_RIGHT, STOP }
    data class Observation(val possibleObstacle: Boolean, val direction: Direction)
    private data class Sector(val near: Boolean, val farther: Boolean, val lowerDepth: Int)
    private var lastDepthTimestamp = 0L
    private var firstNearTimestamp = 0L
    private var nearFrames = 0
    private var candidate = Direction.SCAN
    private var firstDirectionTimestamp = 0L
    private var directionFrames = 0
    private var lastObservation = Observation(false, Direction.SCAN)

    fun update(
        left: IntArray,
        center: IntArray,
        right: IntArray,
        frameTimestamp: Long,
        depthTimestamp: Long,
        tracking: Boolean,
        forwardY: Float,
    ): Observation {
        if (!tracking || !forwardY.isFinite() || abs(forwardY) > 0.34f ||
            depthTimestamp <= 0 || frameTimestamp - depthTimestamp !in 0L..200_000_000L ||
            depthTimestamp < lastDepthTimestamp) {
            reset()
            return lastObservation
        }
        if (depthTimestamp == lastDepthTimestamp) return lastObservation
        if (depthTimestamp - lastDepthTimestamp > 300_000_000L) {
            firstNearTimestamp = 0
            nearFrames = 0
            directionFrames = 0
        }
        lastDepthTimestamp = depthTimestamp
        val ahead = sector(center)
        val leftView = sector(left)
        val rightView = sector(right)
        if (!ahead.near) {
            firstNearTimestamp = 0
            nearFrames = 0
        } else {
            if (nearFrames == 0) firstNearTimestamp = depthTimestamp
            nearFrames++
        }
        val next = when {
            ahead.farther -> Direction.FORWARD
            !ahead.near -> Direction.SCAN
            leftView.farther && rightView.farther ->
                if (leftView.lowerDepth >= rightView.lowerDepth) Direction.CHECK_LEFT else Direction.CHECK_RIGHT
            leftView.farther -> Direction.CHECK_LEFT
            rightView.farther -> Direction.CHECK_RIGHT
            leftView.near && rightView.near -> Direction.STOP
            else -> Direction.SCAN
        }
        if (next != candidate || directionFrames == 0) {
            candidate = next
            firstDirectionTimestamp = depthTimestamp
            directionFrames = 0
        }
        directionFrames++
        val stable = directionFrames >= 3 && depthTimestamp - firstDirectionTimestamp >= 200_000_000L
        // A new close surface removes a previous forward arrow immediately.
        val direction = if (stable) next else if (ahead.near) Direction.STOP else Direction.SCAN
        lastObservation = Observation(
            nearFrames >= 3 && depthTimestamp - firstNearTimestamp >= 200_000_000L,
            direction,
        )
        return lastObservation
    }

    private fun sector(depths: IntArray): Sector {
        val valid = depths.filter { it > 0 }.sorted()
        val near = valid.count { it <= 1200 }
        val farther = valid.count { it >= 1600 }
        return Sector(
            near = valid.size >= 12 && near >= maxOf(4, (valid.size + 3) / 4),
            farther = valid.size >= 18 && near == 0 && farther * 5 >= valid.size * 4,
            lowerDepth = valid.getOrNull(valid.size / 5) ?: 0,
        )
    }

    fun reset() {
        lastDepthTimestamp = 0
        firstNearTimestamp = 0
        nearFrames = 0
        candidate = Direction.SCAN
        firstDirectionTimestamp = 0
        directionFrames = 0
        lastObservation = Observation(false, Direction.SCAN)
    }
}
