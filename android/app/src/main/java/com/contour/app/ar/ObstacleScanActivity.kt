package com.contour.app.ar

import android.Manifest
import android.content.Intent
import android.content.pm.PackageManager
import android.graphics.Canvas
import android.graphics.Color
import android.graphics.Paint
import android.graphics.Path
import android.opengl.GLES11Ext
import android.opengl.GLES20
import android.opengl.GLSurfaceView
import android.os.Bundle
import android.os.SystemClock
import android.location.Location
import android.location.LocationManager
import android.location.LocationListener
import android.hardware.Sensor
import android.hardware.SensorEvent
import android.hardware.SensorEventListener
import android.hardware.SensorManager
import android.hardware.GeomagneticField
import com.contour.app.navigation.LibraryExitGeometry
import android.view.Gravity
import android.view.View
import android.view.WindowManager
import android.widget.Button
import android.widget.FrameLayout
import android.widget.LinearLayout
import android.widget.TextView
import androidx.activity.ComponentActivity
import androidx.activity.OnBackPressedCallback
import androidx.activity.result.contract.ActivityResultContracts
import androidx.core.view.ViewCompat
import androidx.core.view.WindowCompat
import androidx.core.view.WindowInsetsCompat
import com.google.ar.core.ArCoreApk
import com.google.ar.core.Config
import com.google.ar.core.Coordinates2d
import com.google.ar.core.Plane
import com.google.ar.core.Frame
import com.google.ar.core.Session
import com.google.ar.core.TrackingState
import com.google.ar.core.exceptions.NotYetAvailableException
import java.nio.ByteBuffer
import java.nio.ByteOrder
import java.nio.FloatBuffer
import javax.microedition.khronos.egl.EGLConfig
import javax.microedition.khronos.opengles.GL10

/** Native, on-device depth observation. It never labels an unobserved path as clear. */
class ObstacleScanActivity : ComponentActivity(), GLSurfaceView.Renderer, SensorEventListener, LocationListener {
    companion object {
        const val EXTRA_STATUS = "obstacle_status"
        const val EXTRA_REASON = "obstacle_reason"
    }

    private lateinit var surface: GLSurfaceView
    private lateinit var message: TextView
    private lateinit var arrow: TextView
    private lateinit var chevrons: View
    private var usesDepth = false
    private lateinit var headingLabel: TextView
    private var targetX: Float? = null
    private var targetZ: Float? = null
    @Volatile private var locationFix: Location? = null
    @Volatile private var compassHeading = Double.NaN
    @Volatile private var compassAt = 0L
    private val sensors by lazy { getSystemService(SENSOR_SERVICE) as SensorManager }
    private val locations by lazy { getSystemService(LOCATION_SERVICE) as LocationManager }
    private val entrance = LibraryExitGeometry.entrance(LibraryExitGeometry.defaultLatitude,LibraryExitGeometry.defaultLongitude,
        LibraryExitGeometry.defaultWidth,LibraryExitGeometry.defaultAspect,LibraryExitGeometry.defaultAngle)
    private var arrowRadians = 0f
    private var arrowSupported = false
    private var arrowStopped = false
    private var previewReady = false
    private lateinit var review: Button
    @Volatile private var session: Session? = null
    @Volatile private var running = false
    @Volatile private var unavailable = false
    @Volatile private var possibleObstacle = false
    @Volatile private var lastPossibleAt = 0L
    private var installRequested = false
    private var permissionRequested = false
    private var locationPermissionRequested = false
    private var lastUiAt = 0L
    private var lastDirection = DepthObstacleClassifier.Direction.SCAN
    private var lastFrameTimestamp = 0L
    private var lastFrameAt = 0L
    private var reason = "cancelled"
    private val classifier = DepthObstacleClassifier()
    private var texture = 0
    private var program = 0
    private var positionAttribute = 0
    private var textureAttribute = 0
    private var width = 1
    private var height = 1
    private val vertices = floatBuffer(floatArrayOf(-1f, -1f, 1f, -1f, -1f, 1f, 1f, 1f))
    private val textureCoordinates = floatBuffer(FloatArray(8))
    private val sampleCoordinates = floatBuffer(FloatArray(150).also { values ->
        for (sector in 0..2) for (y in 0..4) for (x in 0..4) {
            val index = 2 * (sector * 25 + y * 5 + x)
            values[index] = (sector - 1) * 0.6f - 0.2f + x * 0.1f
            values[index + 1] = -0.2f + y * 0.1f
        }
    })
    private val sampleTextureCoordinates = floatBuffer(FloatArray(150))
    private val depths = Array(3) { IntArray(25) }

