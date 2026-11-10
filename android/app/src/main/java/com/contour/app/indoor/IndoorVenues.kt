package com.contour.app.indoor

import org.json.JSONArray
import org.json.JSONObject
import kotlin.math.asin
import kotlin.math.cos
import kotlin.math.sin
import kotlin.math.sqrt

/**
 * Runtime IndoorAtlas venue configuration from `GET /api/indoor/venues` (backend
 * schemas/indoorVenue.ts). The IndoorAtlas SDK detects the venue itself; these records say which
 * detected venues the app supports, their floor plans, POIs (room 221) and exits. Pure logic so it
 * can be unit-tested.
 */
data class LocalizedName(val en: String, val ja: String)

data class IndoorVenueFloor(val floorPlanId: String, val floorLevel: Int, val name: String)

/**
 * [source] is `verified`, `event-map`, `estimate` or `indooratlas` (a POI the venue owner marked in
 * IndoorAtlas whose name looks like an exit); only `verified` exits were checked on site.
 */
data class IndoorVenueExit(
    val id: String, val name: LocalizedName, val floorLevel: Int,
    val latitude: Double, val longitude: Double, val kind: String, val source: String,
)

data class IndoorVenuePoi(
    val id: String, val name: LocalizedName, val floorLevel: Int,
    /** CMS POI ID; null means the SDK POI is matched by name. */
    val indoorAtlasPoiId: String?,
)

data class IndoorVenueConfig(
    val id: String,
    val name: LocalizedName,
    val indoorAtlasVenueId: String,
    val floors: List<IndoorVenueFloor>,
    val latitude: Double,
    val longitude: Double,
    val radiusMeters: Double,
    val exits: List<IndoorVenueExit>,
    val pois: List<IndoorVenuePoi>,
    /** Whether the IndoorAtlas venue has a wayfinding graph; null when the server does not say. */
    val hasWayfinding: Boolean? = null,
    /** 1-based position in the server list (synced IndoorAtlas venues first); shown as "01". */
    val rank: Int? = null,
    /** True for the server's first venue. */
    val primary: Boolean = false,
    /** `indooratlas` when the venue is mirrored from the IndoorAtlas account. */
    val syncedFrom: String? = null,
) {
    /** Coarse building gate, in addition to the SDK-reported venue ID. */
    fun contains(lat: Double, lng: Double): Boolean {
        if (!lat.isFinite() || !lng.isFinite() || lat !in -90.0..90.0 || lng !in -180.0..180.0) return false
        val a1 = Math.toRadians(lat)
        val a2 = Math.toRadians(latitude)
        val dLat = a1 - a2
        val dLon = Math.toRadians(lng - longitude)
        val h = sin(dLat / 2) * sin(dLat / 2) + cos(a1) * cos(a2) * sin(dLon / 2) * sin(dLon / 2)
        return 6_371_000.0 * 2 * asin(sqrt(h.coerceIn(0.0, 1.0))) <= radiusMeters
    }

    /** Configured floor level of a floor plan, or null when the plan is not listed. */
    fun floorLevelOf(floorPlanId: String?): Int? = floors.firstOrNull { it.floorPlanId == floorPlanId }?.floorLevel

    /** The room 221 POI: id `room-221`, else a POI named 221 / Room 221. */
    fun room221(): IndoorVenuePoi? =
        pois.firstOrNull { it.id == "room-221" } ?: pois.singleOrNull { ROOM_221.matches(it.name.en.trim()) }

    companion object {
        val ROOM_221 = Regex("(?i)(room\\s*)?221")
    }
}

/** The venues the app currently supports. [origin] says where the list came from. */
data class IndoorVenueCatalog(val venues: List<IndoorVenueConfig>, val origin: Origin) {
    enum class Origin { SERVER, CACHE, BUILD_DEFAULT, NONE }

    /** The supported venue the SDK detected, or null (treated as "not mapped"). */
    fun venueFor(indoorAtlasVenueId: String?): IndoorVenueConfig? =
        indoorAtlasVenueId?.takeIf { it.isNotBlank() }?.let { id -> venues.firstOrNull { it.indoorAtlasVenueId.equals(id, ignoreCase = true) } }

    /** Venues whose building gate contains the point. */
    fun containing(lat: Double, lng: Double): List<IndoorVenueConfig> = venues.filter { it.contains(lat, lng) }

