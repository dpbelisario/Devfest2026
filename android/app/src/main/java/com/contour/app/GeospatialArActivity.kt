package com.contour.app

import android.Manifest
import android.content.Intent
import android.content.pm.PackageManager
import android.location.LocationManager
import android.net.Uri
import android.opengl.GLSurfaceView
import android.os.Bundle
import android.provider.Settings
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.activity.result.contract.ActivityResultContracts
import androidx.activity.viewModels
import androidx.compose.runtime.*
import androidx.core.view.WindowCompat
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import com.contour.app.ar.GeospatialSession
import com.contour.app.ar.rendering.GeospatialRenderer
import com.contour.app.ui.ar.GeospatialArScreen
import com.contour.app.ui.ar.GeospatialArViewModel
import com.contour.app.ui.theme.ContourTheme
import com.google.ar.core.exceptions.CameraNotAvailableException
import com.google.ar.core.exceptions.UnavailableDeviceNotCompatibleException
import com.google.ar.core.exceptions.UnavailableUserDeclinedInstallationException

/** Native AR entry point. The WebView never receives camera frames, poses, or native objects. */
class GeospatialArActivity : ComponentActivity() {
    private val model by viewModels<GeospatialArViewModel>()
    private val controller = GeospatialSession()
    private lateinit var surface: GLSurfaceView
    private lateinit var renderer: GeospatialRenderer
    private var accepted by mutableStateOf(false)
    private var permissionsGranted by mutableStateOf(false)
    private var running by mutableStateOf(false)
    private var error by mutableStateOf<String?>(null)
    private var resumed = false
    private var generation = 0L
    private val permissions = arrayOf(Manifest.permission.CAMERA, Manifest.permission.ACCESS_FINE_LOCATION, Manifest.permission.ACCESS_COARSE_LOCATION)
    private val askPermissions = registerForActivityResult(ActivityResultContracts.RequestMultiplePermissions()) {
        permissionsGranted = hasPermissions()
        if (permissionsGranted) startSession()
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        WindowCompat.setDecorFitsSystemWindows(window, false)
        WindowCompat.getInsetsController(window, window.decorView).apply {
            isAppearanceLightStatusBars = true
            isAppearanceLightNavigationBars = true
        }
        accepted = savedInstanceState?.getBoolean("arConsent") ?: false
        permissionsGranted = hasPermissions()
        renderer = GeospatialRenderer(
            rotation = { surface.display?.rotation ?: 0 },
            onState = { epoch, tracking -> runOnUiThread { if (running && epoch == generation) model.onTrackingState(tracking) } },
            onFailure = { epoch -> runOnUiThread {
                if (epoch == generation) {
                    stopSession(close = true)
                    error = "AR camera or rendering stopped. Check camera access, close other camera apps, and retry AR."
                }
            } },
        )
        surface = GLSurfaceView(this).apply {
            setEGLContextClientVersion(2)
            preserveEGLContextOnPause = true
            setRenderer(renderer)
        }
        setContent {
            val state by model.state.collectAsStateWithLifecycle()
            LaunchedEffect(state.route) { renderer.requestedRoute.set(state.route) }
            ContourTheme {
                GeospatialArScreen(surface, state, accepted, permissionsGranted, running, error,
                    onConsent = { accepted = true; if (hasPermissions()) startSession() else askPermissions.launch(permissions) },
                    onPermissions = { askPermissions.launch(permissions) },
                    onSettings = { openUrl(Settings.ACTION_APPLICATION_DETAILS_SETTINGS, Uri.parse("package:$packageName")) },
                    onPrivacy = { openUrl(Intent.ACTION_VIEW, Uri.parse("https://support.google.com/ar?p=how-google-play-services-for-ar-handles-your-data")) },
                    onGooglePrivacy = { openUrl(Intent.ACTION_VIEW, Uri.parse("https://policies.google.com/privacy")) },
                    onRetry = { stopSession(close = true); error = null; startSession() },
                    onRefresh = model::refreshDestinations, onSelect = model::select, onBack = { finish() })
            }
        }
    }

    private fun openUrl(action: String, uri: Uri) {
        try { startActivity(Intent(action, uri)) } catch (_: android.content.ActivityNotFoundException) { }
    }

    private fun hasPermissions() = checkSelfPermission(Manifest.permission.CAMERA) == PackageManager.PERMISSION_GRANTED &&
        checkSelfPermission(Manifest.permission.ACCESS_FINE_LOCATION) == PackageManager.PERMISSION_GRANTED

    private fun startSession() {
        if (!resumed || running || !accepted || !hasPermissions() || error != null) return
        if (!BuildConfig.ARCORE_CONFIGURED || BuildConfig.API_BASE_URL.contains("example.invalid")) {
            error = "AR is not configured in this build. Set ARCORE_API_KEY and EVACUATION_AR_API_BASE_URL in local.properties, then rebuild. See docs/geospatial-ar.md."
            return
        }
        if (!getSystemService(LocationManager::class.java).isProviderEnabled(LocationManager.GPS_PROVIDER)) {
            error = "Turn on device location in Android settings, then retry AR."
            return
        }
        try {
            if (!controller.resume(this)) return
            renderer.generation = generation
            renderer.session = controller.session
            running = true
            surface.onResume()
        } catch (_: UnavailableDeviceNotCompatibleException) {
            error = "This device does not support ARCore. Use a supported physical Android phone."
            stopSession(close = true)
        } catch (_: UnavailableUserDeclinedInstallationException) {
            error = "Google Play Services for AR installation was declined. Retry AR to install it."
            stopSession(close = true)
        } catch (_: CameraNotAvailableException) {
            error = "The camera is unavailable. Close other camera apps and retry AR."
            stopSession(close = true)
        } catch (_: IllegalStateException) {
            error = "Geospatial AR is not supported in this device configuration. Use a supported physical phone."
            stopSession(close = true)
        } catch (_: Exception) {
            error = "AR could not start. Update Google Play Services for AR, check precise location permission, and retry."
            stopSession(close = true)
        }
    }

    private fun stopSession(close: Boolean) {
        generation++ // Ignore queued GL reports from the previous camera lifecycle.
        running = false
        surface.onPause() // Stops GL session.update() before detaching anchors or pausing ARCore.
        renderer.releaseSession()
        controller.pause()
        if (close) controller.close()
        model.sessionPaused()
    }

    override fun onResume() {
        super.onResume()
        resumed = true
        permissionsGranted = hasPermissions()
        if (accepted && permissionsGranted && error == null) startSession()
    }

    override fun onPause() {
        resumed = false
        stopSession(close = false)
        super.onPause()
    }

    override fun onSaveInstanceState(outState: Bundle) {
        outState.putBoolean("arConsent", accepted)
        super.onSaveInstanceState(outState)
    }

    override fun onDestroy() {
        controller.close()
        super.onDestroy()
    }
}
