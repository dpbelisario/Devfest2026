import XCTest
import ARKit
@testable import Contour

final class IndoorDestinationTests: XCTestCase {
    func testDirectionOnlyARDoesNotRequestObstacleGeometry() {
        let config = IndoorDestinationScanViewController.cameraConfiguration(exitGoal: false, directionOnly: true)
        XCTAssertTrue(config.planeDetection.isEmpty)
        XCTAssertTrue(config.frameSemantics.isEmpty)
        XCTAssertTrue(config.sceneReconstruction.isEmpty)
    }
    func testStationaryAndUnknownStepCountsNeverMoveOrCatchUpLater() {
        var gate = IndoorWalkingGate(time: 100)
        XCTAssertEqual(gate.consume(total: 3, time: 102), 0, "Unknown activity must not move the dot")
        gate.record(time: 102, walking: false)
        XCTAssertEqual(gate.consume(total: 7, time: 105), 0, "Sitting/fidgeting counts are consumed without movement")
        gate.record(time: 105, walking: true)
        XCTAssertEqual(gate.consume(total: 10, time: 108), 3, "Only the three new walking steps count")
        XCTAssertEqual(gate.consume(total: 10, time: 108), 3, "Repeated batches must not move twice")
        XCTAssertEqual(gate.consume(total: 8, time: 107), 3, "Old batches must not roll back counters")
        gate.record(time: 108, walking: false)
        XCTAssertEqual(gate.consume(total: 12, time: 110), 3)
        gate.record(time: 110, walking: true)
        XCTAssertEqual(gate.consume(total: 14, time: 112), 5, "Do not replay rejected counts after walking resumes")
    }
    func testStationaryPhoneTurnsDoNotMoveCoordinates() {
        var model = IndoorStepModel(request: .init(sessionID: "seated", floor: "2F", latitude: 35,
            longitude: 136, heading: 0, stepLength: 0.75), time: 100)
        for tick in 0...50 { XCTAssertTrue(model.turn(clockwiseRadiansPerSecond: 0.1, time: 100 + Double(tick) * 0.2)) }
        XCTAssertTrue(model.countSteps(0, time: 110))
        XCTAssertEqual(model.pose.latitude, 35); XCTAssertEqual(model.pose.longitude, 136)
        XCTAssertEqual(model.pose.steps, 0); XCTAssertEqual(model.pose.distance, 0)
        XCTAssertGreaterThan(model.pose.heading, 0)
    }

