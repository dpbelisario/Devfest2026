package com.contour.app

import android.Manifest
import android.annotation.SuppressLint
import android.content.ActivityNotFoundException
import android.content.Intent
import android.content.pm.ApplicationInfo
import android.content.pm.PackageManager
import android.graphics.Color
import android.net.Uri
import android.os.Bundle
import android.webkit.GeolocationPermissions
import android.webkit.PermissionRequest
import android.webkit.WebChromeClient
import android.webkit.WebResourceError
import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
import android.webkit.WebView
import android.webkit.WebViewClient
import android.widget.FrameLayout
import androidx.activity.ComponentActivity
import androidx.activity.OnBackPressedCallback
import androidx.activity.result.contract.ActivityResultContracts
import androidx.core.graphics.Insets
import androidx.core.view.ViewCompat
import androidx.core.view.WindowCompat
import androidx.core.view.WindowInsetsCompat
import androidx.webkit.WebViewAssetLoader
import androidx.webkit.WebViewCompat
import androidx.webkit.WebViewFeature
import androidx.lifecycle.lifecycleScope
import kotlinx.coroutines.launch

/**
 * Shows the Contour UI full screen.
 *
 * Online: loads the hosted page (BuildConfig.UI_URL, served by the backend at /app/), so UI
 * changes reach phones on the next launch without reinstalling the APK.
 * Offline or if the host fails: falls back to the copy of contour.html bundled in assets, served
 * from a https origin by WebViewAssetLoader. Both are secure contexts, which the camera (3D AR)
 * and the compass need.
 */
class WebUiActivity : ComponentActivity() {

    lateinit var web: WebView
    /** Supported IndoorAtlas venues, refreshed from the backend on resume (docs/indoor-venues.md). */
    private val indoorVenues by lazy { com.contour.app.indoor.IndoorVenueRepository(this) }
    private var venuesRefreshedAt = Long.MIN_VALUE
    private var venuesRefresh: kotlinx.coroutines.Job? = null
    private val indoor by lazy {
        com.contour.app.indoor.IndoorNavigationController(this, { indoorVenues.current }) { data ->
            web.evaluateJavascript("window.dispatchEvent(new CustomEvent('contour-indoor',{detail:$data}))", null)
        }
    }
    private data class PageRequest(val id: String, val generation: Long)
    private var pageGeneration = 0L
    private var indoorRequest: PageRequest? = null
    /** Destination of the current IndoorAtlas session: room 221 or the detected venue's nearest exit. */
    private var indoorTarget = com.contour.app.indoor.IndoorTarget.ROOM_221
    private var pendingIndoorPermission: PageRequest? = null
    private val askIndoorPermissions = registerForActivityResult(ActivityResultContracts.RequestMultiplePermissions()) {
        val request = pendingIndoorPermission
        pendingIndoorPermission = null
        if (request == null || request != indoorRequest || request.generation != pageGeneration) return@registerForActivityResult
        // Restart permission-dependent collection, preserving this navigation's measured/corrected floor.
        // Denied location still permits pressure and relative camera estimates.
        if (lifecycle.currentState.isAtLeast(androidx.lifecycle.Lifecycle.State.RESUMED)) {
            indoor.pause()
            indoor.start(request.id, indoorTarget)
        }
        nativeCameraRequest?.let { continueNativeCamera(it) }
    }

    private fun startIndoor(id: String, target: com.contour.app.indoor.IndoorTarget) {
        val request = PageRequest(id, pageGeneration)
        indoorRequest = request
        indoorTarget = target
        val permissions = mutableListOf(Manifest.permission.ACCESS_COARSE_LOCATION, Manifest.permission.ACCESS_FINE_LOCATION)
        if (android.os.Build.VERSION.SDK_INT >= 29) permissions += Manifest.permission.ACTIVITY_RECOGNITION
        if (BuildConfig.INDOORATLAS_CONFIGURED && android.os.Build.VERSION.SDK_INT >= 31) permissions += Manifest.permission.BLUETOOTH_SCAN
        if (BuildConfig.INDOORATLAS_CONFIGURED && android.os.Build.VERSION.SDK_INT >= 33) permissions += Manifest.permission.NEARBY_WIFI_DEVICES
        val missing = permissions.filter { checkSelfPermission(it) != PackageManager.PERMISSION_GRANTED }
        indoor.start(id, target) // Publish unknown floor immediately; permissions never seed a fictional start.
        if (missing.isNotEmpty() && pendingIndoorPermission == null) {
            pendingIndoorPermission = request
            askIndoorPermissions.launch(permissions.toTypedArray())
        }
    }

    private var nativeCameraRequest: PageRequest? = null
    private var pendingNativePermission: PageRequest? = null
    private var arNotice: android.app.AlertDialog? = null
    private lateinit var nativeCamera: com.contour.app.indoor.camera.NativeIndoorCamera
    private val askNativeCamera = registerForActivityResult(ActivityResultContracts.RequestPermission()) { granted ->
        val request = pendingNativePermission
        pendingNativePermission = null
        if (request == null || request != nativeCameraRequest || request.generation != pageGeneration) return@registerForActivityResult
        if (granted) continueNativeCamera(request) else nativeCameraFallback(request)
    }

