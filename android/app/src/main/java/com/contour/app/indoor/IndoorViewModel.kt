package com.contour.app.indoor

import android.app.Application
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.os.Bundle
import android.os.Looper
import android.os.SystemClock
import androidx.lifecycle.AndroidViewModel
import androidx.lifecycle.viewModelScope
import com.contour.app.BuildConfig
import com.indooratlas.android.sdk.IALocation
import com.indooratlas.android.sdk.IALocationListener
import com.indooratlas.android.sdk.IALocationManager
import com.indooratlas.android.sdk.IALocationRequest
import com.indooratlas.android.sdk.IAOrientationListener
import com.indooratlas.android.sdk.IAOrientationRequest
import com.indooratlas.android.sdk.IARegion
import com.indooratlas.android.sdk.resources.IAFloorPlan
import com.indooratlas.android.sdk.resources.IALatLng
import java.net.HttpURLConnection
import java.net.URI
import java.io.ByteArrayOutputStream
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext

/** Foreground-only positioning. The screen never substitutes GPS or synthetic indoor fixes. */
data class IndoorState(
    val running: Boolean = false,
    val message: String = "Start positioning inside a mapped building.",
    val plan: IAFloorPlan? = null,
    val bitmap: Bitmap? = null,
    val loadingMap: Boolean = false,
    val mapError: Boolean = false,
    val position: IndoorPosition? = null,
    val heading: Float? = null,
    val accuracyMeters: Float? = null,
)

class IndoorViewModel(application: Application) : AndroidViewModel(application) {
    val configured = BuildConfig.INDOORATLAS_API_KEY.isNotBlank() &&
        BuildConfig.INDOORATLAS_API_SECRET.isNotBlank()
    private val mutableState = MutableStateFlow(IndoorState())
    val state = mutableState.asStateFlow()
    private var manager: IALocationManager? = null
    private var mapJob: Job? = null
    private var freshnessJob: Job? = null
    private var lastFix: IALocation? = null
    private var lastFixReceived = 0L
    private var lastHeadingReceived = 0L
    private var heading: Double? = null
    private var sdkAvailable = false

    private val locationListener = object : IALocationListener {
        override fun onLocationChanged(location: IALocation) = onMain {
            lastFix = location
            lastFixReceived = SystemClock.elapsedRealtime()
            location.region?.takeIf { it.type == IARegion.TYPE_FLOOR_PLAN }?.floorPlan?.let(::selectPlan)
            updatePosition()
        }

        override fun onStatusChanged(provider: String?, status: Int, extras: Bundle?) = onMain {
            sdkAvailable = status == IALocationManager.STATUS_AVAILABLE
            if (sdkAvailable) updatePosition()
            else mutableState.value = mutableState.value.copy(
                position = null, accuracyMeters = null, heading = null,
                message = when (status) {
                    IALocationManager.STATUS_OUT_OF_SERVICE ->
                        "Indoor positioning unavailable. Check SDK credentials, subscription and network, then stop and retry."
                    IALocationManager.STATUS_LIMITED ->
                        "Positioning is limited. Check precise location, Wi-Fi/Bluetooth scanning and device sensors."
                    else -> "Waiting for indoor positioning. Check location services and the mapped venue."
                },
            )
        }
    }
    private val regionListener = object : IARegion.Listener {
        override fun onEnterRegion(region: IARegion) = onMain {
            if (region.type == IARegion.TYPE_FLOOR_PLAN) region.floorPlan?.let(::selectPlan)
        }
        override fun onExitRegion(region: IARegion) = onMain {
            if (region.type == IARegion.TYPE_FLOOR_PLAN && region.id == mutableState.value.plan?.id) {
                mapJob?.cancel()
                lastFix = null
                mutableState.value = IndoorState(running = true, message = "No floor detected. Waiting for a mapped indoor floor.")
            }
        }
    }
    private val orientationListener = object : IAOrientationListener {
        override fun onHeadingChanged(timestamp: Long, heading: Double) = onMain {
            this@IndoorViewModel.heading = heading
            lastHeadingReceived = SystemClock.elapsedRealtime()
            val plan = mutableState.value.plan
            mutableState.value = mutableState.value.copy(
                heading = if (plan != null && mutableState.value.position != null) floorHeading(heading, plan.bearing) else null,
            )
        }
        override fun onOrientationChange(timestamp: Long, orientation: DoubleArray?) = Unit
    }

    /** Called only after explicit user action and runtime permission checks in the Activity. */
    fun start() {
        if (!configured || mutableState.value.running) return
        try {
            val sdk = manager ?: IALocationManager.create(getApplication(), Bundle().apply {
                putString(IALocationManager.EXTRA_API_KEY, BuildConfig.INDOORATLAS_API_KEY)
                putString(IALocationManager.EXTRA_API_SECRET, BuildConfig.INDOORATLAS_API_SECRET)
            }).also { manager = it }
            mutableState.value = mutableState.value.copy(running = true, message = "Finding your floor. Signal maps may need a network download.")
            sdkAvailable = false
            sdk.registerRegionListener(regionListener)
            sdk.registerOrientationListener(IAOrientationRequest(5.0, 5.0), orientationListener)
            check(sdk.requestLocationUpdates(IALocationRequest.create(), locationListener, Looper.getMainLooper()))
            // A paused screen may have cancelled its image fetch before decoding completed.
            mutableState.value.plan?.takeIf { mutableState.value.bitmap == null }?.let(::loadMap)
            freshnessJob = viewModelScope.launch {
                while (mutableState.value.running) {
                    delay(1_000)
                    val now = SystemClock.elapsedRealtime()
                    if (lastHeadingReceived > 0 && now - lastHeadingReceived > 10_000) {
                        mutableState.value = mutableState.value.copy(heading = null)
                    }
                    if (sdkAvailable && (lastFixReceived == 0L || now - lastFixReceived > 15_000)) {
                        mutableState.value = mutableState.value.copy(position = null, heading = null, accuracyMeters = null,
                            message = "Waiting for a fresh indoor fix. Confirm this floor was surveyed and its signal map generated.")
                    }
                }
            }
        } catch (_: Exception) {
            stop()
            mutableState.value = mutableState.value.copy(message = "Could not start indoor positioning. Check permissions, SDK configuration and device support.")
        }
    }