    func testTrackedARRouteFollowsCornersRatherThanTheDirectDestinationBearing() {
        let metre = 111319.49079327358, latitude = 35.0, longitude = 136.0
        let east10 = 10 / (metre * cos(latitude * .pi / 180))
        let points: [FloorARGoal.RoutePoint] = [.init(latitude: latitude, longitude: longitude),
            .init(latitude: latitude + 10 / metre, longitude: longitude),
            .init(latitude: latitude + 10 / metre, longitude: longitude + east10)]
        var follower = FloorRouteFollower(points: points)
        var pose = IndoorStepModel(request: .init(sessionID: "route", floor: "2F", latitude: latitude,
            longitude: longitude, heading: 0, stepLength: 0.75), time: 100).pose
        let first = follower.guidance(from: pose)
        XCTAssertEqual(first.relative, 0, accuracy: 0.001)
        XCTAssertEqual(first.distance, 20, accuracy: 0.01)
        XCTAssertFalse(first.offRoute)
        pose.latitude = points[1].latitude
        let corner = follower.guidance(from: pose)
        XCTAssertEqual(follower.targetIndex, 2)
        XCTAssertEqual(corner.relative, .pi / 2, accuracy: 0.001)
        pose.heading = 90
        XCTAssertEqual(follower.guidance(from: pose).relative, 0, accuracy: 0.001)
        pose.longitude = points[2].longitude
        XCTAssertLessThan(follower.guidance(from: pose).distance, 0.01)
        var offRoute = FloorRouteFollower(points: points)
        pose.latitude = latitude; pose.longitude = longitude + east10 / 2
        XCTAssertTrue(offRoute.guidance(from: pose).offRoute)
        XCTAssertEqual(offRoute.targetIndex, 1, "Do not jump to a later nearby corridor")
    }
    func testDelayedStepBatchUpdatesPositionWithoutPausingOrRegressingPoseTime() {
        let request = IndoorStepRequest(sessionID: "delayed", floor: "2F", latitude: 35, longitude: 136, heading: 0, stepLength: 0.75)
        var model = IndoorStepModel(request: request, time: 100)
        for tick in 0...50 { XCTAssertTrue(model.turn(clockwiseRadiansPerSecond: 0, time: 100 + Double(tick) * 0.2)) }
        XCTAssertTrue(model.countSteps(5, time: 105), "A batch five seconds behind the gyro is valid")
        XCTAssertEqual(model.pose.steps, 5)
        XCTAssertEqual(model.pose.status, "tracking")
        XCTAssertEqual(model.pose.timestamp, 110000, "The page must receive a monotonic pose date")
        XCTAssertEqual((model.pose.latitude - 35) * 111319.49079327358, 3.75, accuracy: 0.001)
        XCTAssertTrue(model.countSteps(8, time: 108))
        XCTAssertEqual(model.pose.distance, 6, accuracy: 0.001)
        XCTAssertEqual(model.pose.timestamp, 110000)
    }
    func testReviewedWallRejectsCrossingStepWithoutChangingHeadingOrLosingCounts() {
        let geometry = FloorWallGeometry(walls: [.init(start: .init(x: 0.1, y: 0.52), end: .init(x: 0.9, y: 0.52))], reviewed: true)
        let map = FloorWallMap(latitude: 35, longitude: 136, width: 10, aspect: 1, angle: 0, geometry: geometry)
        let request = IndoorStepRequest(sessionID: "wall", floor: "2F", latitude: 35, longitude: 136, heading: 180, stepLength: 0.72, wallMap: map)
        XCTAssertTrue(request.isValid)
        var model = IndoorStepModel(request: request, time: 100)
        XCTAssertTrue(model.turn(clockwiseRadiansPerSecond: 0, time: 100.1))
        XCTAssertTrue(model.countSteps(1, time: 100.1))
        XCTAssertTrue(model.pose.wallBlocked)
        XCTAssertEqual(model.pose.latitude, 35); XCTAssertEqual(model.pose.longitude, 136)
        XCTAssertEqual(model.pose.steps, 1); XCTAssertEqual(model.pose.heading, 180)
        // Turn north and walk away: don't stick permanently or double-apply the rejected count.
        for tick in 1...10 { XCTAssertTrue(model.turn(clockwiseRadiansPerSecond: .pi, time: 100.1 + Double(tick) / 10)) }
        XCTAssertTrue(model.countSteps(2, time: 101.1))
        XCTAssertFalse(model.pose.wallBlocked)
        XCTAssertEqual((model.pose.latitude - 35) * 111319.49079327358, 0.72, accuracy: 0.001)
        XCTAssertEqual(model.pose.steps, 2)
    }

    func testIndoorStepsAndGyroTurnsAdvanceFromConfirmedOrigin() {
        let request = IndoorStepRequest(sessionID: "walk", floor: "2F", latitude: 35, longitude: 136, heading: 0, stepLength: 0.72)
        XCTAssertTrue(request.isValid)
        var model = IndoorStepModel(request: request, time: 100)
        XCTAssertTrue(model.turn(clockwiseRadiansPerSecond: 0, time: 100.1))
        XCTAssertTrue(model.countSteps(1, time: 100.1))
        XCTAssertEqual((model.pose.latitude - 35) * 111319.49079327358, 0.72, accuracy: 0.001)
        let beforeTurn = model.pose
        for tick in 1...10 { XCTAssertTrue(model.turn(clockwiseRadiansPerSecond: .pi / 2, time: 100.1 + Double(tick) / 10)) }
        XCTAssertEqual(model.pose.heading, 90, accuracy: 0.001)
        XCTAssertEqual(model.pose.latitude, beforeTurn.latitude, "Turning alone cannot move the position")
        XCTAssertTrue(model.countSteps(2, time: 101.1))
        XCTAssertEqual((model.pose.longitude - 136) * 111319.49079327358 * cos(35 * .pi / 180), 0.72, accuracy: 0.001)
        XCTAssertEqual(model.pose.distance, 1.44, accuracy: 0.001)
        let afterStep = model.pose
        XCTAssertTrue(model.countSteps(2, time: 101.2))
        XCTAssertEqual(model.pose.latitude, afterStep.latitude)
        XCTAssertFalse(model.countSteps(1, time: 101.3), "Reject old cumulative counters")
        XCTAssertFalse(model.turn(clockwiseRadiansPerSecond: .nan, time: 101.4))
        XCTAssertFalse(model.turn(clockwiseRadiansPerSecond: 0, time: 105), "A sensor gap requires reconfirmation")
    }