    private fun startNativeCamera(id: String) {
        if (nativeCameraRequest?.id == id) { nativeCameraRequest?.let { continueNativeCamera(it) }; return }
        stopNativeCamera()
        pendingCamera?.deny()
        pendingCamera = null
        val request = PageRequest(id, pageGeneration)
        nativeCameraRequest = request
        val prefs = getSharedPreferences("contour", MODE_PRIVATE)
        if (prefs.getBoolean("indoorArPrivacyAccepted", false)) { continueNativeCamera(request); return }
        arNotice = android.app.AlertDialog.Builder(this)
            .setTitle("Camera motion for indoor floors")
            .setMessage("This application runs on Google Play Services for AR (ARCore), which is provided by Google LLC and governed by the Google Privacy Policy. Google processes camera and sensor data for AR. Relative motion is an experimental floor estimate.\n\nGoogle Privacy Policy: https://policies.google.com/privacy")
            .setPositiveButton("Use AR camera") { _, _ ->
                arNotice = null
                if (nativeCameraRequest != request || request.generation != pageGeneration) return@setPositiveButton
                prefs.edit().putBoolean("indoorArPrivacyAccepted", true).apply()
                continueNativeCamera(request)
            }
            .setNegativeButton("Use regular camera") { _, _ -> arNotice = null; nativeCameraFallback(request) }
            .setOnCancelListener { arNotice = null; nativeCameraFallback(request) }
            .show()
        arNotice?.findViewById<android.widget.TextView>(android.R.id.message)?.let {
            android.text.util.Linkify.addLinks(it, android.text.util.Linkify.WEB_URLS)
            it.movementMethod = android.text.method.LinkMovementMethod.getInstance()
        }
    }

    private fun continueNativeCamera(request: PageRequest) {
        if (nativeCameraRequest != request || request.generation != pageGeneration ||
            !lifecycle.currentState.isAtLeast(androidx.lifecycle.Lifecycle.State.RESUMED) || arNotice != null) return
        if (pendingIndoorPermission != null) return
        if (checkSelfPermission(Manifest.permission.CAMERA) != PackageManager.PERMISSION_GRANTED) {
            if (pendingNativePermission == null) {
                pendingNativePermission = request
                askNativeCamera.launch(Manifest.permission.CAMERA)
            }
            return
        }
        when (nativeCamera.start()) {
            com.contour.app.indoor.camera.NativeIndoorCamera.StartResult.STARTED -> {
                nativeCamera.surface.visibility = android.view.View.VISIBLE
                web.setBackgroundColor(Color.TRANSPARENT)
            }
            com.contour.app.indoor.camera.NativeIndoorCamera.StartResult.INSTALLING -> Unit
            com.contour.app.indoor.camera.NativeIndoorCamera.StartResult.FALLBACK -> nativeCameraFallback(request)
        }
    }

    private fun publishNativeCamera(request: PageRequest, state: String) {
        if (request != nativeCameraRequest || request.generation != pageGeneration) return
        val data = org.json.JSONObject().put("navigationId", request.id).put("state", state)
        web.evaluateJavascript("window.dispatchEvent(new CustomEvent('contour-native-camera',{detail:$data}))", null)
    }

    private fun nativeCameraFallback(request: PageRequest) {
        if (request != nativeCameraRequest || request.generation != pageGeneration) return
        nativeCamera.stop()
        nativeCamera.surface.visibility = android.view.View.GONE
        web.setBackgroundColor(Color.parseColor("#F3F5F3"))
        publishNativeCamera(request, "fallback")
        nativeCameraRequest = null
    }

    private fun stopNativeCamera() {
        nativeCameraRequest = null
        arNotice?.dismiss()
        arNotice = null
        if (::nativeCamera.isInitialized) {
            nativeCamera.stop()
            nativeCamera.surface.visibility = android.view.View.GONE
        }
        if (::web.isInitialized) web.setBackgroundColor(Color.parseColor("#F3F5F3"))
    }
    private var pendingCamera: PermissionRequest? = null
    private var pendingWebCameraGeneration = 0L
    private val speechInput = com.contour.app.speech.SpeechInput(this)
    private val translator = com.contour.app.translation.OfflineTranslator()
    private var pendingLocation: Pair<String, GeolocationPermissions.Callback>? = null
    private val bundledUrl = "https://${WebViewAssetLoader.DEFAULT_DOMAIN}/assets/contour.html"
    private val hostedUrl: String? = BuildConfig.UI_URL.takeIf { it.isNotBlank() }
    private val hostedHost: String? = hostedUrl?.let { Uri.parse(it).host }
    private var usingFallback = false
    private val hostedTimeout = Runnable { fallBackToBundled() }

