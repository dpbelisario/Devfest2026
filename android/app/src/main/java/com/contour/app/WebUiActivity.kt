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
    private var pendingCamera: PermissionRequest? = null
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

    /** Switch to the bundled page once if the hosted page cannot be shown. */
    private fun fallBackToBundled() {
        if (usingFallback || hostedUrl == null) return
        usingFallback = true
        web.loadUrl(bundledUrl)
    }

    private val askCamera =
        registerForActivityResult(ActivityResultContracts.RequestPermission()) { granted ->
            pendingCamera?.let { if (granted) it.grant(arrayOf(PermissionRequest.RESOURCE_VIDEO_CAPTURE)) else it.deny() }
            pendingCamera = null
        }

    // ----- Emergency pop-up: an alert waiting for the page, and the page's load state.
    private var pendingAlert: org.json.JSONObject? = null
    private var pageReady = false

    val askNotifications =
        registerForActivityResult(ActivityResultContracts.RequestPermission()) { _ -> notifyAlertSetup() }

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

        // ----- Emergency pop-up setup page

        /** JSON: which pop-up permissions are on ({listener, overlay, notifications, fullScreen}). */
        @android.webkit.JavascriptInterface
        fun alertSetupStatus(): String = com.contour.app.alert.EmergencyPopup.status(activity).toString()

        @android.webkit.JavascriptInterface
        fun openAlertSetting(which: String) {
            activity.runOnUiThread { activity.openAlertSetting(which) }
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
        val container = FrameLayout(this).apply {
            setBackgroundColor(Color.parseColor("#F3F5F3"))
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
                    val ours = isOurs(request.origin.host)
                    val wantsCamera = request.resources.contains(PermissionRequest.RESOURCE_VIDEO_CAPTURE)
                    if (!ours || !wantsCamera) {
                        request.deny()
                    } else if (checkSelfPermission(Manifest.permission.CAMERA) == PackageManager.PERMISSION_GRANTED) {
                        request.grant(arrayOf(PermissionRequest.RESOURCE_VIDEO_CAPTURE))
                    } else {
                        pendingCamera = request
                        askCamera.launch(Manifest.permission.CAMERA)
                    }
                }
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
            // A slow network must not leave a blank screen: use the bundled page after 8 s.
            if (hostedUrl != null) web.postDelayed(hostedTimeout, 8_000)
        } else {
            web.restoreState(savedInstanceState)
        }
        takeAlert(intent)   // opened by an emergency alert
    }

    override fun onSaveInstanceState(outState: Bundle) {
        super.onSaveInstanceState(outState)
        web.saveState(outState)
    }

    override fun onResume() {
        super.onResume()
        web.onResume()
        notifyAlertSetup()   // back from a settings screen: refresh the setup page
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
        web.onPause()
        super.onPause()
    }

    override fun onDestroy() {
        web.removeCallbacks(hostedTimeout)
        speechInput.release()
        translator.close()
        web.destroy()
        super.onDestroy()
    }
}