    func testIndoorGoalUsesSharedStepPoseForDistanceAndDirection() {
        let origin = FloorARGoal.Point(latitude: 35, longitude: 136, name: "Start")
        let goal = FloorARGoal(version: 1, floor: "2F", start: origin, destination: .init(latitude: 35 + 10 / 111319.49079327358, longitude: 136, name: "Room"))
        var model = IndoorStepModel(request: .init(sessionID: "walk", floor: "2F", latitude: 35, longitude: 136, heading: 0, stepLength: 0.8), time: 100)
        XCTAssertTrue(model.turn(clockwiseRadiansPerSecond: 0, time: 100.1))
        XCTAssertTrue(model.countSteps(1, time: 100.1))
        let navigation = goal.guidance(from: model.pose)
        XCTAssertEqual(navigation.distance, 9.2, accuracy: 0.001)
        XCTAssertEqual(navigation.relative, 0, accuracy: 0.001)
        XCTAssertFalse(IndoorStepRequest(sessionID: "", floor: "2F", latitude: 35, longitude: 136, heading: 0, stepLength: 0.8).isValid)
        XCTAssertFalse(IndoorStepRequest(sessionID: "x", floor: "2F", latitude: 35, longitude: 136, heading: 0, stepLength: 2).isValid)
    }

    @MainActor
    func testFloorDestinationArrowIsVisibleAndPaintedBeforeAnyARFrame() throws {
        let controller = IndoorDestinationScanViewController()
        controller.floorGoal = FloorARGoal(heading: .init(degrees: 90, accuracy: 8, timestamp: Date().timeIntervalSince1970 * 1000), version: 1, floor: "2F",
            start: .init(latitude: 35, longitude: 136, name: "Start"), destination: .init(latitude: 35.0001, longitude: 136, name: "Goal"))
        controller.loadViewIfNeeded()
        controller.view.frame = CGRect(x: 0, y: 0, width: 390, height: 844)
        controller.view.layoutIfNeeded()
        let arrow = try XCTUnwrap(controller.view.subviews.compactMap { $0 as? DestinationArrowView }.first)
        XCTAssertFalse(arrow.isHidden)
        XCTAssertGreaterThan(arrow.bounds.width, 0)
        let format = UIGraphicsImageRendererFormat(); format.scale = 1; format.opaque = false
        let image = UIGraphicsImageRenderer(size: arrow.bounds.size, format: format).image { _ in arrow.draw(arrow.bounds) }
        let bytes = try XCTUnwrap(image.cgImage?.dataProvider?.data) as Data
        XCTAssertGreaterThan(bytes.filter { $0 != 0 }.count, 1000, "The initial arrow must contain actual drawn pixels without waiting for camera features")
        arrow.update(relative: .pi / 2, caution: true)
        XCTAssertEqual(arrow.transform.a, 0, accuracy: 0.001)
        arrow.update(relative: 0, stopped: true)
        XCTAssertTrue(arrow.stopped)
    }

    func testFloorHeadingSnapshotExpiresWithoutAssumingForward() {
        let now = Date(timeIntervalSince1970: 1000)
        XCTAssertTrue(FloorARGoal.Heading(degrees: 90, accuracy: 8, timestamp: 999000).isFresh(now: now))
        XCTAssertFalse(FloorARGoal.Heading(degrees: 90, accuracy: 8, timestamp: 980000).isFresh(now: now))
        XCTAssertFalse(FloorARGoal.Heading(degrees: .nan, accuracy: 8, timestamp: 999000).isFresh(now: now))
    }

    func testSavedFloorARGoalValidatesCoordinatesFloorAndDistance() throws {
        let start = FloorARGoal.Point(latitude: 35, longitude: 136, name: "Start")
        let destination = FloorARGoal.Point(latitude: 35 + 10 / 111319.49079327358, longitude: 136, name: "Room")
        let goal = FloorARGoal(version: 1, floor: "2F", start: start, destination: destination)
        XCTAssertTrue(goal.isValid)
        XCTAssertEqual(try JSONDecoder().decode(FloorARGoal.self, from: JSONEncoder().encode(goal)).destination.name, "Room")
        XCTAssertFalse(FloorARGoal(version: 1, floor: "99F", start: start, destination: destination).isValid)
        XCTAssertFalse(FloorARGoal(version: 1, floor: "2F", start: start, destination: start).isValid)
        XCTAssertFalse(FloorARGoal(version: 1, floor: "2F", start: start, destination: .init(latitude: 36, longitude: 136, name: "Too far")).isValid)
        XCTAssertFalse(FloorARGoal(version: 1, floor: "2F", start: .init(latitude: .nan, longitude: 136, name: "Bad"), destination: destination).isValid)
    }