    /** Our own page origins: the bundled asset host and the hosted UI host. */
    private fun isOurs(host: String?) =
        host != null && (host == WebViewAssetLoader.DEFAULT_DOMAIN || host == hostedHost)

    private fun isTrustedOrigin(uri: Uri): Boolean {
        if (uri.scheme != "https") return false
        val origin = "${uri.scheme}://${uri.encodedAuthority}"
        return origin == "https://${WebViewAssetLoader.DEFAULT_DOMAIN}" ||
            hostedUrl?.let { origin == "https://${Uri.parse(it).encodedAuthority}" } == true
    }

    /** Switch to the bundled page once if the hosted page cannot be shown. */
    private fun fallBackToBundled() {
        if (usingFallback || hostedUrl == null) return
        usingFallback = true
        web.loadUrl(bundledUrl)
    }

    private val askCamera =
        registerForActivityResult(ActivityResultContracts.RequestPermission()) { granted ->
            pendingCamera?.let { if (granted && pendingWebCameraGeneration == pageGeneration && nativeCameraRequest == null && isTrustedOrigin(it.origin)) it.grant(arrayOf(PermissionRequest.RESOURCE_VIDEO_CAPTURE)) else it.deny() }
            pendingCamera = null
        }

    private var obstaclePageUrl: String? = null
    private val obstacleScan = registerForActivityResult(ActivityResultContracts.StartActivityForResult()) { result ->
        val expected = obstaclePageUrl
        obstaclePageUrl = null
        if (!pageReady || expected == null || web.url != expected || !isOurs(Uri.parse(expected).host)) return@registerForActivityResult
        val status = if (result.resultCode == RESULT_OK && result.data?.getStringExtra(com.contour.app.ar.ObstacleScanActivity.EXTRA_STATUS) == "blocked") "blocked" else "unknown"
        val payload = org.json.JSONObject().put("status", status).put("reason", result.data?.getStringExtra(com.contour.app.ar.ObstacleScanActivity.EXTRA_REASON) ?: "cancelled").put("source", "android-native")
        web.evaluateJavascript("window.contourObstacle && window.contourObstacle($payload)", null)
    }

    private fun startObstacleScan(exitDemo: Boolean = false, floor: String? = null) {
        if (!pageReady || !isOurs(web.url?.let { Uri.parse(it).host }) || obstaclePageUrl != null) return
        obstaclePageUrl = web.url
        obstacleScan.launch(Intent(this, com.contour.app.ar.ObstacleScanActivity::class.java).putExtra("exitDemo", exitDemo)
            .apply { if (floor != null) putExtra(com.contour.app.ar.ObstacleScanActivity.EXTRA_FLOOR, floor) })
    }

    // ----- Emergency pop-up: an alert waiting for the page, and the page's load state.
    private var pendingAlert: org.json.JSONObject? = null
    private var pageReady = false

    val askNotifications =
        registerForActivityResult(ActivityResultContracts.RequestPermission()) { _ -> notifyAlertSetup() }

    // ----- JMA warning notifications (FCM topic, alert/WarningPush.kt). The notification permission is
    // asked only when the user turns them on.
    private var pushEnableAfterSettings = false
    private val askPushNotifications =
        registerForActivityResult(ActivityResultContracts.RequestPermission()) { granted ->
            if (granted) enableWarningPush() else warningPushChanged("denied")
        }

    fun setWarningPush(on: Boolean) {
        if (!com.contour.app.alert.WarningPush.isAvailable(this)) { warningPushChanged("unavailable"); return }
        if (!on) {
            com.contour.app.alert.WarningPush.disable(this) { ok -> warningPushChanged(if (ok) "off" else "error") }
            return
        }
        if (androidx.core.app.NotificationManagerCompat.from(this).areNotificationsEnabled()) { enableWarningPush(); return }
        // First time: the normal permission dialog. After that (or if refused): the notification settings.
        val prefs = getSharedPreferences("contour", MODE_PRIVATE)
        if (android.os.Build.VERSION.SDK_INT >= 33 && !prefs.getBoolean("askedNotifications", false) &&
            checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED) {
            prefs.edit().putBoolean("askedNotifications", true).apply()
            askPushNotifications.launch(Manifest.permission.POST_NOTIFICATIONS)
            return
        }
        pushEnableAfterSettings = true
        openAlertSetting("notifications")
    }

    private fun enableWarningPush() =
        com.contour.app.alert.WarningPush.enable(this) { ok -> warningPushChanged(if (ok) "on" else "error") }

    private fun warningPushChanged(state: String) {
        if (isDestroyed || !::web.isInitialized) return
        web.evaluateJavascript("window.onWarningPushChanged && window.onWarningPushChanged(${org.json.JSONObject.quote(state)})", null)
        notifyAlertSetup()
    }

    fun notifyAlertSetup() {
        if (::web.isInitialized) web.evaluateJavascript("window.onAlertSetupChanged && window.onAlertSetupChanged()", null)
    }

