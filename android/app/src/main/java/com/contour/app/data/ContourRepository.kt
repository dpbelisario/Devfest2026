package com.contour.app.data

import com.contour.app.data.remote.ContourApi

/** Fetch public demo data. Offline cache integration is a follow-up milestone. */
class ContourRepository(private val api: ContourApi = ContourApi()) {
    suspend fun destinations() = api.destinations(DEMO_LATITUDE, DEMO_LONGITUDE)
    suspend fun directions(id: String) = api.directions(id, DEMO_LATITUDE, DEMO_LONGITUDE)
    suspend fun destinations(latitude: Double, longitude: Double) = api.destinations(latitude, longitude)
    suspend fun directions(id: String, latitude: Double, longitude: Double) =
        api.directions(id, latitude, longitude)
    companion object {
        const val DEMO_LATITUDE = 35.6800
        const val DEMO_LONGITUDE = 139.7670
    }
}