    /** The server's primary ("01") venue, else the venue holding the room 221 POI, else the first venue. */
    fun primary(): IndoorVenueConfig? =
        venues.firstOrNull { it.primary } ?: venues.firstOrNull { it.room221() != null } ?: venues.firstOrNull()

    /** Public JSON for the WebView (`ContourBridge.indoorVenues()`). */
    fun toJson(): JSONObject = JSONObject()
        .put("origin", origin.name.lowercase())
        .put("venues", JSONArray().apply {
            venues.forEach { venue ->
                put(JSONObject().put("id", venue.id).put("name", name(venue.name))
                    .put("rank", venue.rank ?: JSONObject.NULL).put("primary", venue.primary)
                    .put("syncedFrom", venue.syncedFrom ?: JSONObject.NULL)
                    .put("indoorAtlas", JSONObject().put("venueId", venue.indoorAtlasVenueId)
                        .put("hasWayfinding", venue.hasWayfinding ?: JSONObject.NULL).put("floors", JSONArray().apply {
                        venue.floors.forEach { put(JSONObject().put("floorPlanId", it.floorPlanId).put("floorLevel", it.floorLevel).put("name", it.name)) }
                    }))
                    .put("location", JSONObject().put("lat", venue.latitude).put("lng", venue.longitude).put("radiusM", venue.radiusMeters))
                    .put("exits", JSONArray().apply {
                        venue.exits.forEach { put(JSONObject().put("id", it.id).put("name", name(it.name)).put("floorLevel", it.floorLevel)
                            .put("lat", it.latitude).put("lng", it.longitude).put("kind", it.kind).put("source", it.source)) }
                    })
                    .put("pois", JSONArray().apply {
                        venue.pois.forEach { put(JSONObject().put("id", it.id).put("name", name(it.name)).put("floorLevel", it.floorLevel)
                            .put("indoorAtlasPoiId", it.indoorAtlasPoiId ?: JSONObject.NULL)) }
                    }))
            }
        })

