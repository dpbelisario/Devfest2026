package com.contour.app.ar

import android.Manifest
import android.content.Intent
import android.content.pm.PackageManager
import android.graphics.Canvas
import android.graphics.Color
import android.graphics.Paint
import android.graphics.Path
import android.graphics.Typeface
import android.graphics.drawable.GradientDrawable
import android.content.res.ColorStateList
import android.widget.HorizontalScrollView
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
import com.contour.app.navigation.LibraryWaypointGuidance
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
        const val EXTRA_FLOOR = "floor"
    }

    private lateinit var surface: GLSurfaceView
    private lateinit var message: TextView
    private lateinit var arrow: TextView
    private lateinit var chevrons: View
    private var usesDepth = false
    private lateinit var headingLabel: TextView
    private lateinit var floorBubble: GuessChip
    private lateinit var headingBubble: GuessChip
    @Volatile private var manualGoalHeading = Float.NaN
    @Volatile private var currentHeading = Float.NaN
    @Volatile private var guessedFloor = "2F"
    private val waypointGuide = LibraryWaypointGuidance()
    private lateinit var startBubble: GuessChip
    @Volatile private var pendingStartId: String? = null
    @Volatile private var manualRouteHeading = false
    @Volatile private var locationFix: Location? = null
    @Volatile private var compassHeading = Double.NaN
    @Volatile private var compassAt = 0L
    private val sensors by lazy { getSystemService(SENSOR_SERVICE) as SensorManager }
    private val locations by lazy { getSystemService(LOCATION_SERVICE) as LocationManager }
    private var arrowRadians = 0f
    private var arrowSupported = false
    private var arrowStopped = false
    private var previewReady = true
    /** False while the library-exit start picker is open: no arrows until a start is chosen. */
    @Volatile private var startConfirmed = true
    private val askStartFirst = false
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
        // Floor the user chose in the web app (evacuation: "I'm inside a building"); defaults to 2F.
        intent.getStringExtra(EXTRA_FLOOR)?.takeIf { it in setOf("B1", "1F", "2F", "3F", "4F") }?.let { guessedFloor = it }
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
                if (!previewReady || arrowStopped || !startConfirmed) return
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
                    // Accent blue like the other 3D AR arrows; amber when the direction is unsupported.
                    paint.color=if (arrowSupported) 0xFF1F5FD1.toInt() else 0xFFFFA726.toInt()
                    paint.alpha=(120+100*(0.5+0.5*kotlin.math.sin(SystemClock.uptimeMillis()/270.0-index*0.6))).toInt()
                    canvas.drawPath(path,paint)
                    paint.style=Paint.Style.STROKE;paint.color=Color.WHITE;paint.strokeWidth=2f
                    canvas.drawPath(path,paint)
                    canvas.restore()
                }
                canvas.restore()
                postInvalidateOnAnimation()
            }
        }
        root.addView(chevrons,FrameLayout.LayoutParams(-1,-1))
        // Same design as the web app's 3D AR screen: dark header with a close button, a light row of
        // "guess" chips (small label over a bold value, pencil to edit), a white direction pill over the
        // camera and a white card at the bottom. Pickers use the app's option-list card, not a system dialog.
        val dp = resources.displayMetrics.density
        fun px(v: Float) = (v * dp).toInt()
        val ink = 0xFF141714.toInt(); val ink2 = 0xFF565A57.toInt(); val ink3 = 0xFF8A8E89.toInt()
        val wash = 0xFFF3F5F3.toInt(); val line = 0xFFDFE4E0.toInt()
        val display = Typeface.create("sans-serif-condensed", Typeface.BOLD)
        val medium = Typeface.create("sans-serif-medium", Typeface.NORMAL)
        val enabledStates = arrayOf(intArrayOf(-android.R.attr.state_enabled), intArrayOf())
        fun rounded(fill: ColorStateList, radius: Float, stroke: Int? = null, strokeDp: Float = 1f) = GradientDrawable().apply {
            setColor(fill); setCornerRadius(radius * dp)
            if (stroke != null) setStroke(px(strokeDp), stroke)
        }
        fun styleButton(button: Button, primary: Boolean) = button.apply {
            isAllCaps = false; stateListAnimator = null
            minHeight = 0; minimumHeight = 0; minWidth = 0; minimumWidth = 0
            textSize = 15f; typeface = medium
            setTextColor(ColorStateList(enabledStates, if (primary) intArrayOf(Color.WHITE, Color.WHITE) else intArrayOf(0x66141714, ink)))
            background = if (primary) rounded(ColorStateList(enabledStates, intArrayOf(0xFFC9CCC9.toInt(), ink)), 10f)
                else rounded(ColorStateList.valueOf(Color.WHITE), 10f, line)
            setPadding(px(14f), px(14f), px(14f), px(14f))
        }
        val topBar = LinearLayout(this).apply { orientation = LinearLayout.VERTICAL }
        val header = FrameLayout(this).apply { setBackgroundColor(ink) }
        header.addView(TextView(this).apply {
            text = "✕"; textSize = 17f; setTextColor(Color.WHITE); gravity = Gravity.CENTER
            contentDescription = "Close"
            setOnClickListener { finishObservation("unknown", reason) }
        }, FrameLayout.LayoutParams(px(48f), px(48f), Gravity.START or Gravity.CENTER_VERTICAL).apply { leftMargin = px(4f) })
        headingLabel = TextView(this).apply {
            text = "Library exit AR"; textSize = 16f; setTextColor(Color.WHITE); gravity = Gravity.CENTER
            typeface = medium
        }
        header.addView(headingLabel, FrameLayout.LayoutParams(-2, -2, Gravity.CENTER))
        topBar.addView(header, LinearLayout.LayoutParams(-1, px(56f)))
        val guesses = LinearLayout(this).apply {
            orientation = LinearLayout.HORIZONTAL
            setPadding(px(12f), px(8f), px(12f), px(10f))
        }
        val guessScroll = HorizontalScrollView(this).apply {
            isHorizontalScrollBarEnabled = false; setBackgroundColor(wash)
            addView(guesses)
        }
        topBar.addView(guessScroll, LinearLayout.LayoutParams(-1, -2))
        topBar.addView(View(this).apply { setBackgroundColor(line) }, LinearLayout.LayoutParams(-1, px(1f)))

        // Picker card over a dim layer: title, short note, option rows (selected = dark border + check), Cancel / confirm.
        fun showPicker(title: String, note: String, options: List<String>, selected: Int, confirm: String,
                       cancelable: Boolean = true, onPick: (Int) -> Unit) {
            var chosen = selected.coerceIn(0, options.lastIndex)
            val dim = FrameLayout(this).apply { setBackgroundColor(0x73141714); isClickable = true }
            val card = LinearLayout(this).apply {
                orientation = LinearLayout.VERTICAL
                background = rounded(ColorStateList.valueOf(Color.WHITE), 12f)
                setPadding(px(20f), px(18f), px(20f), px(16f)); elevation = 8f * dp; isClickable = true
            }
            card.addView(TextView(this).apply { text = title; textSize = 24f; setTextColor(ink); typeface = display })
            card.addView(TextView(this).apply {
                text = note; textSize = 14f; setTextColor(ink2); setPadding(0, px(4f), 0, px(12f))
            })
            val rows = options.map { label ->
                TextView(this).apply {
                    text = label; textSize = 15f; setTextColor(ink); gravity = Gravity.CENTER_VERTICAL
                    setPadding(px(14f), 0, px(14f), 0); minHeight = px(48f)
                }
            }
            fun refresh() = rows.forEachIndexed { index, row ->
                val on = index == chosen
                row.background = rounded(ColorStateList.valueOf(Color.WHITE), 10f, if (on) ink else line, if (on) 2f else 1f)
                row.typeface = if (on) Typeface.create("sans-serif-medium", Typeface.BOLD) else Typeface.DEFAULT
                row.text = if (on) "${options[index]}   ✓" else options[index]
            }
            rows.forEachIndexed { index, row ->
                row.setOnClickListener { chosen = index; refresh() }
                card.addView(row, LinearLayout.LayoutParams(-1, -2).apply { if (index > 0) topMargin = px(6f) })
            }
            refresh()
            val buttons = LinearLayout(this).apply { orientation = LinearLayout.HORIZONTAL }
            fun close() { root.removeView(dim) }
            if (cancelable) {
                buttons.addView(Button(this).apply {
                    text = "Cancel"; styleButton(this, primary = false); setOnClickListener { close() }
                }, LinearLayout.LayoutParams(0, -2, 1f).apply { rightMargin = px(10f) })
                dim.setOnClickListener { close() }
            }
            buttons.addView(Button(this).apply {
                text = confirm; styleButton(this, primary = true)
                setOnClickListener { close(); onPick(chosen) }
            }, LinearLayout.LayoutParams(0, -2, 1f))
            card.addView(buttons, LinearLayout.LayoutParams(-1, -2).apply { topMargin = px(14f) })
            dim.addView(card, FrameLayout.LayoutParams(-1, -2, Gravity.BOTTOM).apply {
                leftMargin = px(16f); rightMargin = px(16f); bottomMargin = px(24f)
            })
            root.addView(dim, FrameLayout.LayoutParams(-1, -1))
        }

        // Guess chip: small grey label over a bold value, pencil on the right. Same look as the web chips.
        fun chip(label: String, value: String, onEdit: () -> Unit): GuessChip {
            val box = LinearLayout(this).apply {
                orientation = LinearLayout.HORIZONTAL; gravity = Gravity.CENTER_VERTICAL
                background = rounded(ColorStateList.valueOf(Color.WHITE), 10f, line)
                setPadding(px(12f), px(7f), px(10f), px(7f)); isClickable = true; isFocusable = true
            }
            val texts = LinearLayout(this).apply { orientation = LinearLayout.VERTICAL }
            texts.addView(TextView(this).apply { text = label; textSize = 11.5f; setTextColor(ink3) })
            val valueView = TextView(this).apply {
                text = value; textSize = 16f; setTextColor(ink); typeface = display; setPadding(0, px(1f), 0, 0)
            }
            texts.addView(valueView)
            box.addView(texts)
            box.addView(TextView(this).apply { text = "✎"; textSize = 15f; setTextColor(ink3) },
                LinearLayout.LayoutParams(-2, -2).apply { leftMargin = px(10f) })
            box.setOnClickListener { onEdit() }
            return GuessChip(box, label, valueView)
        }
        val floors = listOf("B1", "1F", "2F", "3F", "4F")
        floorBubble = chip("Floor guess", guessedFloor) {
            showPicker("Which floor are you on?", "Only 2F has a mapped exit route. On other floors, take the stairs to 2F.",
                floors, floors.indexOf(guessedFloor), "Done") { index ->
                guessedFloor = floors[index]
                floorBubble.value = guessedFloor
                startBubble.enabled = guessedFloor == "2F"
                pendingStartId = waypointGuide.startId
            }
        }
        startBubble = chip("Start guess", waypointGuide.starts.firstOrNull { it.id == waypointGuide.startId }?.label ?: "North-east aisle") {
            val starts = waypointGuide.starts
            showPicker("Where are you now?", "Pick the spot on 2F closest to you.", starts.map { it.label },
                starts.indexOfFirst { it.label == startBubble.value }.coerceAtLeast(0), "Done") { index ->
                pendingStartId = starts[index].id
                startBubble.value = starts[index].label
            }
        }
        startBubble.enabled = guessedFloor == "2F"
        headingBubble = chip("Next direction", "Unknown") {
            val labels = listOf("Ahead", "Right", "Left", "Behind", "Reset route estimate")
            val offsets = floatArrayOf(0f, Math.PI.toFloat() / 2, -Math.PI.toFloat() / 2, Math.PI.toFloat())
            showPicker("Next waypoint", "Where is the next waypoint from where you face?", labels, 0, "Done") { index ->
                if (index == 4) { pendingStartId = waypointGuide.startId; manualRouteHeading = false }
                else { manualGoalHeading = offsets[index]; manualRouteHeading = true }
            }
        }
        headingBubble.enabled = false
        for ((index, item) in listOf(floorBubble, startBubble, headingBubble).withIndex()) {
            guesses.addView(item.view, LinearLayout.LayoutParams(-2, -2).apply { if (index > 0) leftMargin = px(8f) })
        }
        arrow = TextView(this).apply {
            text = "Hold"; textSize = 15f; gravity = Gravity.CENTER; setTextColor(ink)
            typeface = medium
            background = rounded(ColorStateList.valueOf(Color.WHITE), 8f)
            setPadding(px(16f), px(10f), px(16f), px(10f)); elevation = 6f * dp
            contentDescription = "Hold"
        }
        topBar.addView(arrow, LinearLayout.LayoutParams(-2, -2).apply { gravity = Gravity.CENTER_HORIZONTAL; topMargin = px(14f) })
        root.addView(topBar, FrameLayout.LayoutParams(-1, -2, Gravity.TOP))
        val panel = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            background = rounded(ColorStateList.valueOf(Color.WHITE), 12f)
            setPadding(px(20f), px(18f), px(20f), px(16f))
        }
        panel.addView(TextView(this).apply {
            text = "Central Library"; textSize = 25f; setTextColor(ink); typeface = display
        })
        panel.addView(TextView(this).apply {
            text = "Exit guess · 2F Entrance Hall (demo)"; textSize = 14f; setTextColor(ink2)
            setPadding(0, px(4f), 0, 0)
        })
        message = TextView(this).apply {
            text = "Starting camera…"; setTextColor(ink3); textSize = 12.5f
            setPadding(0, px(10f), 0, 0)
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
        message.visibility = View.GONE
        panel.addView(message)
        styleButton(review, primary = true)
        review.visibility = if (intent.getBooleanExtra("exitDemo",false)) View.GONE else View.VISIBLE
        panel.addView(review, LinearLayout.LayoutParams(-1, -2).apply { topMargin = px(12f) })
        root.addView(panel, FrameLayout.LayoutParams(-1, -2, Gravity.BOTTOM).apply {
            leftMargin = px(16f); rightMargin = px(16f); bottomMargin = px(24f)
        })
        // Optional: ask where the user is before showing arrows (off: the library exit opens straight into
        // arrows and the start chip allows a correction). The camera keeps running behind the card.
        if (askStartFirst && intent.getBooleanExtra("exitDemo", false)) {
            panel.visibility = View.GONE; arrow.visibility = View.GONE; startConfirmed = false
            val starts = waypointGuide.starts
            showPicker("Where are you now?", "Pick the spot on 2F closest to you. You can change it later.",
                starts.map { it.label }, starts.indexOfFirst { it.id == waypointGuide.startId }.coerceAtLeast(0),
                "Start", cancelable = false) { index ->
                pendingStartId = starts[index].id
                startBubble.value = starts[index].label
                panel.visibility = View.VISIBLE; arrow.visibility = View.VISIBLE; startConfirmed = true; chevrons.invalidate()
            }
        }
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
                headingLabel.text = "Library exit AR"
            }
            session?.resume()
            classifier.reset()
            waypointGuide.reset()
            manualGoalHeading=Float.NaN;manualRouteHeading=false;currentHeading=Float.NaN;headingBubble.enabled=false
            previewReady = true;arrowSupported = false;arrowStopped = false;arrowRadians = 0f
            possibleObstacle = false
            lastFrameTimestamp = 0L
            arrow.text = "Hold"
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
        waypointGuide.reset()
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
            message.visibility = View.VISIBLE
            message.text = text
            arrow.text = "Hold"
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
                        previewReady = true;arrowSupported = false;arrowRadians = 0f
                        chevrons.invalidate()
                        review.isEnabled = false
                        arrow.text = "Hold"
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
        var relative = Float.NaN
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
            currentHeading = heading
            pendingStartId?.let { id ->
                waypointGuide.selectStart(id)
                pendingStartId = null; manualGoalHeading = Float.NaN; manualRouteHeading = false
            }
            relative = if(!intent.getBooleanExtra("exitDemo",false)) 0f else if(guessedFloor == "2F") {
                waypointGuide.update(camera.pose.tx().toDouble(),camera.pose.tz().toDouble(),heading.toDouble(),
                    if(compassReady) heading-compassHeading else Double.NaN).toFloat()
            } else Float.NaN
            if(manualGoalHeading.isFinite() && guessedFloor == "2F") {
                waypointGuide.align(camera.pose.tx().toDouble(),camera.pose.tz().toDouble(),heading.toDouble(),manualGoalHeading.toDouble())
                manualGoalHeading = Float.NaN
                relative = waypointGuide.update(camera.pose.tx().toDouble(),camera.pose.tz().toDouble(),heading.toDouble()).toFloat()
            }
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
        possibleObstacle = blocked
        val now = SystemClock.elapsedRealtime()
        if (blocked) lastPossibleAt = now
        if (now - lastUiAt >= 200 || direction != lastDirection) {
            lastUiAt = now
            lastDirection = direction
            runOnUiThread {
                if (!unavailable && !isFinishing) {
                    message.text = if (intent.getBooleanExtra("exitDemo",false) && !relative.isFinite()) "Finding location/compass · obstacle scan active. Exit direction unavailable." else text
                    headingBubble.enabled = poseReady
                    val guessedDirection = if(!relative.isFinite()) "Unknown" else if(kotlin.math.abs(relative) < Math.PI/6) "Ahead" else "${Math.toDegrees(kotlin.math.abs(relative).toDouble()).toInt()}° ${if(relative > 0) "right" else "left"}"
                    headingBubble.value = if (manualRouteHeading && guessedDirection != "Unknown") "$guessedDirection (set)" else guessedDirection
                    previewReady = true
                    arrowSupported = direction in listOf(DepthObstacleClassifier.Direction.FORWARD,DepthObstacleClassifier.Direction.CHECK_LEFT,DepthObstacleClassifier.Direction.CHECK_RIGHT)
                    arrowStopped = direction == DepthObstacleClassifier.Direction.STOP || (blocked && direction == DepthObstacleClassifier.Direction.SCAN)
                    arrowRadians = when (direction) {
                        DepthObstacleClassifier.Direction.CHECK_LEFT -> -Math.PI.toFloat()/3
                        DepthObstacleClassifier.Direction.CHECK_RIGHT -> Math.PI.toFloat()/3
                        DepthObstacleClassifier.Direction.TURN_AROUND -> Math.PI.toFloat()
                        else -> 0f
                    }
                    chevrons.invalidate()
                    arrow.text = when (direction) {
                        DepthObstacleClassifier.Direction.FORWARD -> "Move straight"
                        DepthObstacleClassifier.Direction.CHECK_LEFT -> "Move left"
                        DepthObstacleClassifier.Direction.CHECK_RIGHT -> "Move right"
                        DepthObstacleClassifier.Direction.FACE_LEFT -> "Turn left"
                        DepthObstacleClassifier.Direction.FACE_RIGHT -> "Turn right"
                        DepthObstacleClassifier.Direction.TURN_AROUND -> "Turn around"
                        DepthObstacleClassifier.Direction.STOP -> "Stop"
                        DepthObstacleClassifier.Direction.SCAN -> "Hold"
                    }
                    if(intent.getBooleanExtra("exitDemo",false) && waypointGuide.complete) arrow.text = "Check exit doors"
                    else if(intent.getBooleanExtra("exitDemo",false) && guessedFloor != "2F") arrow.text = "Take the stairs to 2F"
                    arrow.contentDescription = arrow.text
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

/** A "guess" chip on the AR screen: grey label, bold value, tap to edit. Disabled chips are dimmed. */
private class GuessChip(val view: View, private val label: String, private val valueView: TextView) {
    init { view.contentDescription = "$label · ${valueView.text} · Edit" }
    var value: String
        get() = valueView.text.toString()
        set(v) { valueView.text = v; view.contentDescription = "$label · $v · Edit" }
    var enabled: Boolean
        get() = view.isEnabled
        set(v) { view.isEnabled = v; view.alpha = if (v) 1f else 0.45f }
}
