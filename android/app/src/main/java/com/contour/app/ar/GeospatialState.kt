package com.contour.app.ar

/** Immutable frame summary; no ARCore resources escape into the ViewModel. */
data class DevicePose(
    val latitude: Double,
    val longitude: Double,
    val horizontalAccuracy: Double,
    val verticalAccuracy: Double,
    val yawAccuracy: Double,
)

data class GeospatialState(
    val message: String = "Starting AR…",
    val localized: Boolean = false,
    val pose: DevicePose? = null,
    val waypointIndex: Int = 0,
    val routeComplete: Boolean = false,
)
