package com.contour.app.indoor

import android.content.Context
import android.hardware.Sensor
import android.hardware.SensorEvent
import android.hardware.SensorEventListener
import android.hardware.SensorManager
import android.os.SystemClock

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
    private var wanted = false
    private var listening = false
    private var lastSent = 0L

    /** Starts the readings; returns false when the phone has no barometer. */
    @Synchronized
    fun start(): Boolean {
        wanted = true
        return listen()
    }

    @Synchronized
    fun stop() {
        wanted = false
        unlisten()
    }

    /** App went to the background: stop reading, but remember to continue in [resume]. */
    @Synchronized
    fun pause() = unlisten()

    @Synchronized
    fun resume() {
        if (wanted) listen()
    }

    private fun listen(): Boolean {
        val sensor = barometer ?: return false
        if (!listening) {
            sensors.registerListener(this, sensor, SensorManager.SENSOR_DELAY_UI)
            listening = true
        }
        return true
    }

    private fun unlisten() {
        if (listening) {
            sensors.unregisterListener(this)
            listening = false
        }
    }

    override fun onSensorChanged(event: SensorEvent) {
        val now = SystemClock.elapsedRealtime()
        if (now - lastSent < INTERVAL_MS) return
        lastSent = now
        onPressure(event.values[0])
    }

    override fun onAccuracyChanged(sensor: Sensor?, accuracy: Int) = Unit

    private companion object {
        const val INTERVAL_MS = 250L
    }
}
