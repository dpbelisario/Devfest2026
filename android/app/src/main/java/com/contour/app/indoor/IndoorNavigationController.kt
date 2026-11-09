package com.contour.app.indoor

import android.annotation.SuppressLint
import android.hardware.GeomagneticField
import android.hardware.Sensor
import android.hardware.SensorEvent
import android.hardware.SensorEventListener
import android.hardware.SensorManager
import android.location.Location
import android.location.LocationListener
import android.location.LocationManager
import android.os.Build
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.os.SystemClock
import androidx.activity.ComponentActivity
import androidx.lifecycle.lifecycleScope
import com.contour.app.BuildConfig
import com.indooratlas.android.sdk.*
import com.indooratlas.android.sdk.resources.IALocationListenerSupport
import com.indooratlas.android.sdk.resources.IAVenue
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import org.json.JSONArray
import org.json.JSONObject
import kotlin.math.atan2
import kotlin.math.hypot

/**
 * Foreground-only native positioning and continuous CMS wayfinding. Never seeds a fictional indoor start.
 * Supported venues come from [venues] (server list, device cache or build-time default); a venue the
 * SDK detects that is not in the list is treated as not mapped.
 *
 * The [IndoorTarget] of a session is room 221 (SDK route to its POI) or the detected venue's nearest
 * exit (SDK route to the exit's coordinates and floor; when the venue has no wayfinding graph or the
 * SDK finds no route, a straight bearing reported as status `direct`, never as a route).
 */
