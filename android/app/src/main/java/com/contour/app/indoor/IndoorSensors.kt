package com.contour.app.indoor

import android.content.Context
import android.hardware.Sensor
import android.hardware.SensorEvent
import android.hardware.SensorEventListener
import android.hardware.SensorManager
import android.os.SystemClock
import android.os.Handler
import android.os.Looper

/**
 * Barometer for the indoor navigation demo. The page turns pressure changes into floor changes
 * (about 0.12 hPa per metre, roughly 0.5 hPa per floor). Steps and heading come from the page's own
 * motion events, so no extra permission is needed.
 *
 * Readings are sent about four times a second while the indoor view is open. The listener is
 * removed while the app is in the background and when the page stops the indoor view.
 */
class IndoorSensors(context: Context, private val onPressure: (Float) -> Unit) : SensorEventListener {
    private val sensors = context.getSystemService(Context.SENSOR_SERVICE) as SensorManager
    private val barometer: Sensor? = sensors.getDefaultSensor(Sensor.TYPE_PRESSURE)
    private val main = Handler(Looper.getMainLooper())
    private var listeningSinceNanos = 0L
    private var wanted = false
    private var listening = false
    private var lastSent = 0L

    /** Starts the readings; returns false when the phone has no barometer. */
    @Synchronized
    fun start(): Boolean {
        check(Looper.myLooper() == Looper.getMainLooper())
        wanted = true
        unlisten() // Every new session gets a fresh timestamp gate for queued sensor callbacks.
        return listen()
    }

    @Synchronized
    fun stop() {
        check(Looper.myLooper() == Looper.getMainLooper())
        wanted = false
        unlisten()
    }

    /** App went to the background: stop reading, but remember to continue in [resume]. */
    @Synchronized
    fun pause() {
        check(Looper.myLooper() == Looper.getMainLooper())
        unlisten()
    }

    @Synchronized
    fun resume() {
        check(Looper.myLooper() == Looper.getMainLooper())
        if (wanted) listen()
    }

    private fun listen(): Boolean {
        val sensor = barometer ?: return false
        if (!listening) {
            listeningSinceNanos = SystemClock.elapsedRealtimeNanos()
            lastSent = 0L
            listening = try {
                sensors.registerListener(this, sensor, SensorManager.SENSOR_DELAY_UI, main)
            } catch (_: RuntimeException) { false }
        }
        return listening
    }

    private fun unlisten() {
        if (listening) {
            sensors.unregisterListener(this)
            listening = false
        }
    }

    override fun onSensorChanged(event: SensorEvent) {
        // Discard queued readings from a previous pause/page/session.
        if (!wanted || !listening || event.sensor.type != Sensor.TYPE_PRESSURE || event.timestamp < listeningSinceNanos) return
        val pressure = event.values.firstOrNull() ?: return
        if (!pressure.isFinite() || pressure !in 300f..1100f) return
        val now = SystemClock.elapsedRealtime()
        if (now - lastSent < INTERVAL_MS) return
        lastSent = now
        onPressure(pressure)
    }

    override fun onAccuracyChanged(sensor: Sensor?, accuracy: Int) = Unit

    private companion object {
        const val INTERVAL_MS = 250L
    }
}
