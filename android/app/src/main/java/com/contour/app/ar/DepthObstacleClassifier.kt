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
        relativeGoal: Float = 0f,
    ): Observation {
        return observe(sector(left),sector(center),sector(right),frameTimestamp,depthTimestamp,tracking,forwardY,relativeGoal)
    }

    fun updateCamera(
        left:FloatArray,center:FloatArray,right:FloatArray,planes:FloatArray,
        frameTimestamp:Long,observationTimestamp:Long,tracking:Boolean,forwardY:Float,relativeGoal:Float = 0f,
    ):Observation {
        require(planes.size == 3)
        return observe(cameraSector(left,planes[0]),cameraSector(center,planes[1]),cameraSector(right,planes[2]),
            frameTimestamp,observationTimestamp,tracking,forwardY,relativeGoal)
    }

    private fun cameraSector(points:FloatArray,plane:Float):Sector {
        val valid=points.filter {it.isFinite() && it > 0.25f && it < 5f}.sorted()
        val close=valid.count {it < 1.2f}
        val planeValid=plane.isFinite() && plane > 0.25f && plane < 5f
        return Sector(
            near=close >= 6 || (planeValid && plane < 1.2f),
            farther=close == 0 && (!planeValid || plane > 1.5f) && (valid.count {it > 1.5f} >= 6 || (planeValid && plane > 1.5f)),
            lowerDepth=((valid.firstOrNull() ?: if(planeValid) plane else 0f)*1000).toInt(),
        )
    }

    private fun observe(leftView:Sector,ahead:Sector,rightView:Sector,frameTimestamp:Long,depthTimestamp:Long,
                        tracking:Boolean,forwardY:Float,relativeGoal:Float):Observation {
        if (!tracking || !relativeGoal.isFinite() || !forwardY.isFinite() || abs(forwardY) > 0.34f ||
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
        if (!ahead.near) {
            firstNearTimestamp = 0
            nearFrames = 0
        } else {
            if (nearFrames == 0) firstNearTimestamp = depthTimestamp
            nearFrames++
        }
        val next = when {
            ahead.farther && abs(relativeGoal) <= Math.PI.toFloat()/6 -> Direction.FORWARD
            ahead.farther -> {
                val desired = if (relativeGoal > 0) rightView else leftView
                val other = if (relativeGoal > 0) leftView else rightView
                when {
                    desired.farther -> if (relativeGoal > 0) Direction.CHECK_RIGHT else Direction.CHECK_LEFT
                    desired.near && other.farther -> if (relativeGoal > 0) Direction.CHECK_LEFT else Direction.CHECK_RIGHT
                    else -> Direction.SCAN
                }
            }
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