    companion object {
        private val UUID = Regex("[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}")
        private val SLUG = Regex("[a-z0-9][a-z0-9-]{0,63}")
        private val EXIT_KINDS = setOf("exit", "entrance", "stairs")
        private val EXIT_SOURCES = setOf("verified", "event-map", "estimate", "indooratlas")
        private const val MAX_VENUES = 200

        val EMPTY = IndoorVenueCatalog(emptyList(), Origin.NONE)

        private fun name(value: LocalizedName) = JSONObject().put("en", value.en).put("ja", value.ja)

        /**
         * Parse a `GET /api/indoor/venues` response. Returns null when the document itself is unusable
         * (keep the previous list); individual invalid venues, floors, exits or POIs are skipped.
         */
        fun parse(text: String, origin: Origin): IndoorVenueCatalog? {
            val root = try { JSONObject(text) } catch (_: Exception) { return null }
            val rows = root.optJSONArray("venues") ?: return null
            val venues = (0 until minOf(rows.length(), MAX_VENUES)).mapNotNull { index -> rows.optJSONObject(index)?.let(::parseVenue) }
            return IndoorVenueCatalog(venues.distinctBy { it.indoorAtlasVenueId.lowercase() }, origin)
        }

        private fun parseName(obj: JSONObject?): LocalizedName? {
            val en = obj?.optString("en").orEmpty().trim()
            val ja = obj?.optString("ja").orEmpty().trim()
            return if (en.isEmpty() || ja.isEmpty() || en.length > 120 || ja.length > 120) null else LocalizedName(en, ja)
        }

        private fun JSONObject.finite(key: String): Double? =
            if (has(key) && !isNull(key)) optDouble(key).takeIf { it.isFinite() } else null

        private fun JSONObject.intOrNull(key: String, range: IntRange = -5..60): Int? {
            val value = finite(key) ?: return null
            return value.toInt().takeIf { it.toDouble() == value && it in range }
        }

        private fun validPoint(lat: Double?, lng: Double?) =
            lat != null && lng != null && lat in -90.0..90.0 && lng in -180.0..180.0 && !(lat == 0.0 && lng == 0.0)

        private fun parseVenue(obj: JSONObject): IndoorVenueConfig? {
            val id = obj.optString("id").takeIf { SLUG.matches(it) } ?: return null
            val name = parseName(obj.optJSONObject("name")) ?: return null
            val atlas = obj.optJSONObject("indoorAtlas") ?: return null
            val venueId = atlas.optString("venueId").trim().takeIf { UUID.matches(it) } ?: return null
            val location = obj.optJSONObject("location") ?: return null
            val lat = location.finite("lat")
            val lng = location.finite("lng")
            val radius = location.finite("radiusM")
            if (!validPoint(lat, lng) || radius == null || radius <= 0 || radius > 2000) return null
            val floors = atlas.optJSONArray("floors").objects().mapNotNull { floor ->
                val plan = floor.optString("floorPlanId").trim().takeIf { UUID.matches(it) } ?: return@mapNotNull null
                val level = floor.intOrNull("floorLevel") ?: return@mapNotNull null
                IndoorVenueFloor(plan, level, floor.optString("name").trim().ifEmpty { "${level}F" }.take(40))
            }.distinctBy { it.floorPlanId }
            val exits = obj.optJSONArray("exits").objects().mapNotNull { exit ->
                val exitId = exit.optString("id").takeIf { SLUG.matches(it) } ?: return@mapNotNull null
                val exitName = parseName(exit.optJSONObject("name")) ?: return@mapNotNull null
                val level = exit.intOrNull("floorLevel") ?: return@mapNotNull null
                val exitLat = exit.finite("lat")
                val exitLng = exit.finite("lng")
                val kind = exit.optString("kind").takeIf { it in EXIT_KINDS } ?: return@mapNotNull null
                // Unknown provenance is dropped rather than shown as a usable route.
                val source = exit.optString("source").takeIf { it in EXIT_SOURCES } ?: return@mapNotNull null
                if (!validPoint(exitLat, exitLng)) return@mapNotNull null
                IndoorVenueExit(exitId, exitName, level, exitLat!!, exitLng!!, kind, source)
            }
            val pois = obj.optJSONArray("pois").objects().mapNotNull { poi ->
                val poiId = poi.optString("id").takeIf { SLUG.matches(it) } ?: return@mapNotNull null
                val poiName = parseName(poi.optJSONObject("name")) ?: return@mapNotNull null
                val level = poi.intOrNull("floorLevel") ?: return@mapNotNull null
                val atlasPoi = if (poi.has("indoorAtlasPoiId") && !poi.isNull("indoorAtlasPoiId"))
                    poi.optString("indoorAtlasPoiId").trim().takeIf { UUID.matches(it) } ?: return@mapNotNull null
                else null
                IndoorVenuePoi(poiId, poiName, level, atlasPoi)
            }
            val hasWayfinding = atlas.opt("hasWayfinding") as? Boolean
            val rank = obj.intOrNull("rank", 1..MAX_VENUES)
            val syncedFrom = obj.optString("syncedFrom").takeIf { it == "indooratlas" }
            return IndoorVenueConfig(id, name, venueId, floors, lat!!, lng!!, radius, exits, pois,
                hasWayfinding = hasWayfinding, rank = rank, primary = obj.opt("primary") == true, syncedFrom = syncedFrom)
        }

        private fun JSONArray?.objects(): List<JSONObject> =
            if (this == null) emptyList() else (0 until minOf(length(), 500)).mapNotNull { optJSONObject(it) }

        /**
         * Build-time fallback (BuildConfig INDOORATLAS_VENUE_ID / INDOORATLAS_ROOM221_POI_ID), used only when
         * neither the server nor the on-device cache has a list. Engineering Building II's documented gate.
         */
        fun buildTimeDefault(venueId: String, room221PoiId: String): IndoorVenueCatalog {
            val id = venueId.trim().takeIf { UUID.matches(it) } ?: return EMPTY
            val poi = room221PoiId.trim().takeIf { UUID.matches(it) }
            return IndoorVenueCatalog(listOf(IndoorVenueConfig(
                id = "nu-engineering-2",
                name = LocalizedName("Engineering Building II", "工学部2号館"),
                indoorAtlasVenueId = id,
                floors = emptyList(),
                latitude = 35.15561139, longitude = 136.96476536, radiusMeters = 100.0,
                exits = emptyList(),
                pois = listOf(IndoorVenuePoi("room-221", LocalizedName("Room 221", "221教室"), 2, poi)),
            )), Origin.BUILD_DEFAULT)
        }
    }
}