    func testFloorARRequiresTurningBeforePointingOutsideObservedForwardSector() {
        XCTAssertEqual(DestinationObstacleProbe.guidance(center: .farther, left: .unknown, right: .unknown, relative: 0.25, alignmentTolerance: atan(0.15)), "face-right")
        XCTAssertEqual(DestinationObstacleProbe.guidance(center: .unknown, left: .unknown, right: .unknown, relative: 0, alignmentTolerance: atan(0.15)), "scan")
        XCTAssertEqual(DestinationObstacleProbe.guidance(center: .near, left: .unknown, right: .unknown, relative: 0, alignmentTolerance: atan(0.15)), "scan")
    }

    func testSavedFloorARTargetAlignsCompassWithARFrameWithoutGPS() {
        let start = FloorARGoal.Point(latitude: 35, longitude: 136, name: "Start")
        let north = FloorARGoal(version: 1, floor: "2F", start: start,
            destination: .init(latitude: 35 + 10 / 111319.49079327358, longitude: 136, name: "North"))
        let origin = SIMD2<Float>(2, 3)
        let forward = north.target(camera: origin, cameraYaw: 0, compassDegrees: 0)
        XCTAssertEqual(forward.x, 2, accuracy: 0.001); XCTAssertEqual(forward.y, -7, accuracy: 0.001)
        let left = north.target(camera: origin, cameraYaw: 0, compassDegrees: 90)
        XCTAssertEqual(left.x, -8, accuracy: 0.001); XCTAssertEqual(left.y, 3, accuracy: 0.001)
        let rotated = north.target(camera: origin, cameraYaw: .pi / 2, compassDegrees: 90)
        XCTAssertEqual(rotated.x, 2, accuracy: 0.001); XCTAssertEqual(rotated.y, -7, accuracy: 0.001)
    }