    /** Opens the settings screen for one emergency pop-up permission. */
    fun openAlertSetting(which: String) {
        val pkg = Uri.parse("package:$packageName")
        val intent = when (which) {
            "notifications" -> {
                // First time: the normal permission dialog. After that (or if it was refused): the settings screen.
                val prefs = getSharedPreferences("contour", MODE_PRIVATE)
                if (android.os.Build.VERSION.SDK_INT >= 33 && !prefs.getBoolean("askedNotifications", false) &&
                    checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED) {
                    prefs.edit().putBoolean("askedNotifications", true).apply()
                    askNotifications.launch(Manifest.permission.POST_NOTIFICATIONS); return
                }
                Intent(android.provider.Settings.ACTION_APP_NOTIFICATION_SETTINGS).putExtra(android.provider.Settings.EXTRA_APP_PACKAGE, packageName)
            }
            "listener" -> if (android.os.Build.VERSION.SDK_INT >= 30)
                Intent(android.provider.Settings.ACTION_NOTIFICATION_LISTENER_DETAIL_SETTINGS)
                    .putExtra(android.provider.Settings.EXTRA_NOTIFICATION_LISTENER_COMPONENT_NAME,
                        com.contour.app.alert.EmergencyPopup.listenerComponent(this).flattenToString())
            else Intent(android.provider.Settings.ACTION_NOTIFICATION_LISTENER_SETTINGS)
            "overlay" -> Intent(android.provider.Settings.ACTION_MANAGE_OVERLAY_PERMISSION, pkg)
            "fullScreen" -> if (android.os.Build.VERSION.SDK_INT >= 34)
                Intent(android.provider.Settings.ACTION_MANAGE_APP_USE_FULL_SCREEN_INTENT, pkg) else return
            else -> Intent(android.provider.Settings.ACTION_APPLICATION_DETAILS_SETTINGS, pkg)   // "appInfo"
        }
        try { startActivity(intent) } catch (_: ActivityNotFoundException) {
            try { startActivity(Intent(android.provider.Settings.ACTION_APPLICATION_DETAILS_SETTINGS, pkg)) } catch (_: ActivityNotFoundException) { }
        }
    }

    /** Reads an emergency alert from the intent (from the listener, or the test button) for the page. */
    private fun takeAlert(intent: Intent?) {
        com.contour.app.alert.WarningPush.adoptTapExtras(intent)   // tapped JMA warning push
        val kind = intent?.getStringExtra(com.contour.app.alert.EmergencyPopup.EXTRA_KIND) ?: return
        intent.removeExtra(com.contour.app.alert.EmergencyPopup.EXTRA_KIND)
        // Show over the lock screen and wake the display for the alert.
        if (android.os.Build.VERSION.SDK_INT >= 27) { setShowWhenLocked(true); setTurnScreenOn(true) }
        else @Suppress("DEPRECATION") window.addFlags(
            android.view.WindowManager.LayoutParams.FLAG_SHOW_WHEN_LOCKED or android.view.WindowManager.LayoutParams.FLAG_TURN_SCREEN_ON)
        getSystemService(android.app.NotificationManager::class.java)?.cancel(7110)
        pendingAlert = org.json.JSONObject()
            .put("kind", kind)
            .put("title", intent.getStringExtra(com.contour.app.alert.EmergencyPopup.EXTRA_TITLE).orEmpty())
            .put("text", intent.getStringExtra(com.contour.app.alert.EmergencyPopup.EXTRA_TEXT).orEmpty())
        deliverAlert()
    }

    private fun deliverAlert() {
        val a = pendingAlert ?: return
        if (!pageReady || !::web.isInitialized) return
        web.evaluateJavascript("(window.contourAlert && (window.contourAlert($a), true)) === true") { ok ->
            if (ok == "true") pendingAlert = null
        }
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        setIntent(intent)
        takeAlert(intent)
    }

    val askAudio =
        registerForActivityResult(ActivityResultContracts.RequestPermission()) { granted ->
            if (granted) {
                web.evaluateJavascript("window.onAudioPermissionGranted && window.onAudioPermissionGranted()", null)
            }
        }

    // The fictional sample navigator has its own pressure session, separate from IndoorAtlas.
    private var demoSensorsRequest: PageRequest? = null
    private val indoorDemoSensors by lazy {
        com.contour.app.indoor.IndoorSensors(this) { hPa ->
            val request = demoSensorsRequest
            if (request != null && request.generation == pageGeneration && pageReady &&
                lifecycle.currentState.isAtLeast(androidx.lifecycle.Lifecycle.State.RESUMED) &&
                isTrustedOrigin(Uri.parse(web.url ?: ""))) {
                web.evaluateJavascript("window.contourIndoor && window.contourIndoor({p:$hPa})", null)
            }
        }
    }

