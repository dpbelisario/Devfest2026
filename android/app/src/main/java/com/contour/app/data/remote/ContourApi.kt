package com.contour.app.data.remote

import com.contour.app.BuildConfig
import com.contour.app.data.model.Destination
import com.contour.app.data.model.NavigationRoute
import com.contour.app.data.model.Waypoint
import java.io.IOException
import java.net.HttpURLConnection
import java.net.URI
import java.net.URLEncoder
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import org.json.JSONObject

class ApiException(val statusCode: Int) : IOException("API request failed (HTTP $statusCode)")

class ContourApi(private val baseUrl: String = BuildConfig.API_BASE_URL) {
    private suspend fun get(path: String): JSONObject = withContext(Dispatchers.IO) {
        val connection = URI(baseUrl.trimEnd('/') + "/" + path).toURL().openConnection() as HttpURLConnection
        try {
            connection.connectTimeout = 10000
            connection.readTimeout = 10000
            if (connection.responseCode !in 200..299) throw ApiException(connection.responseCode)
            connection.inputStream.bufferedReader().use { JSONObject(it.readText()) }
        } finally { connection.disconnect() }
    }

    suspend fun destinations(latitude: Double, longitude: Double): List<Destination> {
        val rows = get("destinations?lat=$latitude&lng=$longitude&disaster=earthquake").getJSONArray("destinations")
        if (rows.length() > 500) throw IOException("Invalid destinations response")
        return List(rows.length()) { index ->
            val row = rows.getJSONObject(index)
            validatePoint(row)
            val kind = row.getString("kind")
            if (kind !in setOf("emergencySite", "shelter") || row.getString("openingStatus") != "unknown" ||
                row.getString("id").isBlank() || row.getString("name").isBlank()) {
                throw IOException("Invalid destination response")
            }
            val disasters = row.getJSONArray("disasters")
            if ((0 until disasters.length()).none { disasters.getString(it) == "earthquake" }) {
                throw IOException("Destination does not support the requested disaster")
            }
            Destination(row.getString("id"), row.getString("name"), row.getDouble("latitude"), row.getDouble("longitude"), row.getBoolean("isDemo"), row.getString("openingStatus"), kind)
        }
    }

    suspend fun directions(id: String, latitude: Double, longitude: Double): NavigationRoute {
        val row = get("directions?originLat=$latitude&originLng=$longitude&destinationId=${URLEncoder.encode(id, "UTF-8")}")
        val points = row.getJSONArray("waypoints")
        if (row.getString("destinationId") != id || points.length() !in 2..256) {
            throw IOException("Invalid route response")
        }
        val originRadius = row.getDouble("maxOriginDistanceMeters")
        if (!originRadius.isFinite() || originRadius <= 0) throw IOException("Invalid route origin area")
        return NavigationRoute(row.getString("id"), row.getString("destinationId"), row.getBoolean("isDemo"), List(points.length()) { index ->
            val point = points.getJSONObject(index)
            validatePoint(point)
            if (point.getString("instruction").isBlank()) throw IOException("Invalid waypoint instruction")
            Waypoint(point.getDouble("latitude"), point.getDouble("longitude"), point.getString("instruction"))
        }, originRadius)
    }

    private fun validatePoint(point: JSONObject) {
        val latitude = point.getDouble("latitude")
        val longitude = point.getDouble("longitude")
        if (!latitude.isFinite() || !longitude.isFinite() || latitude !in -90.0..90.0 || longitude !in -180.0..180.0) {
            throw IOException("Invalid coordinates")
        }
    }
}
