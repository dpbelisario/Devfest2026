package com.contour.app.indoor.camera

import android.opengl.GLES20
import android.opengl.GLSurfaceView
import android.os.SystemClock
import androidx.activity.ComponentActivity
import com.google.ar.core.ArCoreApk
import com.google.ar.core.Config
import com.google.ar.core.Session
import com.google.ar.core.TrackingState
import javax.microedition.khronos.egl.EGLConfig
import javax.microedition.khronos.opengles.GL10

/** ARCore camera texture behind the existing transparent HTML AR overlay. No second UI or GPS world anchors. */
class NativeIndoorCamera(
    private val activity: ComponentActivity,
    private val onPose: (Boolean, FloatArray, FloatArray) -> Unit,
    private val onState: (String) -> Unit,
) {
    @Volatile private var session: Session? = null
    @Volatile private var generation = 0
    private var width = 1
    private var height = 1
    private val camera = CameraRenderer()
    @Volatile private var running = false
    private var lastPose = 0L
    private var reportedReady = false
    private var installRequested = false

    enum class StartResult { STARTED, INSTALLING, FALLBACK }

    val surface: GLSurfaceView = GLSurfaceView(activity).apply {
        setEGLContextClientVersion(2)
        preserveEGLContextOnPause = true
        setRenderer(object : GLSurfaceView.Renderer {
            override fun onSurfaceCreated(gl: GL10?, config: EGLConfig?) {
                try { camera.create() } catch (_: Exception) { fail() }
            }
            override fun onSurfaceChanged(gl: GL10?, w: Int, h: Int) { this@NativeIndoorCamera.width = w; this@NativeIndoorCamera.height = h; GLES20.glViewport(0, 0, w, h) }
            override fun onDrawFrame(gl: GL10?) {
                GLES20.glClear(GLES20.GL_COLOR_BUFFER_BIT or GLES20.GL_DEPTH_BUFFER_BIT)
                if (!running || camera.textureId == 0) return
                val current = session ?: return
                val epoch = generation
                try {
                    current.setDisplayGeometry(this@NativeIndoorCamera.surface.display?.rotation ?: 0, this@NativeIndoorCamera.width, this@NativeIndoorCamera.height)
                    current.setCameraTextureName(camera.textureId)
                    val frame = current.update()
                    camera.draw(frame)
                    val now = SystemClock.elapsedRealtime()
                    if (now - lastPose < 100) return
                    lastPose = now
                    val tracked = frame.camera.trackingState == TrackingState.TRACKING
                    val pose = FloatArray(16)
                    val displayPose = FloatArray(16)
                    frame.camera.pose.toMatrix(pose, 0)
                    frame.camera.displayOrientedPose.toMatrix(displayPose, 0)
                    val hasCameraFrame = frame.timestamp != 0L
                    activity.runOnUiThread {
                        if (!running || epoch != generation) return@runOnUiThread
                        if (!reportedReady && hasCameraFrame) { reportedReady = true; onState("ready") }
                        onPose(tracked, pose, displayPose)
                    }
                } catch (_: Exception) { fail() }
            }
        })
        onPause()
    }

    /** Main thread only. Installation keeps the request pending until the host resumes. */
    fun start(): StartResult {
        check(android.os.Looper.myLooper() == android.os.Looper.getMainLooper())
        if (running) return StartResult.STARTED
        try {
            val availability = ArCoreApk.getInstance().checkAvailability(activity)
            if (availability.isUnsupported) return StartResult.FALLBACK
            if (ArCoreApk.getInstance().requestInstall(activity, !installRequested) == ArCoreApk.InstallStatus.INSTALL_REQUESTED) {
                installRequested = true
                return StartResult.INSTALLING
            }
            // Keep the session reachable before configure/resume so every failure closes the camera.
            val current = Session(activity)
            session = current
            current.configure(Config(current).apply {
                focusMode = Config.FocusMode.AUTO
                planeFindingMode = Config.PlaneFindingMode.DISABLED
                // Relative visual-inertial motion needs no Geospatial API key or IndoorAtlas AR entitlement.
                geospatialMode = Config.GeospatialMode.DISABLED
            })
            current.resume()
            generation++
            lastPose = 0L
            running = true
            reportedReady = false
            surface.onResume()
            return StartResult.STARTED
        } catch (_: Exception) {
            stop()
            return StartResult.FALLBACK
        }
    }

    private fun fail() {
        val epoch = generation
        activity.runOnUiThread {
            if (running && epoch == generation) { stop(); onState("fallback") }
        }
    }

    fun stop() {
        running = false
        generation++
        surface.onPause() // wait for GL session.update() before releasing the camera
        val closing = session
        session = null
        try { closing?.pause() } catch (_: Exception) { }
        try { closing?.close() } catch (_: Exception) { }
        onPose(false, FloatArray(16), FloatArray(16))
    }
}
