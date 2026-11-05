package com.contour.app.ar.rendering

import android.opengl.GLES20
import android.opengl.GLSurfaceView
import android.os.SystemClock
import com.contour.app.ar.*
import com.contour.app.data.model.NavigationRoute
import com.contour.app.guidance.GeoMath
import com.contour.app.guidance.GeospatialRouteProgress
import com.google.ar.core.Earth
import com.google.ar.core.Session
import com.google.ar.core.TrackingState
import java.util.concurrent.atomic.AtomicReference
import javax.microedition.khronos.egl.EGLConfig
import javax.microedition.khronos.opengles.GL10

/** All frame updates, anchor operations, and drawing run on GLSurfaceView's GL thread. */
class GeospatialRenderer(
    private val rotation: () -> Int,
    private val onState: (Long, GeospatialState) -> Unit,
    private val onFailure: (Long) -> Unit,
) : GLSurfaceView.Renderer {
    @Volatile var session: Session? = null
    @Volatile var generation = 0L
    val requestedRoute = AtomicReference<NavigationRoute?>(null)
    private val camera = CameraRenderer()
    private val arrows = ArrowRenderer()
    private val anchors = AnchorManager()
    private val quality = TrackingQuality()
    private var route: NavigationRoute? = null
    private var progress: GeospatialRouteProgress? = null
    private var width = 1
    private var height = 1
    private var failed = false
    private var lastReport = 0L
    private var localizingSince = 0L
    private val view = FloatArray(16)
    private val projection = FloatArray(16)

    override fun onSurfaceCreated(gl: GL10?, config: EGLConfig?) {
        try { camera.create(); arrows.create() } catch (_: RuntimeException) { fail() }
    }

    override fun onSurfaceChanged(gl: GL10?, width: Int, height: Int) {
        this.width = width; this.height = height
        GLES20.glViewport(0, 0, width, height)
    }

    override fun onDrawFrame(gl: GL10?) {
        GLES20.glClearColor(0.08f, 0.09f, 0.08f, 1f)
        GLES20.glClear(GLES20.GL_COLOR_BUFFER_BIT or GLES20.GL_DEPTH_BUFFER_BIT)
        val current = session ?: return
        if (failed) return
        try {
            current.setDisplayGeometry(rotation(), width, height)
            current.setCameraTextureName(camera.textureId)
            val frame = current.update()
            camera.draw(frame)
            val desired = requestedRoute.get()
            if (route !== desired) {
                anchors.clear(); route = desired
                progress = desired?.let { GeospatialRouteProgress(it.waypoints) }
            }
            val now = SystemClock.elapsedRealtime()
            val earth = current.earth
            if (earth != null && earth.earthState != Earth.EarthState.ENABLED) {
                quality.reset()
                report(GeospatialState("Geospatial unavailable (${earth.earthState}). Check authorization, quota, and network, then retry AR."), now)
                return
            }
            if (earth == null || earth.trackingState != TrackingState.TRACKING || frame.camera.trackingState != TrackingState.TRACKING) {
                quality.reset()
                report(GeospatialState("Localizing. Move the camera slowly outdoors toward buildings; keep location enabled."), now)
                return
            }
            val pose = earth.cameraGeospatialPose
            val snapshot = DevicePose(pose.latitude, pose.longitude, pose.horizontalAccuracy,
                pose.verticalAccuracy, pose.orientationYawAccuracy)
            val ready = quality.update(true, snapshot.horizontalAccuracy, snapshot.verticalAccuracy, snapshot.yawAccuracy, now)
            if (!ready) {
                if (localizingSince == 0L) localizingSince = now
                val text = if (now - localizingSince > 60_000) "Accuracy is still too low. Try a clearer outdoor view or retry AR."
                    else "Localizing. Look around slowly; arrows stay hidden until accuracy is sufficient."
                report(GeospatialState(text, pose = snapshot), now)
                return
            }
            localizingSince = 0L
            val navigation = progress
            val active = route
            if (active == null || navigation == null) {
                report(GeospatialState("Localized. Choose a backend destination below.", true, snapshot), now)
                return
            }
            if (!navigation.isNearRoute(snapshot.latitude, snapshot.longitude)) {
                report(GeospatialState("Outside the saved route corridor. Arrows hidden; return to the route or choose another destination.", true, snapshot, navigation.index), now)
                return
            }
            navigation.update(snapshot.latitude, snapshot.longitude)
            if (navigation.complete) {
                anchors.clear()
                report(GeospatialState("Demo route complete. This does not confirm arrival at a safe evacuation site.", true, snapshot, navigation.index, true), now)
                return
            }
            val indices = (navigation.index..minOf(navigation.index + 2, active.waypoints.lastIndex))
                .filter { GeoMath.distance(snapshot.latitude, snapshot.longitude, active.waypoints[it]) <= 100 }
            anchors.update(earth, active.waypoints, indices, now)
            frame.camera.getViewMatrix(view, 0)
            frame.camera.getProjectionMatrix(projection, 0, 0.1f, 150f)
            var rendered = 0
            anchors.resolved().forEach { (index, anchor) ->
                if (anchor.trackingState == TrackingState.TRACKING) {
                    val from = active.waypoints[if (index == active.waypoints.lastIndex) index - 1 else index]
                    val to = active.waypoints[if (index == active.waypoints.lastIndex) index else index + 1]
                    arrows.draw(anchor.pose, GeoMath.bearing(from, to), view, projection)
                    rendered++
                }
            }
            val message = anchors.error ?: when {
                indices.isEmpty() -> "Next waypoint is over 100 m away. No nearby arrows to render."
                rendered == 0 -> "Resolving ground anchors… Internet access is required."
                else -> "Demo waypoint ${navigation.index + 1}/${active.waypoints.size}: ${active.waypoints[navigation.index].instruction}"
            }
            report(GeospatialState(message, true, snapshot, navigation.index), now)
        } catch (_: Exception) { fail() }
    }

    private fun report(state: GeospatialState, now: Long) {
        if (now - lastReport >= 250) { lastReport = now; onState(generation, state) }
    }

    private fun fail() { if (!failed) { failed = true; onFailure(generation) } }

    /** Call only after surface.onPause() has stopped frame updates. */
    fun releaseSession() {
        anchors.clear(); quality.reset(); session = null
        // Preserve route progress across camera pauses; anchors themselves belong to the session.
        failed = false; localizingSince = 0; lastReport = 0
    }
}