    private val askCamera = registerForActivityResult(ActivityResultContracts.RequestPermission()) { granted ->
        if (granted) startSession() else showUnavailable("Camera permission is required for this scan.", "camera-permission")
    }
    private val askLocation = registerForActivityResult(ActivityResultContracts.RequestMultiplePermissions()) { startPositioning() }

    @Suppress("MissingPermission")
    private fun startPositioning() {
        if (!intent.getBooleanExtra("exitDemo",false)) return
        sensors.getDefaultSensor(Sensor.TYPE_ROTATION_VECTOR)?.let { sensors.registerListener(this,it,SensorManager.SENSOR_DELAY_UI) }
        if (checkSelfPermission(Manifest.permission.ACCESS_COARSE_LOCATION) != PackageManager.PERMISSION_GRANTED) return
        for (provider in listOf(LocationManager.GPS_PROVIDER,LocationManager.NETWORK_PROVIDER)) {
            if (provider == LocationManager.GPS_PROVIDER && checkSelfPermission(Manifest.permission.ACCESS_FINE_LOCATION) != PackageManager.PERMISSION_GRANTED) continue
            try {
                if (locations.isProviderEnabled(provider)) {
                    locations.getLastKnownLocation(provider)?.let { onLocationChanged(it) }
                    locations.requestLocationUpdates(provider,1000L,0f,this)
                }
            } catch (_: SecurityException) { locationFix=null }
        }
    }
    override fun onLocationChanged(location:Location) { locationFix=location }
    override fun onProviderEnabled(provider:String) { }
    override fun onProviderDisabled(provider:String) { locationFix=null }
    override fun onSensorChanged(event:SensorEvent) {
        if (event.sensor.type != Sensor.TYPE_ROTATION_VECTOR) return
        if (event.accuracy < SensorManager.SENSOR_STATUS_ACCURACY_MEDIUM ||
            (event.values.size >= 5 && (event.values[4] < 0 || event.values[4] > 0.44f))) { compassHeading=Double.NaN;return }
        val rotation=FloatArray(9)
        SensorManager.getRotationMatrixFromVector(rotation,event.values)
        // Back camera looks along negative device Z; device-top azimuth is wrong when held upright.
        if (kotlin.math.hypot(rotation[2],rotation[5]) < 0.5f) { compassHeading=Double.NaN;return }
        val fix=locationFix ?: return
        val declination=GeomagneticField(fix.latitude.toFloat(),fix.longitude.toFloat(),fix.altitude.toFloat(),System.currentTimeMillis()).declination
        compassHeading=kotlin.math.atan2(-rotation[2].toDouble(),-rotation[5].toDouble())+Math.toRadians(declination.toDouble())
        compassAt=SystemClock.elapsedRealtime()
    }
    override fun onAccuracyChanged(sensor:Sensor?,accuracy:Int) {
        if (accuracy < SensorManager.SENSOR_STATUS_ACCURACY_MEDIUM) compassHeading=Double.NaN
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        WindowCompat.setDecorFitsSystemWindows(window, false)
        window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
        setResult(RESULT_CANCELED)
        val root = FrameLayout(this).apply { setBackgroundColor(Color.BLACK) }
        surface = GLSurfaceView(this).apply {
            setEGLContextClientVersion(2)
            preserveEGLContextOnPause = true
            setRenderer(this@ObstacleScanActivity)
        }
        root.addView(surface, FrameLayout.LayoutParams(-1, -1))
        chevrons = object : View(this) {
            private val paint = Paint(Paint.ANTI_ALIAS_FLAG)
            private val path = Path()
            override fun onDraw(canvas: Canvas) {
                if (!previewReady || arrowStopped) return
                canvas.save()
                canvas.translate(width*0.5f,height*0.65f)
                for (index in 0..4) {
                    canvas.save()
                    val scale = width/450f * (1f-index*0.12f)
                    canvas.translate(0f,-index*height*0.055f)
                    canvas.rotate(Math.toDegrees(arrowRadians.toDouble()).toFloat())
                    canvas.scale(scale,scale*0.5f)
                    path.reset()
                    path.moveTo(0f,-50f); path.lineTo(34f,-16f); path.lineTo(22f,-4f)
                    path.lineTo(0f,-26f); path.lineTo(-22f,-4f); path.lineTo(-34f,-16f); path.close()
                    paint.style=Paint.Style.FILL
                    paint.color=if (arrowSupported) Color.WHITE else 0xFFFFA726.toInt()
                    paint.alpha=(120+100*(0.5+0.5*kotlin.math.sin(SystemClock.uptimeMillis()/270.0-index*0.6))).toInt()
                    canvas.drawPath(path,paint)
                    paint.style=Paint.Style.STROKE;paint.color=Color.BLACK;paint.strokeWidth=2f
                    canvas.drawPath(path,paint)
                    canvas.restore()
                }
                canvas.restore()
                postInvalidateOnAnimation()
            }
        }
        root.addView(chevrons,FrameLayout.LayoutParams(-1,-1))
        headingLabel = TextView(this).apply {
            text = "3D AR · Library exit\nExit · 2F entrance · demo"
            setTextColor(Color.WHITE); textSize = 19f
            setPadding(24, 24, 24, 24); setBackgroundColor(0xCC000000.toInt())
        }
        root.addView(headingLabel, FrameLayout.LayoutParams(-1, -2, Gravity.TOP))
        arrow = TextView(this).apply {
            text = "Scan slowly"; textSize = 22f; gravity = Gravity.CENTER
            setTextColor(Color.WHITE); setShadowLayer(5f, 0f, 2f, Color.BLACK)
            contentDescription = "Scanning for depth"
        }
        val panel = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(24, 16, 24, 24); setBackgroundColor(0xDD000000.toInt())
        }
        message = TextView(this).apply {
            text = "Starting camera…"; setTextColor(Color.WHITE); textSize = 17f
            setPadding(0, 0, 0, 12)
        }
        review = Button(this).apply {
            text = "Review possible obstacle"; isEnabled = false
            setOnClickListener {
                if (possibleObstacle && SystemClock.elapsedRealtime() - lastPossibleAt <= 500)
                    finishObservation("blocked", "near-surface")
                else {
                    isEnabled = false
                    message.text = "Observation expired. Scan the path again."
                }
            }
        }
        panel.addView(arrow)
        panel.addView(message)
        review.visibility = if (intent.getBooleanExtra("exitDemo",false)) View.GONE else View.VISIBLE
        panel.addView(review,LinearLayout.LayoutParams(-1,-2))
        panel.addView(Button(this).apply {
            text = "Close"
            setOnClickListener { finishObservation("unknown", reason) }
        }, LinearLayout.LayoutParams(-1, -2))
        root.addView(panel, FrameLayout.LayoutParams(-1, -2, Gravity.BOTTOM))
        ViewCompat.setOnApplyWindowInsetsListener(root) { view, insets ->
            val bars = insets.getInsets(WindowInsetsCompat.Type.systemBars() or WindowInsetsCompat.Type.displayCutout())
            view.setPadding(bars.left, bars.top, bars.right, bars.bottom)
            insets
        }
        setContentView(root)
        onBackPressedDispatcher.addCallback(this, object : OnBackPressedCallback(true) {
            override fun handleOnBackPressed() = finishObservation("unknown", reason)
        })
    }

    override fun onResume() {
        super.onResume()
        if (intent.getBooleanExtra("exitDemo",false)) {
            if (checkSelfPermission(Manifest.permission.ACCESS_COARSE_LOCATION) == PackageManager.PERMISSION_GRANTED) startPositioning()
            else if (!locationPermissionRequested) {
                locationPermissionRequested=true
                askLocation.launch(arrayOf(Manifest.permission.ACCESS_FINE_LOCATION,Manifest.permission.ACCESS_COARSE_LOCATION))
            }
        }
        if (checkSelfPermission(Manifest.permission.CAMERA) == PackageManager.PERMISSION_GRANTED) startSession()
        else if (!permissionRequested) {
            permissionRequested = true
            askCamera.launch(Manifest.permission.CAMERA)
        }
    }

    private fun startSession() {
        if (running || unavailable || isFinishing) return
        try {
            if (session == null) {
                if (ArCoreApk.getInstance().requestInstall(this, !installRequested) == ArCoreApk.InstallStatus.INSTALL_REQUESTED) {
                    installRequested = true
                    message.text = "Finish installing Google Play Services for AR, then return here."
                    return
                }
                val created = Session(this)
                usesDepth = created.isDepthModeSupported(Config.DepthMode.AUTOMATIC)
                session = created
                created.configure(created.config.apply {
                    depthMode = if(usesDepth) Config.DepthMode.AUTOMATIC else Config.DepthMode.DISABLED
                    planeFindingMode = if(usesDepth) Config.PlaneFindingMode.DISABLED else Config.PlaneFindingMode.HORIZONTAL_AND_VERTICAL
                    lightEstimationMode = Config.LightEstimationMode.DISABLED
                })
                headingLabel.text = "3D AR · Library exit\n" + if(usesDepth) "ARCore Depth · Exit on 2F" else "Camera estimate · Exit on 2F"
            }
            session?.resume()
            classifier.reset()
            targetX=null;targetZ=null
            previewReady = false
            possibleObstacle = false
            lastFrameTimestamp = 0L
            arrow.text = "…"
            arrow.contentDescription = "Starting camera tracking"
            review.isEnabled = false
            message.text = "Finding Entrance Hall direction · obstacle scan active…"
            running = true
            surface.onResume()
        } catch (_: Exception) {
            showUnavailable("AR depth scanning could not start. Check camera access and AR service support.", "ar-unavailable")
        }
    }

    override fun onPause() {
        running = false
        previewReady = false
        targetX=null;targetZ=null
        sensors.unregisterListener(this);locations.removeUpdates(this);compassHeading=Double.NaN
        possibleObstacle = false
        surface.onPause()
        session?.pause()
        super.onPause()
    }

    override fun onDestroy() {
        session?.close()
        session = null
        super.onDestroy()
    }

    private fun finishObservation(status: String, resultReason: String) {
        setResult(RESULT_OK, Intent().putExtra(EXTRA_STATUS, status).putExtra(EXTRA_REASON, resultReason))
        finish()
    }

    private fun showUnavailable(text: String, resultReason: String) {
        unavailable = true
        running = false
        possibleObstacle = false
        runOnUiThread {
            previewReady = false
            chevrons.invalidate()
            reason = resultReason
            message.text = text
            arrow.text = "…"
            arrow.contentDescription = "Depth unavailable"
            review.isEnabled = false
        }
    }

    override fun onSurfaceCreated(gl: GL10?, config: EGLConfig?) {
        try {
            val textures = IntArray(1)
            GLES20.glGenTextures(1, textures, 0)
            texture = textures[0]
            GLES20.glBindTexture(GLES11Ext.GL_TEXTURE_EXTERNAL_OES, texture)
            GLES20.glTexParameteri(GLES11Ext.GL_TEXTURE_EXTERNAL_OES, GLES20.GL_TEXTURE_MIN_FILTER, GLES20.GL_LINEAR)
            GLES20.glTexParameteri(GLES11Ext.GL_TEXTURE_EXTERNAL_OES, GLES20.GL_TEXTURE_MAG_FILTER, GLES20.GL_LINEAR)
            GLES20.glTexParameteri(GLES11Ext.GL_TEXTURE_EXTERNAL_OES, GLES20.GL_TEXTURE_WRAP_S, GLES20.GL_CLAMP_TO_EDGE)
            GLES20.glTexParameteri(GLES11Ext.GL_TEXTURE_EXTERNAL_OES, GLES20.GL_TEXTURE_WRAP_T, GLES20.GL_CLAMP_TO_EDGE)
            val vertex = compileShader(GLES20.GL_VERTEX_SHADER,
                "attribute vec4 aPosition; attribute vec2 aTexCoord; varying vec2 vTexCoord; void main(){gl_Position=aPosition;vTexCoord=aTexCoord;}")
            val fragment = compileShader(GLES20.GL_FRAGMENT_SHADER,
                "#extension GL_OES_EGL_image_external : require\nprecision mediump float; uniform samplerExternalOES uTexture; varying vec2 vTexCoord; void main(){gl_FragColor=texture2D(uTexture,vTexCoord);}")
            program = GLES20.glCreateProgram()
            GLES20.glAttachShader(program, vertex); GLES20.glAttachShader(program, fragment)
            GLES20.glLinkProgram(program)
            GLES20.glDeleteShader(vertex); GLES20.glDeleteShader(fragment)
            val linked = IntArray(1)
            GLES20.glGetProgramiv(program, GLES20.GL_LINK_STATUS, linked, 0)
            check(linked[0] == GLES20.GL_TRUE)
            positionAttribute = GLES20.glGetAttribLocation(program, "aPosition")
            textureAttribute = GLES20.glGetAttribLocation(program, "aTexCoord")
        } catch (_: Exception) {
            showUnavailable("The camera preview could not start.", "preview-unavailable")
        }
    }

    override fun onSurfaceChanged(gl: GL10?, width: Int, height: Int) {
        this.width = width; this.height = height
        GLES20.glViewport(0, 0, width, height)
    }

    override fun onDrawFrame(gl: GL10?) {
        GLES20.glClear(GLES20.GL_COLOR_BUFFER_BIT)
        val active = session ?: return
        if (!running || program == 0) return
        try {
            @Suppress("DEPRECATION")
            val rotation = windowManager.defaultDisplay.rotation
            active.setDisplayGeometry(rotation, width, height)
            active.setCameraTextureName(texture)
            val frame = active.update()
            if (frame.timestamp == 0L) return
            drawCamera(frame)
            val now = SystemClock.elapsedRealtime()
            if (frame.timestamp != lastFrameTimestamp) {
                lastFrameTimestamp = frame.timestamp
                lastFrameAt = now
            } else if (now - lastFrameAt > 250) {
                classifier.reset()
                possibleObstacle = false
                if (now - lastUiAt >= 200) {
                    lastUiAt = now
                    runOnUiThread {
                        previewReady = false
                        chevrons.invalidate()
                        review.isEnabled = false
                        arrow.text = "…"
                        arrow.contentDescription = "Waiting for camera frame"
                        message.text = "Waiting for a new camera frame…"
                    }
                }
                return
            }
            if (usesDepth || now-lastUiAt >= 200) inspectDepth(frame)
        } catch (_: Exception) {
            showUnavailable("Camera tracking stopped. Return to the map and retry.", "tracking-unavailable")
        }
    }

    private fun drawCamera(frame: Frame) {
        vertices.rewind(); textureCoordinates.rewind()
        frame.transformCoordinates2d(Coordinates2d.OPENGL_NORMALIZED_DEVICE_COORDINATES, vertices,
            Coordinates2d.TEXTURE_NORMALIZED, textureCoordinates)
        vertices.rewind(); textureCoordinates.rewind()
        GLES20.glDisable(GLES20.GL_DEPTH_TEST)
        GLES20.glUseProgram(program)
        GLES20.glActiveTexture(GLES20.GL_TEXTURE0)
        GLES20.glBindTexture(GLES11Ext.GL_TEXTURE_EXTERNAL_OES, texture)
        GLES20.glUniform1i(GLES20.glGetUniformLocation(program, "uTexture"), 0)
        GLES20.glVertexAttribPointer(positionAttribute, 2, GLES20.GL_FLOAT, false, 0, vertices)
        GLES20.glVertexAttribPointer(textureAttribute, 2, GLES20.GL_FLOAT, false, 0, textureCoordinates)
        GLES20.glEnableVertexAttribArray(positionAttribute); GLES20.glEnableVertexAttribArray(textureAttribute)
        GLES20.glDrawArrays(GLES20.GL_TRIANGLE_STRIP, 0, 4)
        GLES20.glDisableVertexAttribArray(positionAttribute); GLES20.glDisableVertexAttribArray(textureAttribute)
    }

    private fun inspectDepth(frame: Frame) {
        val camera = frame.camera
        var relative = 0f
        var poseReady = false
        var blocked = false
        var direction = DepthObstacleClassifier.Direction.SCAN
        var text = "No reliable obstruction result. This does not mean the path is clear."
        if (camera.trackingState != TrackingState.TRACKING) {
            classifier.reset()
            text = "Tracking the scene… Move the phone slowly."
        } else if (kotlin.math.abs(camera.pose.zAxis[1]) > 0.34f) {
            classifier.reset()
            text = "Hold the camera level, facing the path ahead."
        } else {
            poseReady = true
            val heading = kotlin.math.atan2(-camera.pose.zAxis[0],camera.pose.zAxis[2])
            val compassReady=compassHeading.isFinite() && SystemClock.elapsedRealtime()-compassAt < 3000
            val fix=locationFix
            if (targetX == null && compassReady && fix != null && SystemClock.elapsedRealtimeNanos()-fix.elapsedRealtimeNanos in 0L..10_000_000_000L) {
                val bearing=LibraryExitGeometry.bearing(fix.latitude,fix.longitude,fix.accuracy.toDouble(),entrance)
                if (bearing.isFinite()) {
                    val distance=LibraryExitGeometry.distance(fix.latitude,fix.longitude,entrance).toFloat()
                    val offset=(bearing-compassHeading).toFloat()
                    val goal=heading+kotlin.math.atan2(kotlin.math.sin(offset),kotlin.math.cos(offset))
                    targetX=camera.pose.tx()+distance*kotlin.math.sin(goal)
                    targetZ=camera.pose.tz()-distance*kotlin.math.cos(goal)
                }
            }
            relative=if (!intent.getBooleanExtra("exitDemo",false)) 0f else if (targetX != null && compassReady) {
                val goal=kotlin.math.atan2(targetX!!-camera.pose.tx(),camera.pose.tz()-targetZ!!)
                kotlin.math.atan2(kotlin.math.sin(goal-heading),kotlin.math.cos(goal-heading))
            } else Float.NaN
            if (targetX != null && kotlin.math.hypot(targetX!!-camera.pose.tx(),targetZ!!-camera.pose.tz()) < 4f) relative=Float.NaN
            if (!usesDepth) {
                val observation=inspectCamera(frame,relative)
                blocked=observation.possibleObstacle
                direction=observation.direction
                text="Camera estimate; blank walls/glass may be missed. Check the real path."
            } else try {
                frame.acquireDepthImage16Bits().use { image ->
                    sampleCoordinates.rewind(); sampleTextureCoordinates.rewind()
                    frame.transformCoordinates2d(Coordinates2d.OPENGL_NORMALIZED_DEVICE_COORDINATES, sampleCoordinates,
                        Coordinates2d.TEXTURE_NORMALIZED, sampleTextureCoordinates)
                    val plane = image.planes[0]
                    val bytes = plane.buffer.duplicate().order(ByteOrder.nativeOrder())
                    for (i in 0 until 75) {
                        val u = sampleTextureCoordinates.get(i * 2)
                        val v = sampleTextureCoordinates.get(i * 2 + 1)
                        if (u !in 0f..1f || v !in 0f..1f) {
                            depths[i / 25][i % 25] = 0
                            continue
                        }
                        val x = (u * image.width).toInt().coerceAtMost(image.width - 1)
                        val y = (v * image.height).toInt().coerceAtMost(image.height - 1)
                        val offset = y * plane.rowStride + x * plane.pixelStride
                        depths[i / 25][i % 25] = if (offset + 1 < bytes.limit()) bytes.getShort(offset).toInt() and 0xffff else 0
                    }
                    val observation = classifier.update(depths[0], depths[1], depths[2], frame.timestamp, image.timestamp, true, -camera.pose.zAxis[1], relative)
                    blocked = observation.possibleObstacle
                    direction = observation.direction
                    text = when (direction) {
                        DepthObstacleClassifier.Direction.FORWARD -> "Entrance Hall exit · approximate map/GPS bearing. Check the real path."
                        DepthObstacleClassifier.Direction.FACE_LEFT, DepthObstacleClassifier.Direction.FACE_RIGHT, DepthObstacleClassifier.Direction.TURN_AROUND -> "Face the Entrance Hall exit in place. Walking clearance is not established."
                        DepthObstacleClassifier.Direction.CHECK_LEFT -> "Turn left · farther surfaces observed. Check the real path."
                        DepthObstacleClassifier.Direction.CHECK_RIGHT -> "Turn right · farther surfaces observed. Check the real path."
                        DepthObstacleClassifier.Direction.STOP -> "Stop and look around. No supported turn suggestion yet. The space behind you was not checked."
                        DepthObstacleClassifier.Direction.SCAN -> if (blocked) "Close surface ahead. Scan left and right; side clearance is unknown." else "Scan slowly. There is not enough depth evidence for a direction."
                    }
                }
            } catch (_: NotYetAvailableException) {
                classifier.reset()
                text = "Depth is not ready. Move the phone slowly and keep looking ahead."
            }
        }
        if (poseReady && direction == DepthObstacleClassifier.Direction.SCAN && !blocked && relative.isFinite()) {
            direction=when {
                kotlin.math.abs(relative) > Math.PI.toFloat()*0.8f -> DepthObstacleClassifier.Direction.TURN_AROUND
                relative > Math.PI.toFloat()/6 -> DepthObstacleClassifier.Direction.FACE_RIGHT
                relative < -Math.PI.toFloat()/6 -> DepthObstacleClassifier.Direction.FACE_LEFT
                else -> direction
            }
        }
        possibleObstacle = blocked
        val now = SystemClock.elapsedRealtime()
        if (blocked) lastPossibleAt = now
        if (now - lastUiAt >= 200 || direction != lastDirection) {
            lastUiAt = now
            lastDirection = direction
            runOnUiThread {
                if (!unavailable && !isFinishing) {
                    message.text = if (intent.getBooleanExtra("exitDemo",false) && !relative.isFinite()) "Finding location/compass · obstacle scan active. Exit direction unavailable." else text
                    previewReady = poseReady && (relative.isFinite() || direction in listOf(DepthObstacleClassifier.Direction.CHECK_LEFT,DepthObstacleClassifier.Direction.CHECK_RIGHT))
                    arrowSupported = direction in listOf(DepthObstacleClassifier.Direction.FORWARD,DepthObstacleClassifier.Direction.CHECK_LEFT,DepthObstacleClassifier.Direction.CHECK_RIGHT)
                    arrowStopped = direction == DepthObstacleClassifier.Direction.STOP
                    arrowRadians = when (direction) {
                        DepthObstacleClassifier.Direction.CHECK_LEFT -> -Math.PI.toFloat()/3
                        DepthObstacleClassifier.Direction.CHECK_RIGHT -> Math.PI.toFloat()/3
                        else -> if(relative.isFinite()) relative else 0f
                    }
                    chevrons.invalidate()
                    arrow.text = when (direction) {
                        DepthObstacleClassifier.Direction.FORWARD -> "Continue ahead"
                        DepthObstacleClassifier.Direction.CHECK_LEFT -> "Turn left"
                        DepthObstacleClassifier.Direction.CHECK_RIGHT -> "Turn right"
                        DepthObstacleClassifier.Direction.FACE_LEFT -> "Turn left in place"
                        DepthObstacleClassifier.Direction.FACE_RIGHT -> "Turn right in place"
                        DepthObstacleClassifier.Direction.TURN_AROUND -> "Turn around in place"
                        DepthObstacleClassifier.Direction.STOP -> "Stop"
                        DepthObstacleClassifier.Direction.SCAN -> "Scan slowly"
                    }
                    arrow.contentDescription = text
                    review.isEnabled = possibleObstacle
                }
            }
        }
    }

    private fun inspectCamera(frame:Frame,relative:Float):DepthObstacleClassifier.Observation {
        val samples=Array(3) {mutableListOf<Float>()}
        val planes=FloatArray(3) {Float.NaN}
        var observedAt=frame.timestamp
        val cloud=frame.acquirePointCloud()
        try {
            if(frame.timestamp-cloud.timestamp in 0L..200_000_000L) {
                observedAt=cloud.timestamp
                val points=cloud.points
                val cameraFromWorld=frame.camera.displayOrientedPose.inverse()
                while(points.remaining() >= 4) {
                    val x=points.get();val y=points.get();val z=points.get();val confidence=points.get()
                    if(!confidence.isFinite() || confidence < 0.5f) continue
                    val p=cameraFromWorld.transformPoint(floatArrayOf(x,y,z))
                    val depth=-p[2]
                    if(depth !in 0.25f..5f || kotlin.math.abs(p[1]) > 0.4f) continue
                    val ratio=p[0]/depth
                    val sector=when {ratio in -0.6f..-0.15f -> 0;ratio in 0.15f..0.6f -> 2;kotlin.math.abs(ratio) < 0.15f -> 1;else -> continue}
                    samples[sector].add(depth)
                }
            }
        } finally {cloud.release()}
        for(sector in 0..2) {
            val distance=frame.hitTest(width*(0.25f+sector*0.25f),height*0.5f).filter {hit ->
                val plane=hit.trackable as? Plane
                plane != null && plane.trackingState == TrackingState.TRACKING && plane.type == Plane.Type.VERTICAL && plane.isPoseInPolygon(hit.hitPose)
            }.map {it.distance}.filter {it > 0.25f && it < 5f}.minOrNull()
            if(distance != null) {planes[sector]=distance;observedAt=frame.timestamp}
        }
        // Sparse camera geometry is only observed surface evidence, never proof of clearance.
        return classifier.updateCamera(samples[0].toFloatArray(),samples[1].toFloatArray(),samples[2].toFloatArray(),planes,
            frame.timestamp,observedAt,true,-frame.camera.pose.zAxis[1],relative)
    }

    private fun compileShader(type: Int, source: String): Int {
        val shader = GLES20.glCreateShader(type)
        GLES20.glShaderSource(shader, source); GLES20.glCompileShader(shader)
        val compiled = IntArray(1)
        GLES20.glGetShaderiv(shader, GLES20.GL_COMPILE_STATUS, compiled, 0)
        check(compiled[0] == GLES20.GL_TRUE)
        return shader
    }

    private fun floatBuffer(values: FloatArray): FloatBuffer = ByteBuffer.allocateDirect(values.size * 4)
        .order(ByteOrder.nativeOrder()).asFloatBuffer().apply { put(values); rewind() }
}
