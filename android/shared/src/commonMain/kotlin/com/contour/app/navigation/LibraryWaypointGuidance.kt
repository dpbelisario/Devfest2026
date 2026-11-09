package com.contour.app.navigation

import kotlin.math.*

data class LibraryWaypoint(val id: String,val label: String,val imageX: Double,val imageY: Double)

/** Image-inferred 2F route with assumed or externally located starts and relative AR motion. */
class LibraryWaypointGuidance {
    // shortcut: image-inferred points on the exact saved plan, replace after walking and surveying these passages.
    private val northeast = LibraryWaypoint("lib-2-ne","North-east aisle · near OPAC",780.0,315.0)
    private val southeast = LibraryWaypoint("lib-2-se","South-east aisle · before gates",780.0,480.0)
    private val service = LibraryWaypoint("lib-2-service","Service Desk · public side",760.0,565.0)
    private val gate = LibraryWaypoint("lib-2-gate","Exit gate",850.0,495.0)
    private val hall = LibraryWaypoint("lib-2-hall","Entrance Hall",945.0,520.0)
    private val door = LibraryWaypoint("lib-2-exit","Entrance Hall doors",1034.0,528.0)
    val starts: List<LibraryWaypoint> get() = listOf(northeast,southeast,service,hall)
    var startId = northeast.id
        private set
    var targetIndex = 1
        private set
    var targetX = Double.NaN
        private set
    var targetZ = Double.NaN
        private set
    val complete: Boolean get() = targetIndex >= route.size
    val targetLabel: String get() = route.getOrNull(targetIndex)?.label ?: "End of demo path"
    val startLabel: String get() = route.first().label
    private var route = listOf(northeast,southeast,gate,hall,door)
    private var width = LibraryExitGeometry.defaultWidth
    private var aspect = LibraryExitGeometry.defaultAspect
    private var angle = LibraryExitGeometry.defaultAngle
    private var anchorCameraX = Double.NaN
    private var anchorCameraZ = Double.NaN
    private var anchorEast = 0.0
    private var anchorNorth = 0.0
    private var rotation = 0.0

    fun selectStart(id: String): Boolean {
        route = when(id) {
            northeast.id -> listOf(northeast,southeast,gate,hall,door)
            southeast.id -> listOf(southeast,gate,hall,door)
            service.id -> listOf(service,southeast,gate,hall,door)
            hall.id -> listOf(hall,door)
            else -> return false
        }
        startId = id
        reset()
        return true
    }

    fun configure(width: Double,aspect: Double,angle: Double): Boolean {
        if(!listOf(width,aspect,angle).all {it.isFinite()} || width !in 1.0..500.0 || aspect !in 0.1..5.0) return false
        this.width=width;this.aspect=aspect;this.angle=angle
        reset()
        return true
    }

    fun reset() {
        targetIndex=1;anchorCameraX=Double.NaN;anchorCameraZ=Double.NaN;targetX=Double.NaN;targetZ=Double.NaN
    }

    private fun point(node: LibraryWaypoint) = LibraryExitGeometry.planOffset(node.imageX/1178,node.imageY/817,width,aspect,angle)

    /** Register a validated absolute fix on the exact floor image, only near an existing route segment. */
    fun locate(imageX: Double,imageY: Double,cameraX: Double,cameraZ: Double,mapRotation: Double): Boolean {
        if(!listOf(imageX,imageY,cameraX,cameraZ,mapRotation).all {it.isFinite()} ||
            imageX !in 0.0..1.0 || imageY !in 0.0..1.0) return false
        val position=LibraryExitGeometry.planOffset(imageX,imageY,width,aspect,angle)
        val paths=listOf(listOf(northeast,southeast,gate,hall,door),listOf(service,southeast,gate,hall,door))
        var nearest=Double.POSITIVE_INFINITY
        var selected: List<LibraryWaypoint>?=null
        var index=0
        for(path in paths) for(i in 1 until path.size) {
            val from=point(path[i-1]);val to=point(path[i])
            val east=to.east-from.east;val north=to.north-from.north
            val progress=((position.east-from.east)*east+(position.north-from.north)*north)/(east*east+north*north)
            val t=progress.coerceIn(0.0,1.0)
            val distance=hypot(position.east-from.east-t*east,position.north-from.north-t*north)
            if(distance < nearest) {nearest=distance;selected=path;index=i}
        }
        // shortcut: only the existing inferred aisle network is covered; survey paths before widening coverage.
        if(nearest > 2.0 || selected == null) return false
        route=selected;startId=route.first().id;targetIndex=index
        anchorCameraX=cameraX;anchorCameraZ=cameraZ;anchorEast=position.east;anchorNorth=position.north;rotation=mapRotation
        setTarget()
        return true
    }

    /** Optional compass registration; otherwise assume the opening camera faces the first segment. */
    fun update(cameraX: Double,cameraZ: Double,cameraHeading: Double,mapRotation: Double = Double.NaN): Double {
        if(!listOf(cameraX,cameraZ,cameraHeading).all {it.isFinite()} || complete) return Double.NaN
        if(!anchorCameraX.isFinite()) {
            val start=point(route.first());val next=point(route[1])
            anchorCameraX=cameraX;anchorCameraZ=cameraZ;anchorEast=start.east;anchorNorth=start.north
            rotation=if(mapRotation.isFinite()) mapRotation else cameraHeading-atan2(next.east-start.east,next.north-start.north)
        }
        setTarget()
        val previous=point(route[targetIndex-1])
        val east=previous.east-anchorEast;val north=previous.north-anchorNorth
        val previousX=anchorCameraX+east*cos(rotation)+north*sin(rotation)
        val previousZ=anchorCameraZ+east*sin(rotation)-north*cos(rotation)
        val segmentX=targetX-previousX;val segmentZ=targetZ-previousZ
        val lateral=abs((cameraX-previousX)*segmentZ-(cameraZ-previousZ)*segmentX)/hypot(segmentX,segmentZ)
        // Inferred scale/start make this an estimate; detours must return near the segment before advancing.
        if(hypot(targetX-cameraX,targetZ-cameraZ) <= 1.5 && lateral <= 0.75) {
            targetIndex++
            if(complete) {targetX=Double.NaN;targetZ=Double.NaN;return Double.NaN}
            setTarget()
        }
        val goal=atan2(targetX-cameraX,cameraZ-targetZ)
        return atan2(sin(goal-cameraHeading),cos(goal-cameraHeading))
    }

    /** Correct the route rotation around the current estimated camera point, preserving relative progress. */
    fun align(cameraX: Double,cameraZ: Double,cameraHeading: Double,relativeHeading: Double): Boolean {
        if(!listOf(cameraX,cameraZ,cameraHeading,relativeHeading,anchorCameraX).all {it.isFinite()} || complete) return false
        val dx=cameraX-anchorCameraX;val dz=cameraZ-anchorCameraZ
        anchorEast+=dx*cos(rotation)+dz*sin(rotation)
        anchorNorth+=dx*sin(rotation)-dz*cos(rotation)
        anchorCameraX=cameraX;anchorCameraZ=cameraZ
        val next=point(route[targetIndex])
        rotation=cameraHeading+relativeHeading-atan2(next.east-anchorEast,next.north-anchorNorth)
        setTarget()
        return true
    }

    private fun setTarget() {
        val next=point(route[targetIndex]);val east=next.east-anchorEast;val north=next.north-anchorNorth
        targetX=anchorCameraX+east*cos(rotation)+north*sin(rotation)
        targetZ=anchorCameraZ+east*sin(rotation)-north*cos(rotation)
    }
}
