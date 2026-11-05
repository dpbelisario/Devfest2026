package com.contour.app.data.model

data class Waypoint(val latitude: Double, val longitude: Double, val instruction: String)
data class NavigationRoute(
    val id: String,
    val destinationId: String,
    val isDemo: Boolean,
    val waypoints: List<Waypoint>,
    val maxOriginDistanceMeters: Double = 40.0,
)