    func testCameraOnlyConfigurationNeverRequestsLidar() {
        for exitGoal in [false, true] {
            let config = IndoorDestinationScanViewController.cameraConfiguration(exitGoal: exitGoal)
            XCTAssertTrue(config.frameSemantics.isEmpty)
            XCTAssertTrue(config.sceneReconstruction.isEmpty)
            XCTAssertTrue(config.planeDetection.contains(.vertical))
            XCTAssertTrue(config.planeDetection.contains(.horizontal))
        }
    }
    func testCameraEvidenceNeedsDistributedFeaturesAndCloseAlwaysOverrides() {
        let spread: [SIMD3<Float>] = [-0.1, 0.0, 0.1].flatMap { x in
            [-0.45, -0.15, 0.15].map { y in SIMD3<Float>(Float(x) * 2.5, Float(y) * 2.5, -2.5) }
        }
        XCTAssertEqual(CameraDestinationObstacleProbe.evidence(points: spread, sector: 1), .farther)
        XCTAssertEqual(CameraDestinationObstacleProbe.evidence(points: Array(repeating: SIMD3<Float>(0, 0, -2.5), count: 100), sector: 1), .unknown)
        XCTAssertEqual(CameraDestinationObstacleProbe.evidence(points: spread + [SIMD3<Float>(0, 0, -0.8)], sector: 1), .unknown)
        XCTAssertEqual(CameraDestinationObstacleProbe.evidence(points: spread + [SIMD3<Float>(-0.08, 0, -0.8), SIMD3<Float>(0.08, 0, -0.8)], sector: 1), .near)
        XCTAssertEqual(CameraDestinationObstacleProbe.evidence(points: [], sector: 1, planeDistances: [0.8]), .near)
        XCTAssertEqual(CameraDestinationObstacleProbe.evidence(points: [], sector: 1, planeDistances: [3]), .unknown)
        XCTAssertEqual(CameraDestinationObstacleProbe.evidence(points: spread, sector: 1, planeDistances: [1.4]), .unknown)
        XCTAssertEqual(CameraDestinationObstacleProbe.evidence(points: [SIMD3<Float>(.nan, 0, -2)], sector: 1), .unknown)
        XCTAssertEqual(CameraDestinationObstacleProbe.evidence(points: spread, sector: 0), .unknown)
    }
    func testCameraCueGateSuppressesNoiseStaleAndRepeatedFrames() {
        var gate = CameraCueGate()
        XCTAssertEqual(gate.update(cue: "forward", timestamp: 1, now: 1.01), "scan")
        XCTAssertEqual(gate.update(cue: "forward", timestamp: 1.2, now: 1.21), "scan")
        XCTAssertEqual(gate.update(cue: "forward", timestamp: 1.4, now: 1.41), "forward")
        XCTAssertEqual(gate.update(cue: "scan", timestamp: 1.6, now: 1.61), "scan", "Close/unknown evidence removes forward immediately")
        XCTAssertEqual(gate.update(cue: "stop", timestamp: 1.8, now: 1.81), "stop")
        XCTAssertEqual(gate.update(cue: "forward", timestamp: 1.8, now: 1.81), "scan")
        XCTAssertEqual(gate.update(cue: "forward", timestamp: 2, now: 3), "scan")
        XCTAssertEqual(gate.update(cue: "forward", timestamp: 3, now: 3.01, tracking: false), "scan")
        XCTAssertEqual(gate.update(cue: "forward", timestamp: .nan, now: 3.01), "scan")
    }
    func testCameraFallbackRequiresActualFeaturesOrPlane() {
        XCTAssertEqual(DestinationObstacleProbe.cameraEvidence([]),.unknown)
        XCTAssertEqual(DestinationObstacleProbe.cameraEvidence(Array(repeating:0.8,count:6)),.near)
        XCTAssertEqual(DestinationObstacleProbe.cameraEvidence(Array(repeating:2.5,count:6)),.farther)
        XCTAssertEqual(DestinationObstacleProbe.cameraEvidence([0.8]+Array(repeating:2.5,count:6),planeDistance:3),.unknown)
        XCTAssertEqual(DestinationObstacleProbe.cameraEvidence([],planeDistance:0.8),.near)
        XCTAssertEqual(DestinationObstacleProbe.cameraEvidence([],planeDistance:3),.farther)
        XCTAssertEqual(DestinationObstacleProbe.cameraEvidence(Array(repeating:3,count:6),planeDistance:0.8),.near)
        XCTAssertEqual(DestinationObstacleProbe.cameraEvidence(Array(repeating:3,count:6),planeDistance:1.3),.unknown)
        XCTAssertEqual(DestinationObstacleProbe.cameraEvidence([.nan,0],planeDistance:.nan),.unknown)
    }
    func testContinuousDemoDirectionRequiresObservedSide() {
        XCTAssertEqual(DestinationObstacleProbe.guidance(center:.farther,left:.unknown,right:.unknown,relative:0),"forward")
        XCTAssertEqual(DestinationObstacleProbe.guidance(center:.farther,left:.farther,right:.near,relative:1),"face-right")
        XCTAssertEqual(DestinationObstacleProbe.guidance(center:.unknown,left:.unknown,right:.unknown,relative:1),"face-right")
        XCTAssertEqual(DestinationObstacleProbe.guidance(center:.unknown,left:.unknown,right:.unknown,relative:-1),"face-left")
        XCTAssertEqual(DestinationObstacleProbe.guidance(center:.unknown,left:.unknown,right:.unknown,relative:3),"around")
        XCTAssertEqual(DestinationObstacleProbe.guidance(center:.unknown,left:.farther,right:.farther,relative:0),"scan")
        XCTAssertEqual(DestinationObstacleProbe.guidance(center:.near,left:.farther,right:.near,relative:.nan),"left")
        XCTAssertEqual(DestinationObstacleProbe.guidance(center:.near,left:.near,right:.near,relative:0),"stop")
        XCTAssertEqual(DestinationObstacleProbe.guidance(center:.farther,left:.farther,right:.farther,relative:.nan),"scan")
    }
    func testRelativeObstacleDirectionsStopOnUnknownEvidence() {
        XCTAssertEqual(DestinationObstacleProbe.cue(center: .farther, left: .unknown, right: .unknown), "forward")
        XCTAssertEqual(DestinationObstacleProbe.cue(center: .near, left: .farther, right: .near), "left")
        XCTAssertEqual(DestinationObstacleProbe.cue(center: .near, left: .near, right: .farther), "right")
        XCTAssertEqual(DestinationObstacleProbe.cue(center: .near, left: .near, right: .near), "stop")
        XCTAssertEqual(DestinationObstacleProbe.cue(center: .near, left: .unknown, right: .unknown), "scan")
        XCTAssertEqual(DestinationObstacleProbe.cue(center: .unknown, left: .farther, right: .farther), "scan")
    }
    func testObstacleEvidenceNeverTreatsMissingDepthAsClear() {
        XCTAssertEqual(DestinationObstacleProbe.depthEvidence([0.8]+Array(repeating: 2.5,count:24)), .unknown)
        XCTAssertFalse(DestinationObstacleProbe.closeDepth([]))
        XCTAssertFalse(DestinationObstacleProbe.closeDepth(Array(repeating: .nan, count: 40)))
        XCTAssertFalse(DestinationObstacleProbe.closeDepth(Array(repeating: 0, count: 40)))
        XCTAssertTrue(DestinationObstacleProbe.closeDepth(Array(repeating: 0.8, count: 40)))
        XCTAssertFalse(DestinationObstacleProbe.closeDepth(Array(repeating: 2.5, count: 40)))
        XCTAssertFalse(DestinationObstacleProbe.closeFeatures([SIMD3<Float>(0, 0, -0.6)]))
        XCTAssertTrue(DestinationObstacleProbe.closeFeatures(Array(repeating: SIMD3<Float>(0.1, 0, -0.6), count: 6)))
        XCTAssertFalse(DestinationObstacleProbe.closeFeatures(Array(repeating: SIMD3<Float>(1.2, 0, -0.6), count: 20)))
    }

