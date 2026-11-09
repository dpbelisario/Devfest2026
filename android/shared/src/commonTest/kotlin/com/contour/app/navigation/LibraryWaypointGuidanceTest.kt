package com.contour.app.navigation

import kotlin.math.*
import kotlin.test.*

class LibraryWaypointGuidanceTest {
    @Test fun absoluteFixUsesActualPositionAndRejectsUnknownSeatOrInvalidTransform() {
        val guide=LibraryWaypointGuidance()
        val x=780.0/1178;val y=400.0/817
        assertTrue(guide.locate(x,y,10.0,20.0,0.0))
        assertEquals("South-east aisle · before gates",guide.targetLabel)
        val position=LibraryExitGeometry.planOffset(x,y,LibraryExitGeometry.defaultWidth,LibraryExitGeometry.defaultAspect,LibraryExitGeometry.defaultAngle)
        val target=LibraryExitGeometry.planOffset(x,480.0/817,LibraryExitGeometry.defaultWidth,LibraryExitGeometry.defaultAspect,LibraryExitGeometry.defaultAngle)
        assertEquals(10+target.east-position.east,guide.targetX,1e-6)
        assertEquals(20-target.north+position.north,guide.targetZ,1e-6)
        assertFalse(guide.locate(0.1,0.1,0.0,0.0,0.0))
        assertFalse(guide.locate(x,y,0.0,0.0,Double.NaN))
        assertFalse(guide.locate(-0.1,y,0.0,0.0,0.0))
        assertTrue(guide.locate(970.0/1178,522.0/817,0.0,0.0,0.0))
        assertEquals("Entrance Hall doors",guide.targetLabel)
        assertTrue(guide.locate(760.0/1178,565.0/817,0.0,0.0,0.0))
        assertEquals("lib-2-service",guide.startId)
    }

    @Test fun assumedStartTargetsAisleBeforeExitAndAdvancesWithoutCheckpointButtons() {
        val guide=LibraryWaypointGuidance()
        assertEquals(0.0,guide.update(0.0,0.0,0.0),1e-6)
        assertEquals("South-east aisle · before gates",guide.targetLabel)
        assertTrue(hypot(guide.targetX,guide.targetZ)>8)
        repeat(5) {guide.update(0.0,0.0,0.0)}
        assertEquals(1,guide.targetIndex)
        val turn=guide.update(guide.targetX,guide.targetZ,0.0)
        assertEquals("Exit gate",guide.targetLabel)
        assertTrue(turn < -PI/6)
        guide.update(guide.targetX,guide.targetZ,0.0)
        assertEquals("Entrance Hall",guide.targetLabel)
        guide.update(guide.targetX,guide.targetZ,0.0)
        assertEquals("Entrance Hall doors",guide.targetLabel)
        assertTrue(guide.update(guide.targetX,guide.targetZ,0.0).isNaN())
        assertTrue(guide.complete)
    }

    @Test fun correctingHeadingChangesRouteRotationWithoutLosingProgress() {
        val guide=LibraryWaypointGuidance()
        guide.update(10.0,20.0,0.0)
        assertTrue(guide.align(10.0,20.0,0.0,PI/2))
        assertEquals(PI/2,guide.update(10.0,20.0,0.0),1e-6)
        assertEquals(0.0,guide.update(10.0,20.0,PI/2),1e-6)
        assertEquals(1,guide.targetIndex)
        guide.update(guide.targetX,guide.targetZ,PI/2)
        assertEquals(2,guide.targetIndex)
        assertTrue(guide.align(guide.targetX-2,guide.targetZ+3,0.0,-PI/2))
        assertEquals(2,guide.targetIndex)
    }

    @Test fun obstacleDetourDoesNotAdvanceJustBecauseTargetDistanceIsClose() {
        val guide=LibraryWaypointGuidance()
        guide.update(0.0,0.0,0.0)
        val targetX=guide.targetX;val targetZ=guide.targetZ
        guide.update(targetX+1.0,targetZ,0.0)
        assertEquals(1,guide.targetIndex)
        guide.update(targetX,targetZ,0.0)
        assertEquals(2,guide.targetIndex)
    }

    @Test fun startsResetAndUnknownDataCannotAdvance() {
        val guide=LibraryWaypointGuidance()
        assertFalse(guide.selectStart("lib-3-ne"))
        assertEquals("lib-2-ne",guide.startId)
        assertTrue(guide.update(Double.NaN,0.0,0.0).isNaN())
        assertEquals(1,guide.targetIndex)
        assertFalse(guide.configure(Double.NaN,0.7,0.0))
        assertTrue(guide.selectStart("lib-2-hall"))
        assertEquals(0.0,guide.update(0.0,0.0,0.0),1e-6)
        assertEquals("Entrance Hall doors",guide.targetLabel)
        guide.reset()
        assertTrue(guide.targetX.isNaN())
        assertEquals(1,guide.targetIndex)
    }

    @Test fun routeEndsAtExactExistingDoorOnSupportedImage() {
        val guide=LibraryWaypointGuidance()
        guide.selectStart("lib-2-hall")
        val hall=guide.starts.single {it.id=="lib-2-hall"}
        val start=LibraryExitGeometry.planOffset(hall.imageX/1178,hall.imageY/817,
            LibraryExitGeometry.defaultWidth,LibraryExitGeometry.defaultAspect,LibraryExitGeometry.defaultAngle)
        val door=LibraryExitGeometry.planOffset(1034.0/1178,528.0/817,
            LibraryExitGeometry.defaultWidth,LibraryExitGeometry.defaultAspect,LibraryExitGeometry.defaultAngle)
        guide.update(0.0,0.0,0.0,0.0)
        assertEquals(door.east-start.east,guide.targetX,1e-6)
        assertEquals(start.north-door.north,guide.targetZ,1e-6)
    }
}
