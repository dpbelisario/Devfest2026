package com.contour.app.data.model

data class Destination(
    val id: String,
    val name: String,
    val latitude: Double,
    val longitude: Double,
    val isDemo: Boolean,
    val openingStatus: String,
    val kind: String = "unknown",
)
