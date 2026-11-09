package com.contour.app.indoor

import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class IndoorVenuesTest {
    private val engineeringVenueId = "0d3ece20-da98-11f1-95cb-e11cd22c6739"

    // Engineering II as served from the backend seed, plus a SYNTHETIC venue (not a real building).
    private val response = """
        {"venues":[
          {"id":"nu-engineering-2","name":{"en":"Engineering Building II","ja":"工学部2号館"},
           "indoorAtlas":{"venueId":"$engineeringVenueId","floors":[
             {"floorPlanId":"3f9a5929-0f70-4b45-922f-8f95b53b9be8","floorLevel":2,"name":"2F"},
             {"floorPlanId":"64cc64e0-e2bb-4f48-ac6e-4dd8508c5353","floorLevel":3,"name":"3F"}]},
           "location":{"lat":35.15561139,"lng":136.96476536,"radiusM":100},
           "exits":[],
           "pois":[{"id":"room-221","name":{"en":"Room 221","ja":"221教室"},"floorLevel":2,
                    "indoorAtlasPoiId":"e8679fc0-da9a-11f1-b91e-6591398611dd","lat":35.1556,"lng":136.9647}],
           "updatedAt":"2026-11-07T00:00:00+09:00","origin":"seed"},
          {"id":"synthetic-hall","name":{"en":"Synthetic Hall","ja":"合成ホール"},
           "indoorAtlas":{"venueId":"11111111-2222-4333-8444-555555555555","floors":[]},
           "location":{"lat":35.1,"lng":136.9,"radiusM":80},
           "exits":[
             {"id":"west-door","name":{"en":"West door","ja":"西口"},"floorLevel":1,"lat":35.1001,"lng":136.8999,"kind":"exit","source":"event-map"},
             {"id":"bad-source","name":{"en":"X","ja":"X"},"floorLevel":1,"lat":35.1,"lng":136.9,"kind":"exit","source":"official"}],
           "pois":[{"id":"booth-a","name":{"en":"Booth A","ja":"ブースA"},"floorLevel":1}],
           "updatedAt":"2026-11-09T00:00:00Z","origin":"firestore"},
          {"id":"Broken Venue","name":{"en":"x","ja":"x"}},
          {"id":"no-location","name":{"en":"x","ja":"x"},"indoorAtlas":{"venueId":"11111111-2222-4333-8444-777777777777","floors":[]},
           "location":{"lat":0,"lng":0,"radiusM":50},"exits":[],"pois":[]}
        ],"source":"firestore","checkedAt":"2026-11-09T00:00:00.000Z"}
    """.trimIndent()

    private val catalog = IndoorVenueCatalog.parse(response, IndoorVenueCatalog.Origin.SERVER)!!

    @Test fun parsesValidVenuesAndSkipsInvalidOnes() {
        assertEquals(listOf("nu-engineering-2", "synthetic-hall"), catalog.venues.map { it.id })
        val hall = catalog.venues[1]
        // Exits keep their provenance; unknown provenance is dropped, never upgraded.
        assertEquals(listOf("west-door"), hall.exits.map { it.id })
        assertEquals("event-map", hall.exits.single().source)
        assertNull(hall.pois.single().indoorAtlasPoiId)
    }

    @Test fun matchesSdkVenueIdsAndTreatsUnknownAsNotMapped() {
        assertEquals("nu-engineering-2", catalog.venueFor(engineeringVenueId)?.id)
        assertEquals("nu-engineering-2", catalog.venueFor(engineeringVenueId.uppercase())?.id)
        assertNull(catalog.venueFor("99999999-2222-4333-8444-555555555555"))
        assertNull(catalog.venueFor(null))
        assertNull(catalog.venueFor(""))
    }

    @Test fun mapsFloorPlansAndRoom221() {
        val engineering = catalog.venueFor(engineeringVenueId)!!
        assertEquals(2, engineering.floorLevelOf("3f9a5929-0f70-4b45-922f-8f95b53b9be8"))
        assertEquals(3, engineering.floorLevelOf("64cc64e0-e2bb-4f48-ac6e-4dd8508c5353"))
        assertNull(engineering.floorLevelOf("unknown"))
        assertEquals("e8679fc0-da9a-11f1-b91e-6591398611dd", engineering.room221()?.indoorAtlasPoiId)
        assertNull(catalog.venues[1].room221())
        assertEquals("nu-engineering-2", catalog.primary()?.id)
    }

    @Test fun locationGateUsesEachVenueRadius() {
        val engineering = catalog.venues[0]
        assertTrue(engineering.contains(35.15561139, 136.96476536))
        assertFalse(engineering.contains(35.1580, 136.9648)) // about 265 m north
        assertFalse(engineering.contains(Double.NaN, 136.96))
        assertEquals(listOf("synthetic-hall"), catalog.containing(35.1001, 136.9).map { it.id })
    }

    @Test fun unusableDocumentsKeepThePreviousList() {
        assertNull(IndoorVenueCatalog.parse("not json", IndoorVenueCatalog.Origin.SERVER))
        assertNull(IndoorVenueCatalog.parse("{\"error\":\"x\"}", IndoorVenueCatalog.Origin.SERVER))
        val empty = IndoorVenueCatalog.parse("{\"venues\":[]}", IndoorVenueCatalog.Origin.SERVER)!!
        assertTrue(empty.venues.isEmpty())
    }

    @Test fun buildTimeDefaultMatchesTheBakedInVenue() {
        val fallback = IndoorVenueCatalog.buildTimeDefault(engineeringVenueId, "e8679fc0-da9a-11f1-b91e-6591398611dd")
        assertEquals(IndoorVenueCatalog.Origin.BUILD_DEFAULT, fallback.origin)
        assertEquals("e8679fc0-da9a-11f1-b91e-6591398611dd", fallback.venueFor(engineeringVenueId)?.room221()?.indoorAtlasPoiId)
        // Without a POI ID the SDK POI is matched by name, as before.
        assertNull(IndoorVenueCatalog.buildTimeDefault(engineeringVenueId, "").venues.single().room221()?.indoorAtlasPoiId)
        assertTrue(IndoorVenueCatalog.buildTimeDefault("", "").venues.isEmpty())
    }

    @Test fun bridgeJsonRoundTrips() {
        val json = catalog.toJson()
        assertEquals("server", json.getString("origin"))
        val reparsed = IndoorVenueCatalog.parse(json.toString(), IndoorVenueCatalog.Origin.CACHE)
        assertNotNull(reparsed)
        assertEquals(catalog.venues, reparsed!!.venues)
        assertEquals("Engineering Building II", JSONObject(json.toString()).getJSONArray("venues").getJSONObject(0).getJSONObject("name").getString("en"))
    }

    @Test fun endpointFollowsTheApiBaseUrlOrTheHostedUi() {
        assertEquals("https://api.test/api/indoor/venues", IndoorVenueRepository.endpoint("https://api.test/", ""))
        assertEquals("https://ui.test/api/indoor/venues", IndoorVenueRepository.endpoint("https://example.invalid/", "https://ui.test/app/"))
        assertNull(IndoorVenueRepository.endpoint("https://example.invalid/", ""))
    }
}