    func testKnownKindsUseSharedKotlinAndUnknownKindIsRejected() {
        for kind in ["eew", "tsunami", "special", "evac", "alert"] {
            XCTAssertEqual(ContourAlert(payload: ["kind": kind])?.kind, kind)
        }
        XCTAssertNil(ContourAlert(payload: ["kind": "unknown"]))
        XCTAssertNil(ContourAlert(payload: [:]))
    }

    func testPushFieldsAndLengths() {
        let alert = ContourAlert(payload: ["kind": "eew", "aps": ["alert": ["title": "Earthquake", "body": "Protect your head"]]])
        XCTAssertEqual(alert?.title, "Earthquake")
        XCTAssertEqual(alert?.text, "Protect your head")
        let bounded = ContourAlert(payload: ["kind": "eew", "title": String(repeating: "a", count: 300), "text": String(repeating: "b", count: 2500)])
        XCTAssertEqual(bounded?.title.count, 256)
        XCTAssertEqual(bounded?.text.count, 2000)
    }

    func testOriginTrustRejectsOtherHostsSchemesAndPorts() {
        let origin = URL(string: "https://example.com/app/")!
        XCTAssertTrue(WebOrigin.sameOrigin(origin, URL(string: "https://example.com:443/other")!))
        for url in ["http://example.com", "https://example.com:444", "https://example.com.evil.test", "file:///app.html"] {
            XCTAssertFalse(WebOrigin.sameOrigin(origin, URL(string: url)!))
        }
    }

    func testForegroundHapticsAreStrongButBounded() {
        XCTAssertEqual(AlertHaptics.pulseCount, 12)
        XCTAssertGreaterThan(AlertHaptics.pulseSpacing, AlertHaptics.pulseDuration)
        XCTAssertLessThan(Double(AlertHaptics.pulseCount) * AlertHaptics.pulseSpacing, 10)
    }

    func testSecurityOriginChecksWithoutReadingAFrameRequest() {
        let origin = URL(string: "https://example.com/app/")!
        for port in [0, 443] {
            XCTAssertTrue(WebOrigin.sameOrigin(scheme: "https", host: "example.com", port: port, to: origin))
        }
        XCTAssertFalse(WebOrigin.sameOrigin(scheme: "https", host: "example.com", port: 444, to: origin))
        XCTAssertFalse(WebOrigin.sameOrigin(scheme: "http", host: "example.com", port: 443, to: origin))
        XCTAssertFalse(WebOrigin.sameOrigin(scheme: "https", host: "example.com.evil.test", port: 443, to: origin))
        XCTAssertFalse(WebOrigin.sameOrigin(scheme: "file", host: "", port: 0, to: origin))
        XCTAssertTrue(WebOrigin.sameOrigin(scheme: "https", host: "example.com", port: 444, to: URL(string: "https://example.com:444/app/")!))
    }
}
