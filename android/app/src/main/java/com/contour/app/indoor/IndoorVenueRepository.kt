package com.contour.app.indoor

import android.content.Context
import com.contour.app.BuildConfig
import java.io.IOException
import java.net.HttpURLConnection
import java.net.URI
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext

/**
 * Supported IndoorAtlas venues, changeable on the server without an APK rebuild
 * (docs/indoor-venues.md). Order of preference: the last server response, the copy cached on the
 * device from an earlier run, then the build-time default venue/POI. A failed fetch keeps whatever
 * is current.
 */
class IndoorVenueRepository(context: Context) {
    private val preferences = context.applicationContext.getSharedPreferences("contour", Context.MODE_PRIVATE)

    @Volatile var current: IndoorVenueCatalog =
        IndoorVenueCatalog.buildTimeDefault(BuildConfig.INDOORATLAS_VENUE_ID, BuildConfig.INDOORATLAS_ROOM221_POI_ID)
        private set
    @Volatile private var cacheLoaded = false

    /**
     * Load the device cache (once), then fetch the venue list and cache it. Runs its I/O on
     * Dispatchers.IO and is cancellable. Returns true when the server answered with a usable list;
     * network/parse failures keep the current list.
     */
    suspend fun refresh(): Boolean {
        if (!cacheLoaded) {
            val cached = withContext(Dispatchers.IO) {
                try {
                    preferences.getString(CACHE_KEY, null)?.let { IndoorVenueCatalog.parse(it, IndoorVenueCatalog.Origin.CACHE) }
                } catch (_: Exception) { null }
            }
            cacheLoaded = true
            if (cached != null && current.origin != IndoorVenueCatalog.Origin.SERVER) current = cached
        }
        val url = endpoint() ?: return false
        val text = try {
            withContext(Dispatchers.IO) {
                val connection = URI(url).toURL().openConnection() as HttpURLConnection
                try {
                    connection.connectTimeout = 10_000
                    connection.readTimeout = 10_000
                    connection.setRequestProperty("Accept", "application/json")
                    if (connection.responseCode !in 200..299) throw IOException("HTTP ${connection.responseCode}")
                    connection.inputStream.bufferedReader().use { reader ->
                        val buffer = CharArray(MAX_BYTES + 1)
                        var length = 0
                        while (length <= MAX_BYTES) {
                            val read = reader.read(buffer, length, buffer.size - length)
                            if (read < 0) break
                            length += read
                        }
                        if (length > MAX_BYTES) throw IOException("Venue list too large")
                        String(buffer, 0, length)
                    }
                } finally { connection.disconnect() }
            }
        } catch (cancelled: kotlinx.coroutines.CancellationException) { throw cancelled
        } catch (_: Exception) { return false }
        val parsed = IndoorVenueCatalog.parse(text, IndoorVenueCatalog.Origin.SERVER) ?: return false
        current = parsed
        preferences.edit().putString(CACHE_KEY, text).apply()
        return true
    }

    companion object {
        private const val CACHE_KEY = "indoorVenues"
        /** Synced venues carry floor plan placements and geofence areas; 1 MiB leaves room. */
        private const val MAX_BYTES = 1024 * 1024

        /**
         * `${API_BASE_URL}api/indoor/venues`; when the API URL is the unset placeholder, the origin
         * of the hosted UI (served by the same backend at /app/).
         */
        fun endpoint(apiBaseUrl: String = BuildConfig.API_BASE_URL, uiUrl: String = BuildConfig.UI_URL): String? {
            val base = apiBaseUrl.takeIf { it.isNotBlank() && !it.contains("example.invalid") }
                ?: uiUrl.takeIf { it.startsWith("https://") }?.let { ui ->
                    val uri = URI(ui)
                    "https://${uri.rawAuthority}/"
                }
                ?: return null
            return base.trimEnd('/') + "/api/indoor/venues"
        }
    }
}