    fun stop() {
        freshnessJob?.cancel()
        mapJob?.cancel()
        manager?.let { sdk ->
            sdk.removeLocationUpdates(locationListener)
            sdk.unregisterRegionListener(regionListener)
            sdk.unregisterOrientationListener(orientationListener)
        }
        lastFix = null
        lastFixReceived = 0L
        lastHeadingReceived = 0L
        heading = null
        sdkAvailable = false
        mutableState.value = mutableState.value.copy(running = false, position = null, heading = null,
            loadingMap = false, accuracyMeters = null, message = "Positioning stopped. Tap Start to resume.")
    }

    fun permissionDenied() {
        mutableState.value = mutableState.value.copy(message = "Precise location and, on Android 12+, nearby-device scanning permissions are required. You can enable them in app settings.")
    }

    fun retryMap() { mutableState.value.plan?.let { loadMap(it) } }

    private fun selectPlan(plan: IAFloorPlan) {
        if (plan.id == mutableState.value.plan?.id) return
        mapJob?.cancel()
        mutableState.value = mutableState.value.copy(plan = plan, bitmap = null, position = null, heading = null, accuracyMeters = null)
        loadMap(plan)
    }

    private fun loadMap(plan: IAFloorPlan) {
        mapJob?.cancel()
        mutableState.value = mutableState.value.copy(loadingMap = true, mapError = false)
        mapJob = viewModelScope.launch {
            try {
                val bitmap = withContext(Dispatchers.IO) { downloadFloorImage(plan.url) }
                if (mutableState.value.plan?.id == plan.id) {
                    mutableState.value = mutableState.value.copy(bitmap = bitmap, loadingMap = false)
                    updatePosition()
                }
            } catch (cancelled: CancellationException) {
                throw cancelled
            } catch (_: Exception) {
                if (mutableState.value.plan?.id == plan.id) {
                    mutableState.value = mutableState.value.copy(loadingMap = false, mapError = true, bitmap = null,
                        position = null, message = "Floor image could not load. Check your connection and retry.")
                }
            }
        }
    }

    private fun updatePosition() {
        val current = mutableState.value
        val plan = current.plan ?: return
        val fix = lastFix ?: return
        val point = plan.coordinateToPoint(IALatLng(fix.latitude, fix.longitude))
        val valid = sdkAvailable && SystemClock.elapsedRealtime() - lastFixReceived <= 15_000 &&
            current.bitmap != null && usableIndoorFix(fix.latitude, fix.longitude, fix.accuracy,
                if (fix.hasFloorLevel()) fix.floorLevel else null, plan.floorLevel,
                point.x, point.y, plan.bitmapWidth, plan.bitmapHeight)
        val radius = plan.metersToPixels * fix.accuracy
        mutableState.value = current.copy(
            position = if (valid && radius.isFinite() && radius > 0) IndoorPosition(point.x, point.y, radius) else null,
            heading = if (valid && SystemClock.elapsedRealtime() - lastHeadingReceived <= 10_000)
                heading?.let { floorHeading(it, plan.bearing) } else null,
            accuracyMeters = if (valid) fix.accuracy else null,
            message = if (valid) "Estimated indoor location. The circle shows reported uncertainty."
                else "Floor or position is uncertain. Waiting for an indoor fix on this map.",
        )
    }

    private fun onMain(action: () -> Unit) {
        viewModelScope.launch { if (mutableState.value.running) action() }
    }

    override fun onCleared() {
        stop()
        manager?.destroy()
        manager = null
        super.onCleared()
    }
}

/** Bounded HTTPS image download; cancellation never publishes a previous floor's image. */
private fun downloadFloorImage(url: String): Bitmap {
    val uri = URI(url)
    require(uri.scheme == "https" && uri.host != null && uri.userInfo == null)
    val connection = uri.toURL().openConnection() as HttpURLConnection
    connection.connectTimeout = 10_000
    connection.readTimeout = 10_000
    // Avoid silently following a redirect to a cleartext or unrelated image endpoint.
    connection.instanceFollowRedirects = false
    try {
        check(connection.responseCode == 200)
        val bytes = connection.inputStream.use { input ->
            val output = ByteArrayOutputStream()
            val buffer = ByteArray(8192)
            while (true) {
                val count = input.read(buffer)
                if (count == -1) break
                require(output.size() + count <= 12 * 1024 * 1024)
                output.write(buffer, 0, count)
            }
            output.toByteArray()
        }
        val bounds = BitmapFactory.Options().apply { inJustDecodeBounds = true }
        BitmapFactory.decodeByteArray(bytes, 0, bytes.size, bounds)
        require(bounds.outWidth in 1..20_000 && bounds.outHeight in 1..20_000)
        val options = BitmapFactory.Options().apply { inSampleSize = 1 }
        while (maxOf(bounds.outWidth, bounds.outHeight) / options.inSampleSize > 4096) options.inSampleSize *= 2
        return requireNotNull(BitmapFactory.decodeByteArray(bytes, 0, bytes.size, options))
    } finally {
        connection.disconnect()
    }
}
