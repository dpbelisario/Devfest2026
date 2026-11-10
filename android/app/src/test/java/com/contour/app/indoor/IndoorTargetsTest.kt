package com.contour.app.indoor

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class IndoorTargetsTest {
    // SYNTHETIC venue (not a real building): a 2-floor hall around 35.1, 136.9, synced from IndoorAtlas.
    private val response = """
        {"venues":[
          {"id":"ia-11111111-2222-4333-8444-555555555555","name":{"en":"Synthetic Hall","ja":"合成ホール"},
           "rank":1,"primary":true,"syncedFrom":"indooratlas",
           "indoorAtlas":{"venueId":"11111111-2222-4333-8444-555555555555","hasWayfinding":true,"floors":[
             {"floorPlanId":"11111111-2222-4333-8444-666666666661","floorLevel":1,"name":"1F"},
             {"floorPlanId":"11111111-2222-4333-8444-666666666662","floorLevel":2,"name":"2F"}]},
           "location":{"lat":35.1,"lng":136.9,"radiusM":80},
           "exits":[
             {"id":"ia-a1","name":{"en":"West exit","ja":"西出口"},"floorLevel":1,"lat":35.1,"lng":136.8995,"kind":"exit","source":"indooratlas"},
             {"id":"ia-a2","name":{"en":"East exit","ja":"東出口"},"floorLevel":1,"lat":35.1,"lng":136.9002,"kind":"exit","source":"indooratlas"},
             {"id":"ia-a3","name":{"en":"North stairs","ja":"北階段"},"floorLevel":2,"lat":35.1004,"lng":136.9,"kind":"stairs","source":"indooratlas"}],
           "pois":[],"updatedAt":"2026-11-09T00:00:00Z","origin":"firestore"},
          {"id":"graphless","name":{"en":"Graphless","ja":"グラフなし"},"rank":2,"primary":false,
           "indoorAtlas":{"venueId":"11111111-2222-4333-8444-777777777777","hasWayfinding":false,"floors":[]},
           "location":{"lat":35.2,"lng":136.9,"radiusM":80},
           "exits":[{"id":"door","name":{"en":"Door","ja":"扉"},"floorLevel":1,"lat":35.2001,"lng":136.9,"kind":"exit","source":"event-map"}],
           "pois":[],"updatedAt":"2026-11-09T00:00:00Z","origin":"firestore"}
        ],"source":"firestore","checkedAt":"2026-11-09T00:00:00.000Z"}
    """.trimIndent()
    private val catalog = IndoorVenueCatalog.parse(response, IndoorVenueCatalog.Origin.SERVER)!!
    private val hall = catalog.venues[0]

    @Test fun parsesSyncedVenueFieldsAndIndoorAtlasExits() {
        assertEquals(1, hall.rank)
        assertTrue(hall.primary)
        assertEquals("indooratlas", hall.syncedFrom)
        assertEquals(true, hall.hasWayfinding)
        assertEquals(false, catalog.venues[1].hasWayfinding)
        // `indooratlas` provenance is kept as-is, never upgraded to verified.
        assertEquals(listOf("indooratlas", "indooratlas", "indooratlas"), hall.exits.map { it.source })
        assertEquals(hall, catalog.primary())
        val reparsed = IndoorVenueCatalog.parse(catalog.toJson().toString(), IndoorVenueCatalog.Origin.CACHE)!!
        assertEquals(catalog.venues, reparsed.venues)
    }

    @Test fun nearestExitPrefersTheCurrentFloor() {
        // On 1F near the east side: the east exit, although the 2F stairs are similar distance.
        assertEquals("ia-a2", IndoorTargets.nearestExit(hall.exits, 35.1, 136.9001, 1)?.id)
        assertEquals("ia-a1", IndoorTargets.nearestExit(hall.exits, 35.1, 136.8996, 1)?.id)
        // On 2F the only same-floor exit is the stairs, even if a 1F exit is closer horizontally.
        assertEquals("ia-a3", IndoorTargets.nearestExit(hall.exits, 35.1, 136.8996, 2)?.id)
        // On 3F (no exits there): the nearest other floor (2F) wins over closer exits on 1F.
        assertEquals("ia-a3", IndoorTargets.nearestExit(hall.exits, 35.1, 136.8996, 3)?.id)
        // Unknown floor: plain distance.
        assertEquals("ia-a1", IndoorTargets.nearestExit(hall.exits, 35.1, 136.8996, null)?.id)
        assertNull(IndoorTargets.nearestExit(emptyList(), 35.1, 136.9, 1))
        assertNull(IndoorTargets.nearestExit(hall.exits, Double.NaN, 136.9, 1))
    }

    @Test fun mapsExitsToRouteOrDirectDestinations() {
        val exit = hall.exits[2]
        val destination = IndoorTargets.destination(hall, exit)
        assertEquals(ExitDestination.Mode.ROUTE, destination.mode)
        assertEquals(35.1004, destination.latitude, 0.0)
        assertEquals(136.9, destination.longitude, 0.0)
        assertEquals(2, destination.floor)
        val graphless = catalog.venues[1]
        assertEquals(ExitDestination.Mode.DIRECT, IndoorTargets.destination(graphless, graphless.exits.single()).mode)
        // Unknown graph presence (manual documents) tries the SDK route first.
        assertEquals(ExitDestination.Mode.ROUTE, IndoorTargets.destination(hall.copy(hasWayfinding = null), exit).mode)
    }

    @Test fun haversineDistanceAndBearing() {
        // 0.001° of latitude ≈ 111 m due north.
        assertEquals(111.2, IndoorTargets.distanceMeters(35.1, 136.9, 35.101, 136.9), 0.5)
        assertEquals(0.0, IndoorTargets.bearingDegrees(35.1, 136.9, 35.101, 136.9), 0.01)
        assertEquals(90.0, IndoorTargets.bearingDegrees(35.1, 136.9, 35.1, 136.901), 0.01)
        assertEquals(270.0, IndoorTargets.bearingDegrees(35.1, 136.9, 35.1, 136.899), 0.01)
        assertTrue(IndoorTargets.distanceMeters(91.0, 0.0, 0.0, 0.0).isNaN())
    }

    @Test fun commandsMapToTargets() {
        assertEquals(IndoorTarget.ROOM_221, IndoorTarget.fromCommand("start221"))
        assertEquals(IndoorTarget.NEAREST_EXIT, IndoorTarget.fromCommand("startNearestExit"))
        assertNull(IndoorTarget.fromCommand("stop"))
    }
}