    class ContourBridge(
        private val activity: WebUiActivity,
        private val speechInput: com.contour.app.speech.SpeechInput,
        private val translator: com.contour.app.translation.OfflineTranslator
    ) {
        @android.webkit.JavascriptInterface
        fun startListening(languageTag: String) {
            if (activity.checkSelfPermission(Manifest.permission.RECORD_AUDIO) != PackageManager.PERMISSION_GRANTED) {
                activity.askAudio.launch(Manifest.permission.RECORD_AUDIO)
                return
            }
            activity.runOnUiThread {
                speechInput.listen(
                    languageTag = languageTag,
                    onPartial = { text ->
                        activity.web.evaluateJavascript("window.onSpeechPartial && window.onSpeechPartial(${org.json.JSONObject.quote(text)})", null)
                    },
                    onFinal = { text ->
                        activity.web.evaluateJavascript("window.onSpeechFinal && window.onSpeechFinal(${org.json.JSONObject.quote(text)})", null)
                    },
                    onError = { code ->
                        activity.web.evaluateJavascript("window.onSpeechError && window.onSpeechError($code)", null)
                    }
                )
            }
        }

        @android.webkit.JavascriptInterface
        fun startLibraryExitAR() { activity.runOnUiThread { activity.startObstacleScan(exitDemo = true) } }

        /** Library exit AR starting from the floor the user picked ("B1", "1F" … "4F"); anything else falls back to 2F. */
        @android.webkit.JavascriptInterface
        fun startLibraryExitARFrom(floor: String) {
            val checked = floor.takeIf { it in setOf("B1", "1F", "2F", "3F", "4F") }
            activity.runOnUiThread { activity.startObstacleScan(exitDemo = true, floor = checked) }
        }

        @android.webkit.JavascriptInterface
        fun startObstacleScan() { activity.runOnUiThread { activity.startObstacleScan() } }

        // ----- Emergency pop-up setup page

        /** JSON: which pop-up permissions are on ({listener, overlay, notifications, fullScreen}). */
        @android.webkit.JavascriptInterface
        fun alertSetupStatus(): String = com.contour.app.alert.EmergencyPopup.status(activity).toString()

        @android.webkit.JavascriptInterface
        fun openAlertSetting(which: String) {
            activity.runOnUiThread { activity.openAlertSetting(which) }
        }

        /** JSON: JMA warning notifications ({available, enabled, notifications}). */
        @android.webkit.JavascriptInterface
        fun warningPushStatus(): String = com.contour.app.alert.WarningPush.status(activity).toString()

        /** Turn JMA warning notifications on or off; the page hears back via window.onWarningPushChanged. */
        @android.webkit.JavascriptInterface
        fun setWarningPush(on: Boolean) {
            activity.runOnUiThread { activity.setWarningPush(on) }
        }

        /** Simulates an official alert after [delayMs], so the user can leave the app and watch it pop up. */
        @android.webkit.JavascriptInterface
        fun testAlert(kind: String, delayMs: Int) {
            val k = com.contour.app.alert.AlertKind.entries.firstOrNull { it.id == kind } ?: com.contour.app.alert.AlertKind.EARTHQUAKE
            val ctx = activity.applicationContext
            android.os.Handler(android.os.Looper.getMainLooper()).postDelayed({
                // Worded like a real alert, so it is translated the same way on the alert screen.
                com.contour.app.alert.EmergencyPopup.showTest(ctx, k, "緊急地震速報（テスト）", "強い揺れに備えてください。（Contourのテストです）")
            }, delayMs.coerceIn(0, 60_000).toLong())
        }

        // ----- Indoor navigation (demo): barometer readings for floor changes

        /** Older pages retain motion/simulation fallback; pressure requires the guarded main-frame message bridge. */
        @android.webkit.JavascriptInterface
        fun startIndoor(): String = "none"

        /** JSON of the supported IndoorAtlas venues (public configuration: names, floors, POIs, exits with provenance). */
        @android.webkit.JavascriptInterface
        fun indoorVenues(): String = activity.indoorVenues.current.toJson().toString()

        @android.webkit.JavascriptInterface
        fun stopIndoor() = Unit

        @android.webkit.JavascriptInterface
        fun stopListening() {
            activity.runOnUiThread { speechInput.stop() }
        }

        @android.webkit.JavascriptInterface
        fun translateText(text: String, source: String, target: String, callbackName: String) {
            kotlinx.coroutines.CoroutineScope(kotlinx.coroutines.Dispatchers.IO).launch {
                try {
                    val result = translator.translate(text, source, target)
                    kotlinx.coroutines.withContext(kotlinx.coroutines.Dispatchers.Main) {
                        activity.web.evaluateJavascript("$callbackName(null, ${org.json.JSONObject.quote(result)})", null)
                    }
                } catch (e: Exception) {
                    kotlinx.coroutines.withContext(kotlinx.coroutines.Dispatchers.Main) {
                        activity.web.evaluateJavascript("$callbackName(${org.json.JSONObject.quote(e.message ?: "Translation error")}, null)", null)
                    }
                }
            }
        }

        @android.webkit.JavascriptInterface
        fun downloadModel(language: String, callbackName: String) {
            kotlinx.coroutines.CoroutineScope(kotlinx.coroutines.Dispatchers.IO).launch {
                try {
                    translator.downloadLanguage(language)
                    kotlinx.coroutines.withContext(kotlinx.coroutines.Dispatchers.Main) {
                        activity.web.evaluateJavascript("$callbackName(null, true)", null)
                    }
                } catch (e: Exception) {
                    kotlinx.coroutines.withContext(kotlinx.coroutines.Dispatchers.Main) {
                        activity.web.evaluateJavascript("$callbackName(${org.json.JSONObject.quote(e.message ?: "Download error")}, false)", null)
                    }
                }
            }
        }
    }
    // The page asks for location only when the user taps "my location" or opens 3D AR.
    private val askLocation =
        registerForActivityResult(ActivityResultContracts.RequestMultiplePermissions()) { result ->
            val granted = result.values.any { it }
            pendingLocation?.let { (origin, callback) -> callback.invoke(origin, granted, false) }
            pendingLocation = null
        }

