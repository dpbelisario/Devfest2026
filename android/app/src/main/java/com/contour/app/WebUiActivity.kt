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

    private lateinit var web: WebView
    private var pendingCamera: PermissionRequest? = null
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

            override fun onPageFinished(view: WebView, url: String) {
                if (Uri.parse(url).host == hostedHost) web.removeCallbacks(hostedTimeout)
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

        // Back button: let the page close its top-most layer first; exit only when it has nothing to close.
        onBackPressedDispatcher.addCallback(this, object : OnBackPressedCallback(true) {
            override fun handleOnBackPressed() {
                web.evaluateJavascript("(window.contourBack && window.contourBack()) === true") { handled ->
                    if (handled != "true") {
                        isEnabled = false
                        onBackPressedDispatcher.onBackPressed()
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
    }

    override fun onSaveInstanceState(outState: Bundle) {
        super.onSaveInstanceState(outState)
        web.saveState(outState)
    }

    override fun onResume() {
        super.onResume()
        web.onResume()
    }

    override fun onPause() {
        web.onPause()
        super.onPause()
    }

    override fun onDestroy() {
        web.removeCallbacks(hostedTimeout)
        web.destroy()
        super.onDestroy()
    }
}
