package com.contour.app.ar

import com.contour.app.data.model.Waypoint
import com.google.ar.core.Anchor
import com.google.ar.core.Earth
import com.google.ar.core.FutureState
import com.google.ar.core.ResolveAnchorOnTerrainFuture

/** GL-thread-owned bounded set of terrain resolutions; cancel/detach before closing the session. */
class AnchorManager {
    private val pending = mutableMapOf<Int, ResolveAnchorOnTerrainFuture>()
    private val anchors = mutableMapOf<Int, Anchor>()
    private val failures = mutableSetOf<Int>()
    private var startedAt = 0L
    var error: String? = null
        private set

    fun update(earth: Earth, points: List<Waypoint>, indices: List<Int>, nowMillis: Long) {
        val desired = indices.toSet()
        pending.keys.filter { it !in desired }.forEach { releasePending(it) }
        anchors.keys.filter { it !in desired }.forEach { anchors.remove(it)?.detach() }
        pending.toMap().forEach { (index, future) ->
            if (future.state == FutureState.DONE) {
                pending.remove(index)
                if (future.resultTerrainAnchorState == Anchor.TerrainAnchorState.SUCCESS) {
                    future.resultAnchor?.let { anchors[index] = it }
                } else {
                    failures.add(index)
                    error = "Terrain anchor unavailable (${future.resultTerrainAnchorState}). Retry AR with a network connection and check ARCore authorization."
                }
            }
        }
        if (pending.isNotEmpty() && nowMillis - startedAt > 30_000) {
            pending.keys.toList().forEach { failures.add(it); releasePending(it) }
            error = "Terrain resolution timed out. Check network access and VPS coverage, then retry AR."
        }
        indices.take(3).forEach { index ->
            if (index !in pending && index !in anchors && index !in failures) {
                if (pending.isEmpty()) startedAt = nowMillis
                val p = points[index]
                pending[index] = earth.resolveAnchorOnTerrainAsync(p.latitude, p.longitude, 0.1,
                    0f, 0f, 0f, 1f, null)
            }
        }
    }

    fun resolved(): Map<Int, Anchor> = anchors.toMap()

    private fun releasePending(index: Int) {
        pending.remove(index)?.let { future ->
            // A completed operation may already own an anchor even before the next polling frame.
            if (!future.cancel() && future.state == FutureState.DONE) future.resultAnchor?.detach()
        }
    }

    fun clear() {
        pending.keys.toList().forEach { releasePending(it) }
        anchors.values.forEach { it.detach() }
        anchors.clear(); failures.clear(); error = null
    }
}
