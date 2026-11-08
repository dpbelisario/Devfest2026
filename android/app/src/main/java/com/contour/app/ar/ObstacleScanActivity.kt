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
class ObstacleScanActivity : ComponentActivity(), GLSurfaceView.Renderer {
    companion object {
        const val EXTRA_STATUS = "obstacle_status"
        const val EXTRA_REASON = "obstacle_reason"
    }

    private lateinit var surface: GLSurfaceView
    private lateinit var message: TextView
    private lateinit var arrow: TextView
    private lateinit var chevrons: View
    private var goalYaw: Float? = null
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
                canvas.rotate(Math.toDegrees(arrowRadians.toDouble()).toFloat())
                for (index in 0..4) {
                    canvas.save()
                    val scale = width/450f * (1f-index*0.12f)
                    canvas.translate(0f,-index*height*0.055f)
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
        val instruction = TextView(this).apply {
            text = "3D AR · Library exit\nExit · 2F entrance · demo"
            setTextColor(Color.WHITE); textSize = 19f
            setPadding(24, 24, 24, 24); setBackgroundColor(0xCC000000.toInt())
        }
        root.addView(instruction, FrameLayout.LayoutParams(-1, -2, Gravity.TOP))
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
                if (!created.isDepthModeSupported(Config.DepthMode.AUTOMATIC)) {
                    created.close()
                    showUnavailable("Depth scanning is unavailable on this phone. Check the path yourself.", "depth-unsupported")
                    return
                }
                session = created
                created.configure(created.config.apply {
                    depthMode = Config.DepthMode.AUTOMATIC
                    planeFindingMode = Config.PlaneFindingMode.DISABLED
                    lightEstimationMode = Config.LightEstimationMode.DISABLED
                })
            }
            session?.resume()
            classifier.reset()
            goalYaw = null
            previewReady = false
            possibleObstacle = false
            lastFrameTimestamp = 0L
            arrow.text = "…"
            arrow.contentDescription = "Starting camera tracking"
            review.isEnabled = false
            message.text = "Starting direction assumed · checking nearby obstacles…"
            running = true
            surface.onResume()
        } catch (_: Exception) {
            showUnavailable("AR depth scanning could not start. Check camera access and AR service support.", "ar-unavailable")
        }
    }

    override fun onPause() {
        running = false
        previewReady = false
        goalYaw = null
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
            inspectDepth(frame)
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
            // shortcut: opening camera bearing is the demo exit direction, replace with registered library pose.
            if (goalYaw == null) goalYaw = heading
            relative = kotlin.math.atan2(kotlin.math.sin(goalYaw!!-heading),kotlin.math.cos(goalYaw!!-heading))
            try {
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
                        DepthObstacleClassifier.Direction.FORWARD -> "Exit · 2F entrance · assumed direction. Check the real path as you move."
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
        possibleObstacle = blocked
        val now = SystemClock.elapsedRealtime()
        if (blocked) lastPossibleAt = now
        if (now - lastUiAt >= 200 || direction != lastDirection) {
            lastUiAt = now
            lastDirection = direction
            runOnUiThread {
                if (!unavailable && !isFinishing) {
                    message.text = text
                    previewReady = poseReady
                    arrowSupported = direction != DepthObstacleClassifier.Direction.SCAN
                    arrowStopped = direction == DepthObstacleClassifier.Direction.STOP
                    arrowRadians = when (direction) {
                        DepthObstacleClassifier.Direction.CHECK_LEFT -> -Math.PI.toFloat()/3
                        DepthObstacleClassifier.Direction.CHECK_RIGHT -> Math.PI.toFloat()/3
                        else -> relative
                    }
                    chevrons.invalidate()
                    arrow.text = when (direction) {
                        DepthObstacleClassifier.Direction.FORWARD -> "Continue ahead"
                        DepthObstacleClassifier.Direction.CHECK_LEFT -> "Turn left"
                        DepthObstacleClassifier.Direction.CHECK_RIGHT -> "Turn right"
                        DepthObstacleClassifier.Direction.STOP -> "Stop"
                        DepthObstacleClassifier.Direction.SCAN -> "Scan slowly"
                    }
                    arrow.contentDescription = text
                    review.isEnabled = possibleObstacle
                }
            }
        }
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