class IndoorNavigationController(
    private val activity: ComponentActivity,
    private val venues: () -> IndoorVenueCatalog,
    private val publish: (JSONObject) -> Unit,
) : SensorEventListener, LocationListener {
    private val sensors = activity.getSystemService(SensorManager::class.java)
    private val gps = activity.getSystemService(LocationManager::class.java)
    private val handler = Handler(Looper.getMainLooper())
    private var estimator = FloorEstimator()
    private var manager: IALocationManager? = null
    private var arFusion: IAARSession? = null
    private var cameraTracking: Boolean? = null
    private var navigationId: String? = null
    private var running = false
    private var status = "locating"
    private var venue: IAVenue? = null
    /** Runtime configuration of the detected [venue], when the venue is supported. */
    private var venueConfig: IndoorVenueConfig? = null
    private var route: IARoute? = null
    private var routeAt = 0L
    private var target = IndoorTarget.ROOM_221
    /** The chosen exit for [IndoorTarget.NEAREST_EXIT], with the floor it was chosen on. */
    private var exitDestination: ExitDestination? = null
    private var exitChosenOnFloor: Int? = null
    private var position: IALocation? = null
    private var positionAt = 0L
    private var heading: Double? = null
    private var headingAt = 0L
    private var declination: Double? = null
    private var declinationAt = 0L
    private var lastEmission = 0L
    private var convertingAltitude = false
    private var lastAltitudeAt = 0L
    private var routeRequested = false
    private var lockedFloor: Int? = null
    private var sessionGeneration = 0L
    private var sdkStatus = IALocationManager.STATUS_TEMPORARILY_UNAVAILABLE
    private val freshness = Runnable { emit(true); if (running) handler.postDelayed(freshnessTick, 1000) }
    private val freshnessTick: Runnable get() = freshness

    private var locationListener: IALocationListenerSupport? = null
    private var regionListener: IARegion.Listener? = null
    private val locationCallbacks = object : IALocationListenerSupport() {
        override fun onLocationChanged(location: IALocation) {
            if (!running) return
            if (!insideSupportedVenue(location.latitude, location.longitude)) {
                position = null; route = null; routeRequested = false; exitDestination = null
                manager?.removeWayfindingUpdates()
                status = "outsideBuilding"
                emit(true)
                return
            }
            position = location
            positionAt = SystemClock.elapsedRealtime()
            updateDeclination(location.toLocation())
            location.region?.venue?.let { enterVenue(it) }
            chooseExit(location)
            emit(true)
        }

        override fun onStatusChanged(provider: String?, value: Int, extras: Bundle?) {
            if (!running) return
            sdkStatus = value
            if (value == IALocationManager.STATUS_OUT_OF_SERVICE) status = "sdkUnavailable"
            emit(true)
        }
    }

    private val regionCallbacks = object : IARegion.Listener {
        override fun onEnterRegion(region: IARegion) {
            if (!running) return
            region.venue?.let { enterVenue(it) }
        }
        override fun onExitRegion(region: IARegion) {
            if (!running || region.type != IARegion.TYPE_VENUE) return
            venue = null; venueConfig = null; route = null; position = null; routeRequested = false; exitDestination = null
            manager?.removeWayfindingUpdates()
            status = "locating"
            emit(true)
        }
    }

    /** Starts after the host has requested location/sensor permissions. Missing credentials still allow estimates. */
    @SuppressLint("MissingPermission")
    fun start(id: String, target: IndoorTarget = this.target) {
        if (running && navigationId == id && this.target == target) { emit(true); return }
        if (navigationId != id) { stop(); estimator = FloorEstimator(); lockedFloor = null }
        else pause()
        navigationId = id
        this.target = target
        running = true
        sessionGeneration++
        status = if (BuildConfig.INDOORATLAS_CONFIGURED) "locating" else "mappingRequired"
        listOf(Sensor.TYPE_ROTATION_VECTOR, Sensor.TYPE_PRESSURE, Sensor.TYPE_STEP_DETECTOR).forEach { type ->
            sensors.getDefaultSensor(type)?.let { sensor ->
                try { sensors.registerListener(this, sensor, SensorManager.SENSOR_DELAY_UI) } catch (_: SecurityException) { }
            }
        }
        try { gps.requestLocationUpdates(LocationManager.GPS_PROVIDER, 2000L, 0f, this) } catch (_: Exception) { }
        if (BuildConfig.INDOORATLAS_CONFIGURED) {
            try {
                manager = IALocationManager.create(activity)
                val generation = sessionGeneration
                regionListener = object : IARegion.Listener {
                    override fun onEnterRegion(region: IARegion) { if (generation == sessionGeneration) regionCallbacks.onEnterRegion(region) }
                    override fun onExitRegion(region: IARegion) { if (generation == sessionGeneration) regionCallbacks.onExitRegion(region) }
                }.also { manager?.registerRegionListener(it) }
                locationListener = object : IALocationListenerSupport() {
                    override fun onLocationChanged(location: IALocation) { if (generation == sessionGeneration) locationCallbacks.onLocationChanged(location) }
                    override fun onStatusChanged(provider: String?, value: Int, extras: Bundle?) {
                        if (generation == sessionGeneration) locationCallbacks.onStatusChanged(provider, value, extras)
                    }
                }.also { manager?.requestLocationUpdates(IALocationRequest.create(), it, Looper.getMainLooper()) }
                lockedFloor?.let { manager?.lockFloor(it) }
            } catch (_: Exception) { status = "sdkUnavailable" }
        }
        handler.postDelayed(freshness, 1000)
        emit(true)
    }

    fun correctFloor(floor: Int) {
        if (!running || floor !in 1..4) return
        estimator.correctFloor(floor)
        lockedFloor = floor
        manager?.lockFloor(floor)
        route = null // do not keep directions from the previously selected floor
        emit(true)
    }

    /** Feed real ARCore tracked camera frames, optionally fusing them with IndoorAtlas when the account enables AR. */
    fun cameraPose(tracking: Boolean, pose: FloatArray, cameraToWorld: FloatArray) {
        if (!running) return
        val previousTracking = cameraTracking
        cameraTracking = tracking
        val previousFloor = estimator.estimate().floor
        estimator.observeVisualHeight(if (tracking && pose.size >= 16 && pose[13].isFinite()) pose[13].toDouble() else null, SystemClock.elapsedRealtime())
        if (lockedFloor != null && estimator.estimate().floor != lockedFloor) {
            lockedFloor = estimator.estimate().floor
            lockedFloor?.let { manager?.lockFloor(it) }
            route = null
        }
        if (tracking && pose.size == 16 && cameraToWorld.size == 16 && BuildConfig.INDOORATLAS_AR_FUSION) {
            try {
                if (arFusion == null) arFusion = manager?.requestArUpdates()
                arFusion?.setPoseMatrix(pose)
                arFusion?.setCameraToWorldMatrix(cameraToWorld)
            } catch (_: Exception) { /* SDK AR entitlement unavailable; relative ARCore estimate remains usable */ }
        }
        emit(previousFloor != estimator.estimate().floor || previousTracking != tracking)
    }

    /** Release foreground resources, retaining the same navigation's measured/corrected floor. */
    fun pause() {
        running = false
        sessionGeneration++
        estimator.observeVisualHeight(null, SystemClock.elapsedRealtime())
        handler.removeCallbacks(freshness)
        sensors.unregisterListener(this)
        try { gps.removeUpdates(this) } catch (_: SecurityException) { }
        arFusion?.destroy()
        arFusion = null
        manager?.let {
            it.removeWayfindingUpdates()
            locationListener?.let { listener -> it.removeLocationUpdates(listener) }
            regionListener?.let { listener -> it.unregisterRegionListener(listener) }
            it.unlockFloor()
            it.destroy()
        }
        locationListener = null; regionListener = null
        manager = null; venue = null; venueConfig = null; route = null; position = null; heading = null
        routeRequested = false; declination = null; exitDestination = null; exitChosenOnFloor = null
        sdkStatus = IALocationManager.STATUS_TEMPORARILY_UNAVAILABLE
        cameraTracking = null
    }

    fun stop() {
        pause()
        navigationId = null
        lockedFloor = null
        estimator = FloorEstimator()
        lastEmission = 0L
    }

    /** Coarse gate: the detected venue's area once known, otherwise any supported venue's area. */
    private fun insideSupportedVenue(latitude: Double, longitude: Double): Boolean =
        venueConfig?.contains(latitude, longitude) ?: venues().containing(latitude, longitude).isNotEmpty()

    private fun enterVenue(value: IAVenue) {
        val config = venues().venueFor(value.id)
        if (config == null) {
            venue = null; venueConfig = null; route = null; status = "wrongVenue"; routeRequested = false
            manager?.removeWayfindingUpdates()
            return
        }
        venue = value
        venueConfig = config
        if (target == IndoorTarget.NEAREST_EXIT) {
            if (config.exits.isEmpty()) status = "noExits"
            return // chosen from the first usable position, see chooseExit
        }
        if (routeRequested) return
        val poiId = config.room221()?.indoorAtlasPoiId
        val matches = value.poIs.filter {
            if (poiId != null) it.id.equals(poiId, ignoreCase = true)
            else IndoorVenueConfig.ROOM_221.matches(it.name.trim())
        }
        if (matches.size != 1) { status = "missingRoom"; return }
        routeRequested = true
        val generation = sessionGeneration
        manager?.requestWayfindingUpdates(matches.single(), IAWayfindingListener { value ->
            if (running && generation == sessionGeneration) {
                route = value
                routeAt = SystemClock.elapsedRealtime()
                status = if (value.isSuccessful && value.legs.isNotEmpty()) "navigating" else "noRoute"
                emit(true)
            }
        }, Looper.getMainLooper())
    }

    /**
     * Nearest-exit sessions: choose the exit from a usable position (known floor, accuracy ≤15 m) and
     * re-choose when the floor changes. ROUTE destinations ask the SDK for continuous wayfinding to the
     * exit's coordinates and floor; while the SDK has no route (or the venue has no graph) the session
     * reports status `direct` with a straight bearing instead.
     */
    private fun chooseExit(location: IALocation) {
        if (target != IndoorTarget.NEAREST_EXIT) return
        val config = venueConfig ?: return
        if (!location.hasFloorLevel() || !location.accuracy.isFinite() || location.accuracy > 15f) return
        val floor = location.floorLevel
        if (exitDestination != null && exitChosenOnFloor == floor) return
        val exit = IndoorTargets.nearestExit(config.exits, location.latitude, location.longitude, floor)
        if (exit == null) { status = "noExits"; return }
        exitChosenOnFloor = floor
        if (exitDestination?.exit == exit) return
        manager?.removeWayfindingUpdates()
        route = null
        val destination = IndoorTargets.destination(config, exit)
        exitDestination = destination
        if (destination.mode == ExitDestination.Mode.DIRECT) { status = "direct"; return }
        status = "locating"
        val generation = sessionGeneration
        val request = IAWayfindingRequest.Builder()
            .withLatitude(destination.latitude).withLongitude(destination.longitude).withFloor(destination.floor).build()
        manager?.requestWayfindingUpdates(request, IAWayfindingListener { value ->
            if (running && generation == sessionGeneration && exitDestination === destination) {
                route = value
                routeAt = SystemClock.elapsedRealtime()
                status = if (value.isSuccessful && value.legs.isNotEmpty()) "navigating" else "direct"
                emit(true)
            }
        }, Looper.getMainLooper())
    }

    private fun updateDeclination(location: Location) {
        if (!location.hasAccuracy() || location.accuracy > 50 || !location.latitude.isFinite() || !location.longitude.isFinite()) return
        declination = GeomagneticField(location.latitude.toFloat(), location.longitude.toFloat(), location.altitude.toFloat(), System.currentTimeMillis()).declination.toDouble()
        declinationAt = SystemClock.elapsedRealtime()
    }

    override fun onLocationChanged(location: Location) {
        if (!running) return
        if (!location.hasAccuracy() || !location.accuracy.isFinite() || location.accuracy > 50 ||
            !EngineeringLocationPolicy.contains(location.latitude, location.longitude)) return
        updateDeclination(location)
        // GSI ground elevation is orthometric/MSL; never subtract it from GPS ellipsoid altitude.
        if (Build.VERSION.SDK_INT < 34 || !location.hasAltitude() || !location.hasVerticalAccuracy()) return
        if (convertingAltitude || SystemClock.elapsedRealtime() - lastAltitudeAt < 10000) return
        convertingAltitude = true
        lastAltitudeAt = SystemClock.elapsedRealtime()
        val id = navigationId
        val generation = sessionGeneration
        activity.lifecycleScope.launch {
            try {
                val converted = withContext(Dispatchers.IO) {
                    Location(location).apply {
                        if (!hasMslAltitude()) android.location.altitude.AltitudeConverter().addMslAltitudeToLocation(activity, this)
                    }
                }
                if (running && navigationId == id && generation == sessionGeneration && converted.hasMslAltitude() && converted.hasMslAltitudeAccuracy()) {
                    estimator.observeMslAltitude(converted.mslAltitudeMeters, converted.mslAltitudeAccuracyMeters.toDouble())
                    emit(true)
                }
            } catch (cancelled: CancellationException) { throw cancelled
            } catch (_: Exception) { /* retain an unknown floor instead of assuming a datum */ }
            finally { convertingAltitude = false }
        }
    }

    override fun onSensorChanged(event: SensorEvent) {
        if (!running) return
        val previousFloor = estimator.estimate().floor
        when (event.sensor.type) {
            Sensor.TYPE_PRESSURE -> {
                estimator.observePressure(event.values[0].toDouble(), SystemClock.elapsedRealtime())
                if (lockedFloor != null && estimator.estimate().floor != lockedFloor) {
                    lockedFloor = estimator.estimate().floor
                    lockedFloor?.let { manager?.lockFloor(it) }
                    route = null
                }
            }
            Sensor.TYPE_STEP_DETECTOR -> estimator.step()
            Sensor.TYPE_ROTATION_VECTOR -> {
                val matrix = FloatArray(9)
                SensorManager.getRotationMatrixFromVector(matrix, event.values)
                // Rear camera looks along device -Z; SDK heading's +Y axis is unsuitable when upright.
                val east = -matrix[2].toDouble()
                val north = -matrix[5].toDouble()
                heading = if (event.accuracy >= SensorManager.SENSOR_STATUS_ACCURACY_MEDIUM && hypot(east, north) > 0.2 && declination != null)
                    (Math.toDegrees(atan2(east, north)) + declination!! + 360) % 360 else null
                headingAt = SystemClock.elapsedRealtime()
            }
        }
        emit(previousFloor != estimator.estimate().floor)
    }

    override fun onAccuracyChanged(sensor: Sensor?, accuracy: Int) { }

    private fun emit(force: Boolean = false) {
        if (!running) return
        val now = SystemClock.elapsedRealtime()
        if (!force && now - lastEmission < 200) return
        lastEmission = now
        val p = position
        val config = venueConfig
        // A floor plan listed in the venue configuration must agree with the SDK's floor level.
        val floorPlanAgrees = p?.region?.takeIf { it.type == IARegion.TYPE_FLOOR_PLAN }?.let { region ->
            config?.floorLevelOf(region.id)?.let { it == p.floorLevel }
        } ?: true
        val trusted = p != null && config != null && config.contains(p.latitude, p.longitude) && now - positionAt <= 6000 && p.accuracy.isFinite() && p.accuracy <= 8f &&
            p.hasFloorLevel() && floorOk(config, p.floorLevel) && floorPlanAgrees && (lockedFloor != null || (p.hasFloorCertainty() && p.floorCertainty >= 0.7f)) &&
            sdkStatus == IALocationManager.STATUS_AVAILABLE && venue?.id.equals(config.indoorAtlasVenueId, ignoreCase = true)
        if (trusted && lockedFloor == null) estimator.observeIndoorFloor(p!!.floorLevel)
        val estimate = estimator.estimate()
        val liveFloor = if (trusted && lockedFloor == null) p!!.floorLevel else estimate.floor
        val source = if (trusted && lockedFloor == null) "indooratlas" else estimate.source
        val payload = JSONObject().put("navigationId", navigationId).put("status", if ((status == "navigating" || status == "direct") && !trusted) "lowAccuracy" else status)
            .put("floor", liveFloor ?: JSONObject.NULL).put("floorSource", source)
            .put("uncertaintyFloors", if (source == "indooratlas") 0 else estimate.uncertaintyFloors ?: JSONObject.NULL)
            .put("heading", if (now - headingAt <= 2000 && now - declinationAt < 60000) heading ?: JSONObject.NULL else JSONObject.NULL)
            .put("cameraTracking", cameraTracking ?: JSONObject.NULL)
        config?.let { payload.put("venue", JSONObject().put("id", it.id).put("rank", it.rank ?: JSONObject.NULL)
            .put("name", JSONObject().put("en", it.name.en).put("ja", it.name.ja))) }
        payload.put("target", targetJson())
        val destination = exitDestination
        if (trusted && status == "direct" && destination != null) {
            // Straight line to the exit: the page labels it "direct direction, not a route".
            val distance = IndoorTargets.distanceMeters(p!!.latitude, p.longitude, destination.latitude, destination.longitude)
            val bearing = IndoorTargets.bearingDegrees(p.latitude, p.longitude, destination.latitude, destination.longitude)
            if (distance.isFinite() && bearing.isFinite())
                payload.put("direct", JSONObject().put("distance", distance).put("bearing", bearing).put("floor", destination.floor))
        }
        if (trusted && now - routeAt <= 6000 && route?.isSuccessful == true) {
            val legs = route!!.legs
            if (legs.size in 1..256 && legs.first().begin.floor == liveFloor && legs.all { it.length.isFinite() && it.length >= 0 && it.begin.latitude.isFinite() && it.begin.longitude.isFinite() && it.end.latitude.isFinite() && it.end.longitude.isFinite() && floorOk(config, it.begin.floor) && floorOk(config, it.end.floor) && config!!.contains(it.begin.latitude, it.begin.longitude) && config.contains(it.end.latitude, it.end.longitude) }) {
                payload.put("status", "navigating")
                payload.put("legs", JSONArray().apply {
                    legs.forEach { leg ->
                        put(JSONObject().put("length", leg.length)
                            .put("begin", point(leg.begin)).put("end", point(leg.end)))
                    }
                })
            }
        }
        publish(payload)
    }

    /** Floors the app accepts: the Engineering II range 1..4 or any floor the venue lists. */
    private fun floorOk(config: IndoorVenueConfig?, level: Int) =
        level in 1..4 || config?.floors?.any { it.floorLevel == level } == true

    private fun targetJson(): JSONObject {
        if (target == IndoorTarget.ROOM_221) return JSONObject().put("type", "room221")
        val json = JSONObject().put("type", "exit")
        exitDestination?.let { d ->
            json.put("id", d.exit.id).put("name", JSONObject().put("en", d.exit.name.en).put("ja", d.exit.name.ja))
                .put("floor", d.floor).put("kind", d.exit.kind).put("source", d.exit.source)
                .put("mode", if (d.mode == ExitDestination.Mode.ROUTE) "route" else "direct")
        }
        return json
    }

    private fun point(p: IARoute.Point) = JSONObject().put("latitude", p.latitude).put("longitude", p.longitude).put("floor", p.floor)
}