    private fun hasLocationPermission() =
        checkSelfPermission(Manifest.permission.ACCESS_FINE_LOCATION) == PackageManager.PERMISSION_GRANTED ||
            checkSelfPermission(Manifest.permission.ACCESS_COARSE_LOCATION) == PackageManager.PERMISSION_GRANTED

    @SuppressLint("SetJavaScriptEnabled")
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)

        // Keep the WebView itself inside the safe area, including on older WebView versions.
        WindowCompat.setDecorFitsSystemWindows(window, false)
        WindowCompat.getInsetsController(window, window.decorView).apply {
            isAppearanceLightStatusBars = true
            isAppearanceLightNavigationBars = true
        }

        // Pre-download supported translation language models in the background
        kotlinx.coroutines.CoroutineScope(kotlinx.coroutines.Dispatchers.IO).launch {
            com.contour.app.translation.SUPPORTED_LANGUAGES.forEach { lang ->
                try { translator.downloadLanguage(lang) } catch (_: Exception) {}
            }
        }

        web = WebView(this).apply { setBackgroundColor(Color.parseColor("#F3F5F3")) }
        nativeCamera = com.contour.app.indoor.camera.NativeIndoorCamera(this,
            onPose = { tracking, pose, displayPose -> indoor.cameraPose(tracking, pose, displayPose) },
            onState = { state -> nativeCameraRequest?.let { request ->
                if (state == "fallback") nativeCameraFallback(request) else publishNativeCamera(request, state)
            } })
        nativeCamera.surface.visibility = android.view.View.GONE
        val container = FrameLayout(this).apply {
            setBackgroundColor(Color.parseColor("#F3F5F3"))
            addView(nativeCamera.surface, FrameLayout.LayoutParams(
                FrameLayout.LayoutParams.MATCH_PARENT,
                FrameLayout.LayoutParams.MATCH_PARENT
            ))
            addView(web, FrameLayout.LayoutParams(
                FrameLayout.LayoutParams.MATCH_PARENT,
                FrameLayout.LayoutParams.MATCH_PARENT
            ))
        }
        val handledInsets = WindowInsetsCompat.Type.systemBars() or
            WindowInsetsCompat.Type.displayCutout() or WindowInsetsCompat.Type.ime()
        ViewCompat.setOnApplyWindowInsetsListener(container) { v, insets ->
            val safeArea = insets.getInsets(handledInsets)
            v.setPadding(safeArea.left, safeArea.top, safeArea.right, safeArea.bottom)
            // The parent already handles these insets. Forward zero values instead of consuming
            // the notification, so newer WebViews can still update their viewport correctly.
            WindowInsetsCompat.Builder(insets)
                .setInsets(handledInsets, Insets.NONE)
                .build()
        }
        setContentView(container)
        ViewCompat.requestApplyInsets(container)

        if ((applicationInfo.flags and ApplicationInfo.FLAG_DEBUGGABLE) != 0) {
            WebView.setWebContentsDebuggingEnabled(true)   // chrome://inspect for debugging
        }

        with(web.settings) {
            javaScriptEnabled = true
            domStorageEnabled = true                  // language + attendance sheet use localStorage
            mediaPlaybackRequiresUserGesture = false  // camera preview for 3D AR
            allowFileAccess = false
            setGeolocationEnabled(true)               // nearest real sites + AR distance from GPS
            setSupportZoom(false)
            userAgentString = "$userAgentString ContourApp/1.0"   // the page switches to full-screen app mode on this tag
        }

        web.addJavascriptInterface(ContourBridge(this, speechInput, translator), "ContourBridge")
        // Main-frame-only, exact-origin bridge: external frames cannot start native sensor collection.
        if (WebViewFeature.isFeatureSupported(WebViewFeature.WEB_MESSAGE_LISTENER)) {
            val origins = mutableSetOf("https://${WebViewAssetLoader.DEFAULT_DOMAIN}")
            hostedUrl?.let { origins += "https://${Uri.parse(it).encodedAuthority}" }
            WebViewCompat.addWebMessageListener(web, "ContourIndoor", origins) { _, message, sourceOrigin, mainFrame, _ ->
                if (!mainFrame || !isTrustedOrigin(sourceOrigin) || !pageReady ||
                    !isTrustedOrigin(Uri.parse(web.url ?: "")) || sourceOrigin.encodedAuthority != Uri.parse(web.url ?: "").encodedAuthority) return@addWebMessageListener
                val text = message.data ?: return@addWebMessageListener
                if (text.length > 512) return@addWebMessageListener
                val data = try { org.json.JSONObject(text) } catch (_: Exception) { return@addWebMessageListener }
                val id = data.optString("navigationId")
                if (!id.matches(Regex("[a-zA-Z0-9-]{1,80}"))) return@addWebMessageListener
                when (data.optString("type")) {
                    "start221", "startNearestExit" -> {
                        demoSensorsRequest = null
                        indoorDemoSensors.stop()
                        startIndoor(id, com.contour.app.indoor.IndoorTarget.fromCommand(data.optString("type"))!!)
                    }
                    "stop" -> if (indoorRequest?.id == id) { indoorRequest = null; indoor.stop() }
                    "correctFloor" -> if (indoorRequest?.id == id) indoor.correctFloor(data.optInt("floor", -1))
                    "cameraStart" -> startNativeCamera(id)
                    "cameraStop" -> if (nativeCameraRequest?.id == id) stopNativeCamera()
                    "demoSensorsStart" -> {
                        demoSensorsRequest = PageRequest(id, pageGeneration)
                        if (lifecycle.currentState.isAtLeast(androidx.lifecycle.Lifecycle.State.RESUMED)) indoorDemoSensors.start()
                    }
                    "demoSensorsStop" -> if (demoSensorsRequest?.id == id) {
                        demoSensorsRequest = null
                        indoorDemoSensors.stop()
                    }
                }
            }
        }

        val assets = WebViewAssetLoader.Builder()
            .addPathHandler("/assets/", WebViewAssetLoader.AssetsPathHandler(this))
            .build()

        web.webViewClient = object : WebViewClient() {
            override fun shouldInterceptRequest(view: WebView, request: WebResourceRequest): WebResourceResponse? =
                assets.shouldInterceptRequest(request.url)

            // Anything that is not our own page (Google Maps directions, etc.) opens outside the app.
            override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest): Boolean {
                if (isOurs(request.url.host)) return false
                try {
                    startActivity(Intent(Intent.ACTION_VIEW, request.url))
                } catch (_: ActivityNotFoundException) {
                }
                return true
            }

            override fun onPageStarted(view: WebView, url: String, favicon: android.graphics.Bitmap?) {
                pageReady = false
                pageGeneration++
                indoorRequest = null
                indoor.stop()
                demoSensorsRequest = null
                indoorDemoSensors.stop()
                stopNativeCamera()
                pendingCamera?.deny()
                pendingCamera = null
            }

            override fun onPageCommitVisible(view: WebView, url: String) {
                // The hosted page arrived; slow Google assets must not switch it to the bundled origin.
                if (Uri.parse(url).host == hostedHost) web.removeCallbacks(hostedTimeout)
            }
            override fun onPageFinished(view: WebView, url: String) {
                if (Uri.parse(url).host == hostedHost) web.removeCallbacks(hostedTimeout)
                if (isOurs(Uri.parse(url).host)) { pageReady = true; deliverAlert() }
            }

            override fun onReceivedError(view: WebView, request: WebResourceRequest, error: WebResourceError) {
                if (request.isForMainFrame) fallBackToBundled()
            }

            override fun onReceivedHttpError(view: WebView, request: WebResourceRequest, response: WebResourceResponse) {
                if (request.isForMainFrame && response.statusCode >= 400) fallBackToBundled()
            }
        }

        web.webChromeClient = object : WebChromeClient() {
            override fun onPermissionRequest(request: PermissionRequest) {
                runOnUiThread {
                    val ours = isTrustedOrigin(request.origin) && isTrustedOrigin(Uri.parse(web.url ?: ""))
                    val wantsCamera = request.resources.contains(PermissionRequest.RESOURCE_VIDEO_CAPTURE)
                    if (!ours || !wantsCamera || nativeCameraRequest != null) {
                        request.deny()
                    } else if (checkSelfPermission(Manifest.permission.CAMERA) == PackageManager.PERMISSION_GRANTED) {
                        request.grant(arrayOf(PermissionRequest.RESOURCE_VIDEO_CAPTURE))
                    } else {
                        pendingCamera?.deny()
                        pendingCamera = request
                        pendingWebCameraGeneration = pageGeneration
                        askCamera.launch(Manifest.permission.CAMERA)
                    }
                }
            }

            override fun onPermissionRequestCanceled(request: PermissionRequest) {
                if (pendingCamera === request) pendingCamera = null
            }

            override fun onGeolocationPermissionsShowPrompt(
                origin: String,
                callback: GeolocationPermissions.Callback,
            ) {
                when {
                    !isOurs(Uri.parse(origin).host) -> callback.invoke(origin, false, false)
                    hasLocationPermission() -> callback.invoke(origin, true, false)
                    else -> {
                        pendingLocation?.let { (o, c) -> c.invoke(o, false, false) }
                        pendingLocation = origin to callback
                        askLocation.launch(arrayOf(
                            Manifest.permission.ACCESS_FINE_LOCATION,
                            Manifest.permission.ACCESS_COARSE_LOCATION,
                        ))
                    }
                }
            }

            override fun onGeolocationPermissionsHidePrompt() {
                pendingLocation = null
            }
        }

        // Back button / back gesture: let the page close its top-most layer first (search, sheet, AR,
        // menu pages); leave the app only when the page has nothing to close.
        onBackPressedDispatcher.addCallback(this, object : OnBackPressedCallback(true) {
            override fun handleOnBackPressed() {
                web.evaluateJavascript("(window.contourBack && window.contourBack()) === true") { handled ->
                    if (handled != "true") {
                        // Hand this one press to the system, then turn the callback back on. Since Android 12
                        // back on the home screen only moves the app to the background, so a callback left
                        // disabled would make every later back press exit the app instead of closing a page.
                        isEnabled = false
                        onBackPressedDispatcher.onBackPressed()
                        isEnabled = true
                    }
                }
            }
        })

        if (savedInstanceState == null) {
            web.loadUrl(hostedUrl ?: bundledUrl)
            // Fall back only if the hosted page never commits.
            if (hostedUrl != null) web.postDelayed(hostedTimeout, 20_000)
        } else {
            web.restoreState(savedInstanceState)
        }
        takeAlert(intent)   // opened by an emergency alert
        com.contour.app.alert.WarningPush.refresh(this)
    }

    override fun onSaveInstanceState(outState: Bundle) {
        super.onSaveInstanceState(outState)
        web.saveState(outState)
    }

    override fun onResume() {
        super.onResume()
        web.onResume()
        demoSensorsRequest?.takeIf { it.generation == pageGeneration }?.let { indoorDemoSensors.start() }
        notifyAlertSetup()   // back from a settings screen: refresh the setup page
        if (pushEnableAfterSettings) {
            pushEnableAfterSettings = false
            if (androidx.core.app.NotificationManagerCompat.from(this).areNotificationsEnabled()) enableWarningPush()
            else warningPushChanged("denied")
        }
        indoorRequest?.takeIf { it.generation == pageGeneration && pendingIndoorPermission == null }?.let { indoor.start(it.id, indoorTarget) }
        nativeCameraRequest?.let { continueNativeCamera(it) }
        refreshIndoorVenues()
    }

    /**
     * Venue list for IndoorAtlas: cached copy first, then the server. Runs on every resume (so a venue
     * renamed in IndoorAtlas shows without restarting the app), at most once per minute; cancelled
     * with the activity.
     */
    private fun refreshIndoorVenues() {
        val now = android.os.SystemClock.elapsedRealtime()
        if (venuesRefresh?.isActive == true || (venuesRefreshedAt != Long.MIN_VALUE && now - venuesRefreshedAt < 60_000)) return
        venuesRefreshedAt = now
        venuesRefresh = lifecycleScope.launch {
            if (indoorVenues.refresh() && ::web.isInitialized && pageReady)
                web.evaluateJavascript("window.dispatchEvent(new CustomEvent('contour-indoor-venues'))", null)
        }
    }

    override fun onStop() {
        super.onStop()
        // Only an alert may show Contour over the lock screen; once the app leaves the screen, the
        // normal lock applies again (otherwise anyone could open the app on a locked phone).
        if (android.os.Build.VERSION.SDK_INT >= 27) { setShowWhenLocked(false); setTurnScreenOn(false) }
        else @Suppress("DEPRECATION") window.clearFlags(
            android.view.WindowManager.LayoutParams.FLAG_SHOW_WHEN_LOCKED or android.view.WindowManager.LayoutParams.FLAG_TURN_SCREEN_ON)
    }

    override fun onPause() {
        if (::nativeCamera.isInitialized) nativeCamera.stop()
        indoor.pause()
        indoorDemoSensors.pause()
        web.evaluateJavascript("window.dispatchEvent(new CustomEvent('contour-indoor-paused'))", null)
        web.onPause()
        super.onPause()
    }

    override fun onDestroy() {
        indoor.stop()
        stopNativeCamera()
        pendingCamera?.deny()
        pendingCamera = null
        web.removeCallbacks(hostedTimeout)
        demoSensorsRequest = null
        indoorDemoSensors.stop()
        speechInput.release()
        translator.close()
        web.destroy()
        super.onDestroy()
    }
}
