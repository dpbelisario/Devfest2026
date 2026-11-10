import XCTest
import UIKit
import MapKit
import SwiftUI
import WebKit
@testable import Contour

final class GeographicOverlayTests: XCTestCase {
    func testTrackedARResolvesSavedDestinationAndPlansFromLivePose() throws {
        let plan = landmarkPlan, pins = plan.destinations!
        let initialRoute = try FloorLandmarkPlanner.plan(overlay: plan, start: pins[0].id, destination: pins[3].id)
        let origin = initialRoute.path[1] // Already reached the first corner when AR opens.
        var pose = IndoorStepModel(request: .init(sessionID: "tracked-ar", floor: "2F", latitude: origin.latitude,
            longitude: origin.longitude, heading: 90, stepLength: 0.74), time: 100).pose
        pose.status = "tracking"
        var request = FloorARGoal(trackingID: pose.sessionID,
            routeRequest: .init(startID: pins[0].id, destinationID: pins[3].id, revision: try FloorLandmarkPlanner.revision(plan)),
            version: 1, floor: "2F", start: .init(latitude: 0, longitude: 0, name: "Untrusted"),
            destination: .init(latitude: 0, longitude: 0.001, name: "Untrusted"))
        let resolved = try OverlayDisk.resolveARGoal(request, overlay: plan, pose: pose)
        XCTAssertEqual(resolved.destination.name, pins[3].name)
        let route = try XCTUnwrap(resolved.route)
        XCTAssertEqual(route.first!.latitude, pose.latitude, accuracy: 0.0000001)
        XCTAssertEqual(route.first!.longitude, pose.longitude, accuracy: 0.0000001)
        XCTAssertTrue(resolved.isValid)
        XCTAssertEqual(plan.destinations![0].x, 0.1, "AR must not mutate the saved start pin")
        request.routeRequest = .init(startID: pins[0].id, destinationID: pins[3].id, revision: "outdated")
        XCTAssertThrowsError(try OverlayDisk.resolveARGoal(request, overlay: plan, pose: pose))
        request.routeRequest = nil
        XCTAssertThrowsError(try OverlayDisk.resolveARGoal(request, overlay: plan, pose: pose))
    }
    func testHealthStepLengthUsesRecentMedianAndRejectsUnusableSamples() throws {
        let now = Date(timeIntervalSince1970: 1800000000)
        let summary = try XCTUnwrap(HealthStepLengthSummary.summarize([
            (0.7, now.addingTimeInterval(-100)), (0.72, now.addingTimeInterval(-200)),
            (0.74, now.addingTimeInterval(-300)), (1.05, now.addingTimeInterval(-400)),
            (0.2, now), (.nan, now), (0.9, now.addingTimeInterval(100)),
            (0.6, now.addingTimeInterval(-31 * 86400))
        ], now: now))
        XCTAssertEqual(summary.metres, 0.73, accuracy: 0.00001)
        XCTAssertEqual(summary.sampleCount, 4)
        XCTAssertEqual(summary.latest, now.addingTimeInterval(-100))
        XCTAssertNil(HealthStepLengthSummary.summarize([], now: now))
        XCTAssertNil(HealthStepLengthSummary.summarize([(1.5, now)], now: now))
        let bounded = try XCTUnwrap(HealthStepLengthSummary.summarize(
            (0..<60).map { (0.75, now.addingTimeInterval(Double(-$0))) }, now: now))
        XCTAssertEqual(bounded.sampleCount, 50)
    }
    func testStepCalibrationRequiresMeasuredDistanceAndEnoughPlausibleSteps() {
        XCTAssertEqual(StepLengthCalibration.length(distance: 20, steps: 28)!, 20.0 / 28, accuracy: 0.00001)
        XCTAssertNil(StepLengthCalibration.length(distance: 20, steps: 0))
        XCTAssertNil(StepLengthCalibration.length(distance: 5, steps: 7))
        XCTAssertNil(StepLengthCalibration.length(distance: 20, steps: 10))
        XCTAssertNil(StepLengthCalibration.length(distance: .nan, steps: 28))
        XCTAssertNil(StepLengthCalibration.length(distance: 200, steps: 280))
    }
    func testCalibratedStepsContinuouslyAdvanceTheIndoorPose() throws {
        let length = try XCTUnwrap(StepLengthCalibration.length(distance: 20, steps: 28))
        let request = IndoorStepRequest(sessionID: "calibrated-walk", floor: "2F", latitude: 35,
            longitude: 136, heading: 0, stepLength: length)
        var model = IndoorStepModel(request: request, time: 100)
        for index in 0...100 { XCTAssertTrue(model.turn(clockwiseRadiansPerSecond: 0, time: 100 + Double(index) * 0.2)) }
        XCTAssertTrue(model.countSteps(28, time: 120))
        XCTAssertEqual(model.pose.steps, 28)
        XCTAssertEqual(model.pose.distance, 20, accuracy: 0.00001)
        XCTAssertEqual((model.pose.latitude - 35) * 111319.49079327358, 20, accuracy: 0.00001)
        XCTAssertEqual(model.pose.longitude, 136)
    }
    func testReviewedPinMoveUsesImageCoordinatesAtAnyZoomAndPersists() throws {
        var pin = FloorDestination(name: "Reference Books", x: 0.2, y: 0.3, confidence: 0.8,
            textBounds: CGRect(x: 0.1, y: 0.2, width: 0.2, height: 0.1), sourceLabels: ["Reference Books", "参考図書"])
        let id = pin.id
        pin.move(to: CGPoint(x: 600, y: 120), imageSize: CGSize(width: 800, height: 400))
        XCTAssertEqual(pin.x, 0.75); XCTAssertEqual(pin.y, 0.3)
        XCTAssertNil(pin.textBounds)
        XCTAssertEqual(pin.id, id); XCTAssertEqual(pin.confidence, 0.8)
        XCTAssertEqual(pin.sourceLabels, ["Reference Books", "参考図書"])
        let moved = pin
        pin.move(to: CGPoint(x: 1200, y: 240), imageSize: CGSize(width: 1600, height: 800))
        XCTAssertEqual(pin, moved, "Zoom must not change the normalized pin location")
        let restored = try JSONDecoder().decode(FloorDestination.self, from: JSONEncoder().encode(pin))
        XCTAssertEqual(restored, moved)
        pin.move(to: CGPoint(x: -20, y: 1000), imageSize: CGSize(width: 800, height: 400))
        XCTAssertEqual(pin.x, 0); XCTAssertEqual(pin.y, 1); XCTAssertTrue(pin.isValid)
        let edge = pin
        pin.move(to: .zero, imageSize: .zero)
        XCTAssertEqual(pin, edge, "Ignore an unlaid-out image")
    }
    private var landmarkPlan: GeographicOverlay {
        var plan = sample; plan.width = 10; plan.aspect = 1; plan.angle = 0
        plan.destinations = [FloorDestination(name: "Start", x: 0.1, y: 0.1),
            FloorDestination(name: "Reference Books", x: 0.1, y: 0.8),
            FloorDestination(name: "Group Learning Area", x: 0.9, y: 0.8),
            FloorDestination(name: "Entrance Hall", x: 0.9, y: 0.1),
            FloorDestination(name: "Isolated Room", x: 0.05, y: 0.95)]
        let pins = plan.destinations!
        plan.wallGeometry = FloorWallGeometry(walls: [.init(start: .init(x: 0.4, y: 0), end: .init(x: 0.4, y: 0.65))], reviewed: true)
        plan.walkingNetwork = FloorWalkingNetwork(points: pins.map { .init(destinationID: $0.id, position: .init(x: $0.x, y: $0.y)) },
            connections: [.init(from: pins[0].id, to: pins[1].id), .init(from: pins[1].id, to: pins[2].id),
                .init(from: pins[2].id, to: pins[3].id), .init(from: pins[0].id, to: pins[3].id)], reviewed: true)
        return plan
    }

    func testLandmarkSequenceFindsShortestConnectedPassagesInsteadOfCrossingWalls() throws {
        let plan = landmarkPlan, pins = plan.destinations!
        let route = try FloorLandmarkPlanner.plan(overlay: plan, start: pins[0].id, destination: pins[3].id)
        XCTAssertEqual(route.status, "ok")
        XCTAssertEqual(route.landmarkIDs, Array(pins.prefix(4)).map(\.id))
        XCTAssertEqual(route.distance, 22, accuracy: 0.001)
        XCTAssertEqual(route.instructions.count, 4)
        XCTAssertTrue(route.instructions[0].contains("Reference Books"))
        XCTAssertTrue(route.instructions[1].contains("turn left"))
        XCTAssertTrue(route.instructions[2].contains("Entrance Hall"))
        XCTAssertEqual(route.path.count, 4)
        let reverse = try FloorLandmarkPlanner.plan(overlay: plan, start: pins[3].id, destination: pins[0].id)
        XCTAssertEqual(reverse.landmarkIDs, Array(pins.prefix(4)).map(\.id).reversed())
        XCTAssertTrue(reverse.instructions[1].contains("turn right"))
        var doubled = plan; doubled.width = 20
        XCTAssertEqual(try FloorLandmarkPlanner.plan(overlay: doubled, start: pins[0].id, destination: pins[3].id).distance, 44, accuracy: 0.001)
    }

    func testAutomaticRoutesRespectOpeningsAndNeedReviewedWallsRatherThanManualLinks() throws {
        var plan = landmarkPlan; let pins = plan.destinations!
        plan.walkingNetwork = nil
        XCTAssertEqual(try FloorLandmarkPlanner.plan(overlay: plan, start: pins[0].id, destination: pins[3].id).status, "ok", "Connections are now inferred automatically from visibility")
        plan.wallGeometry?.walls[0].end.y = 1
        XCTAssertEqual(try FloorLandmarkPlanner.plan(overlay: plan, start: pins[0].id, destination: pins[3].id).status, "no-path")
        plan.wallGeometry?.openings = [.init(start: .init(x: 0.4, y: 0.04), end: .init(x: 0.4, y: 0.16))]
        let throughDoor = try FloorLandmarkPlanner.plan(overlay: plan, start: pins[0].id, destination: pins[3].id)
        XCTAssertEqual(throughDoor.landmarkIDs, [pins[0].id, pins[3].id]); XCTAssertEqual(throughDoor.distance, 8, accuracy: 0.001)
        plan.wallGeometry?.reviewed = false
        let draft = try FloorLandmarkPlanner.plan(overlay: plan, start: pins[0].id, destination: pins[3].id)
        XCTAssertEqual(draft.status, "needs-walls"); XCTAssertTrue(draft.instructions.isEmpty)
        XCTAssertEqual(try FloorLandmarkPlanner.plan(overlay: plan, start: pins[0].id, destination: pins[0].id).status, "same-place")
        XCTAssertEqual(try FloorLandmarkPlanner.plan(overlay: plan, start: UUID(), destination: pins[0].id).status, "invalid")
    }

    func testShorterMultiPinRouteWinsOverLongerDirectConnection() throws {
        var plan = landmarkPlan; let pins = plan.destinations!
        plan.walkingNetwork?.connections.removeAll { Set([$0.from, $0.to]) == Set([pins[0].id, pins[3].id]) }
        plan.walkingNetwork?.connections.append(.init(from: pins[0].id, to: pins[3].id,
            via: [.init(x: 0.1, y: 0.9), .init(x: 0.9, y: 0.9)]))
        let route = try FloorLandmarkPlanner.plan(overlay: plan, start: pins[0].id, destination: pins[3].id)
        XCTAssertEqual(route.landmarkIDs, Array(pins.prefix(4)).map(\.id))
        XCTAssertEqual(route.distance, 22, accuracy: 0.001, "Prefer the shorter wall-clear route even when it passes more landmarks")
        XCTAssertEqual(route.path.count, 4, "Keep bends; do not simplify into a straight line through the wall")
        let map = FloorWallMap(latitude: plan.latitude, longitude: plan.longitude, width: plan.width,
            aspect: plan.aspect, angle: plan.angle, geometry: plan.wallGeometry!)
        let points = route.path.map { map.local(latitude: $0.latitude, longitude: $0.longitude) }
        for pair in zip(points, points.dropFirst()) { XCTAssertFalse(FloorWallMap.blocks(from: pair.0, to: pair.1, barriers: map.barriers)) }
    }

    func testShortestLengthBreaksTiesBetweenRoutesWithTheSamePinCount() throws {
        var plan = landmarkPlan; plan.walkingNetwork = nil
        plan.destinations = [.init(name: "Start", x: 0.2, y: 0.2), .init(name: "Near opening", x: 0.5, y: 0.7),
            .init(name: "Far detour", x: 0.5, y: 0.9), .init(name: "Goal", x: 0.8, y: 0.2)]
        plan.wallGeometry?.walls = [.init(start: .init(x: 0.5, y: 0), end: .init(x: 0.5, y: 0.6))]
        let pins = plan.destinations!
        let route = try FloorLandmarkPlanner.plan(overlay: plan, start: pins[0].id, destination: pins[3].id)
        XCTAssertEqual(route.landmarkIDs, [pins[0].id, pins[1].id, pins[3].id])
        XCTAssertEqual(route.distance, 2 * hypot(3, 5), accuracy: 0.001)
        plan.destinations?[1].name = "2F"; plan.destinations?[2].name = "3F"
        XCTAssertEqual(try FloorLandmarkPlanner.plan(overlay: plan, start: pins[0].id, destination: pins[3].id).status, "no-path", "Do not use printed floor labels as passage landmarks")
    }

    func testWalkingNetworkPersistencePruningAndRevisionInvalidateStaleRoutes() throws {
        let plan = landmarkPlan, pins = plan.destinations!
        let restored = try JSONDecoder().decode(GeographicOverlay.self, from: JSONEncoder().encode(plan))
        XCTAssertEqual(restored.walkingNetwork, plan.walkingNetwork)
        var pruned = try XCTUnwrap(plan.walkingNetwork).pruning(destinations: [pins[0], pins[3]])
        XCTAssertEqual(pruned.connections.count, 1); XCTAssertFalse(pruned.reviewed)
        XCTAssertTrue(pruned.isValid(for: [pins[0], pins[3]]))
        pruned.connections.append(.init(from: pins[3].id, to: pins[0].id))
        XCTAssertFalse(pruned.isValid(for: [pins[0], pins[3]]), "Reject duplicate reverse edges")
        var renamed = plan; renamed.destinations?[0].name = "New name"
        XCTAssertNotEqual(try FloorLandmarkPlanner.revision(plan), try FloorLandmarkPlanner.revision(renamed))
        renamed = plan; renamed.opacity = 0.5; renamed.visible.toggle()
        XCTAssertEqual(try FloorLandmarkPlanner.revision(plan), try FloorLandmarkPlanner.revision(renamed))
        renamed = plan; renamed.angle += 12
        XCTAssertNotEqual(try FloorLandmarkPlanner.revision(plan), try FloorLandmarkPlanner.revision(renamed))
        var network = FloorWalkingNetwork.draft(for: plan); network.connections = []
        let suggested = FloorLandmarkPlanner.suggest(network, overlay: plan)
        XCTAssertFalse(suggested.reviewed); XCTAssertTrue(suggested.isValid(for: pins))
        XCTAssertFalse(suggested.connections.contains { Set([$0.from, $0.to]) == Set([pins[0].id, pins[3].id]) }, "Draft suggestions must respect reviewed walls")
    }

    func testSavedOverlayRouteRevisionIsTransferredAndOutdatedRequestsAreRejected() async throws {
        let json = try await OverlayDisk.shared.json()
        let object = try XCTUnwrap(JSONSerialization.jsonObject(with: Data(json.utf8)) as? [String: Any])
        let revision = try XCTUnwrap(object["routingRevision"] as? String)
        XCTAssertEqual(revision.count, 64)
        let floor = object["floor"] as? String ?? "2F"
        let invalidID = try await OverlayDisk.shared.landmarkRoute(start: UUID(), destination: UUID(), floor: floor, revision: revision)
        XCTAssertEqual(invalidID.status, "invalid")
        let stale = try await OverlayDisk.shared.landmarkRoute(start: UUID(), destination: UUID(), floor: "1F", revision: String(repeating: "0", count: 64))
        XCTAssertEqual(stale.status, "outdated"); XCTAssertTrue(stale.path.isEmpty)
        XCTAssertEqual(stale.floor, "1F", "Return stale-map feedback to the request's floor without a route")
    }

    func testWallDetectionRetainsDoorGapsAndRejectsThickFurniture() throws {
        let format = UIGraphicsImageRendererFormat(); format.scale = 1
        let image = UIGraphicsImageRenderer(size: CGSize(width: 360, height: 260), format: format).image { context in
            UIColor.white.setFill(); context.fill(CGRect(x: 0, y: 0, width: 360, height: 260))
            let cg = context.cgContext
            cg.setStrokeColor(UIColor(red: 0.45, green: 0.58, blue: 0.28, alpha: 1).cgColor); cg.setLineWidth(3)
            cg.move(to: CGPoint(x: 30, y: 60)); cg.addLine(to: CGPoint(x: 150, y: 60))
            cg.move(to: CGPoint(x: 180, y: 60)); cg.addLine(to: CGPoint(x: 330, y: 60))
            cg.move(to: CGPoint(x: 280, y: 100)); cg.addLine(to: CGPoint(x: 280, y: 230)); cg.strokePath()
            UIColor.darkGray.setFill(); context.fill(CGRect(x: 45, y: 125, width: 65, height: 60))
            ("ROOM A" as NSString).draw(at: CGPoint(x: 130, y: 150), withAttributes: [.font: UIFont.systemFont(ofSize: 12), .foregroundColor: UIColor.black])
        }
        let detected = try FloorWallDetector.detect(XCTUnwrap(image.pngData()))
        XCTAssertTrue(detected.isValid); XCTAssertFalse(detected.reviewed)
        let top = detected.walls.filter { abs($0.start.y - 60.0 / 260) < 0.02 && abs($0.end.y - $0.start.y) < 0.01 }
        XCTAssertGreaterThanOrEqual(top.count, 2)
        XCTAssertFalse(top.contains { $0.start.x < 150.0 / 360 && $0.end.x > 180.0 / 360 }, "Door gaps must not be filled by line merging")
        XCTAssertTrue(detected.walls.contains { abs($0.start.x - 280.0 / 360) < 0.02 && $0.end.y - $0.start.y > 0.3 })
        XCTAssertFalse(detected.walls.contains { $0.start.x > 0.12 && $0.end.x < 0.32 && $0.start.y > 0.45 && $0.end.y < 0.75 }, "Filled furniture must not turn into wall centerlines")
    }

    func testReviewedWallsRoundTripAndDoorOpeningsCutOnlyTheMatchingWall() throws {
        let wall = FloorWallSegment(start: .init(x: 0.1, y: 0.5), end: .init(x: 0.9, y: 0.5))
        let opening = FloorWallSegment(start: .init(x: 0.4, y: 0.5), end: .init(x: 0.6, y: 0.5))
        var value = sample
        value.wallGeometry = FloorWallGeometry(walls: [wall], openings: [opening], reviewed: true)
        let restored = try JSONDecoder().decode(GeographicOverlay.self, from: JSONEncoder().encode(value))
        XCTAssertEqual(restored.wallGeometry, value.wallGeometry)
        let map = FloorWallMap(latitude: 35, longitude: 136, width: 10, aspect: 1, angle: 0, geometry: try XCTUnwrap(restored.wallGeometry))
        XCTAssertTrue(map.isValid); XCTAssertEqual(map.barriers.count, 2)
        XCTAssertFalse(FloorWallMap.blocks(from: CGPoint(x: 0, y: -1), to: CGPoint(x: 0, y: 1), barriers: map.barriers), "The marked doorway stays passable")
        XCTAssertTrue(FloorWallMap.blocks(from: CGPoint(x: -2, y: -1), to: CGPoint(x: -2, y: 1), barriers: map.barriers))
        XCTAssertTrue(FloorWallMap.blocks(from: CGPoint(x: -3, y: 0), to: CGPoint(x: -1.5, y: 0), barriers: map.barriers), "Collinear overlap blocks too")
        XCTAssertFalse(FloorWallMap.blocks(from: CGPoint(x: -10, y: 0), to: CGPoint(x: -8, y: 0), barriers: map.barriers))
        var unreviewed = map.geometry; unreviewed.reviewed = false
        XCTAssertFalse(FloorWallMap(latitude: 35, longitude: 136, width: 10, aspect: 1, angle: 0, geometry: unreviewed).isValid)
        var invalid = map.geometry; invalid.walls[0].start.x = .nan
        XCTAssertFalse(invalid.isValid)
        let rotated = FloorWallMap(latitude: 35, longitude: 136, width: 10, aspect: 1, angle: 90, geometry: map.geometry)
        let east = rotated.local(latitude: 35, longitude: 136 + 2 / (111319.49079327358 * cos(35 * .pi / 180)))
        XCTAssertEqual(east.x, 0, accuracy: 0.0001); XCTAssertEqual(east.y, -2, accuracy: 0.0001)
    }

    func testBlackWallFallbackBlankPlansAndPerpendicularDoorStrokes() throws {
        let format = UIGraphicsImageRendererFormat(); format.scale = 1
        let renderer = UIGraphicsImageRenderer(size: CGSize(width: 300, height: 200), format: format)
        let blank = renderer.image { context in
            UIColor.white.setFill(); context.fill(CGRect(x: 0, y: 0, width: 300, height: 200))
        }
        XCTAssertTrue(try FloorWallDetector.detect(XCTUnwrap(blank.pngData())).walls.isEmpty)
        let blackPlan = renderer.image { context in
            blank.draw(at: .zero)
            UIColor.black.setFill(); context.fill(CGRect(x: 30, y: 40, width: 220, height: 3))
            // A filled green furniture region must not force green-only detection.
            UIColor(red: 0.45, green: 0.58, blue: 0.28, alpha: 1).setFill()
            context.fill(CGRect(x: 60, y: 100, width: 80, height: 60))
        }
        let detected = try FloorWallDetector.detect(XCTUnwrap(blackPlan.pngData()))
        XCTAssertTrue(detected.walls.contains { $0.start.x < 0.15 && $0.end.x > 0.8 && $0.start.y < 0.25 })
        XCTAssertThrowsError(try FloorWallDetector.detect(Data("not an image".utf8)))
        let geometry = FloorWallGeometry(walls: [.init(start: .init(x: 0.1, y: 0.5), end: .init(x: 0.9, y: 0.5))],
            openings: [.init(start: .init(x: 0.5, y: 0.4), end: .init(x: 0.5, y: 0.6))], reviewed: true)
        let map = FloorWallMap(latitude: 35, longitude: 136, width: 10, aspect: 1, angle: 0, geometry: geometry)
        XCTAssertEqual(map.barriers.count, 1, "An opening must follow the wall; perpendicular strokes cannot erase it")
        XCTAssertTrue(FloorWallMap.blocks(from: CGPoint(x: 0, y: -1), to: CGPoint(x: 0, y: 1), barriers: map.barriers))
    }

    func testBundledPlanWallDetectionProducesReviewableDraft() throws {
        let url = try XCTUnwrap(Bundle.main.url(forResource: "default-floor-overlay", withExtension: "json"))
        let plan = try JSONDecoder().decode(GeographicOverlay.self, from: Data(contentsOf: url))
        let detected = try FloorWallDetector.detect(plan.image)
        XCTAssertTrue(detected.isValid); XCTAssertFalse(detected.reviewed)
        XCTAssertGreaterThan(detected.walls.count, 10)
        XCTAssertLessThan(detected.walls.count, 500)
        let source = try XCTUnwrap(UIImage(data: plan.image))
        let format = UIGraphicsImageRendererFormat(); format.scale = 1
        let preview = UIGraphicsImageRenderer(size: source.size, format: format).image { renderer in
            source.draw(at: .zero)
            let context = renderer.cgContext
            context.setStrokeColor(UIColor.red.withAlphaComponent(0.75).cgColor); context.setLineWidth(2)
            for wall in detected.walls {
                context.move(to: CGPoint(x: wall.start.x * source.size.width, y: wall.start.y * source.size.height))
                context.addLine(to: CGPoint(x: wall.end.x * source.size.width, y: wall.end.y * source.size.height)); context.strokePath()
            }
        }
        let output = URL(fileURLWithPath: NSTemporaryDirectory()).appendingPathComponent("contour-wall-detection-preview.png")
        try preview.pngData()?.write(to: output)
        print("Wall detection: \(detected.walls.count) candidates. Preview: \(output.path)")
    }

    @MainActor
    func testDetailsOverlayEntryRemainsWithoutBottomButton() throws {
        let delegate = try XCTUnwrap(UIApplication.shared.delegate as? AppDelegate)
        let root = try XCTUnwrap(delegate.window?.rootViewController as? ContourViewController)
        root.loadViewIfNeeded()
        root.view.layoutIfNeeded()
        func findButton(in view: UIView) -> UIButton? {
            if let button = view as? UIButton, button.accessibilityIdentifier == "nativeFloorOverlayButton" { return button }
            return view.subviews.lazy.compactMap { findButton(in: $0) }.first
        }
        XCTAssertNil(findButton(in: root.view))
        XCTAssertEqual(root.web.frame.maxY, root.view.safeAreaLayoutGuide.layoutFrame.maxY, accuracy: 1)
        if #available(iOS 17.0, *) {
            root.perform(NSSelectorFromString("openFloorOverlay"))
            XCTAssertTrue(root.presentedViewController is UIHostingController<NativeFloorOverlay>)
            root.dismiss(animated: false)
        }
    }

    @MainActor
    func testNativeSavedOverlayAndPinsReachActualMapAfterLoadSaveAndReload() async throws {
        let delegate = try XCTUnwrap(UIApplication.shared.delegate as? AppDelegate)
        let root = delegate.controller
        root.loadViewIfNeeded()
        let originalProvider = root.floorOverlayJSON
        defer { root.floorOverlayJSON = originalProvider; NotificationCenter.default.post(name: NativeFloorOverlayTransfer.savedNotification, object: nil) }
        var value = sample
        value.image = try XCTUnwrap(UIGraphicsImageRenderer(size: CGSize(width: 100, height: 50)).image { context in
            UIColor.white.setFill(); context.fill(CGRect(x: 0, y: 0, width: 100, height: 50))
        }.pngData())
        value.destinations = [FloorDestination(name: "Restored Room A", x: 0.3, y: 0.4)]
        var json = String(decoding: try JSONEncoder().encode(value), as: UTF8.self)
        root.floorOverlayJSON = { json }
        let page = try XCTUnwrap(Bundle.main.url(forResource: "contour", withExtension: "html"))
        root.web.loadFileURL(page, allowingReadAccessTo: page.deletingLastPathComponent())
        let loadDeadline = Date().addingTimeInterval(15)
        while Date() < loadDeadline {
            if !root.web.isLoading,
               (try? await root.web.evaluateJavaScript("document.readyState === 'complete' && !!document.getElementById('libraryMaps')")) as? Bool == true { break }
            try await Task.sleep(nanoseconds: 100_000_000)
        }
        let hasFloorViewer = try await root.web.evaluateJavaScript("!!document.getElementById('libraryMaps')") as? Bool
        XCTAssertEqual(hasFloorViewer, true)
        func waitForMap(imageCount: Int, pinCount: Int) async throws {
            let deadline = Date().addingTimeInterval(12)
            while Date() < deadline {
                if let state = try? await root.web.evaluateJavaScript("JSON.stringify([document.querySelectorAll('.contour-native-floor-plan').length, document.querySelectorAll('.contour-floor-pin').length])") as? String,
                   state == "[\(imageCount),\(pinCount)]" { return }
                try await Task.sleep(nanoseconds: 100_000_000)
            }
            XCTFail("Native saved floor image/pins did not reach the real bundled map: expected \(imageCount), \(pinCount)")
        }
        try await waitForMap(imageCount: 0, pinCount: 0)
        _ = try await root.web.evaluateJavaScript("""
            document.getElementById('q').value = 'Central Library'; document.getElementById('q').dispatchEvent(new Event('input', { bubbles: true }));
            document.querySelector('.card:not(.hide) .det').click(); true;
            """)
        let deadline = Date().addingTimeInterval(12)
        while Date() < deadline {
            if (try? await root.web.evaluateJavaScript("document.activeElement === document.getElementById('closeBtn')")) as? Bool == true { break }
            try await Task.sleep(nanoseconds: 100_000_000)
        }
        _ = try await root.web.evaluateJavaScript("document.getElementById('indoorBtn').click(); true;")
        try await waitForMap(imageCount: 0, pinCount: 1)
        let layout = try await root.web.evaluateJavaScript("""
            (() => {
              const root = document.getElementById('libraryMaps').getBoundingClientRect();
              const card = document.querySelector('.contour-route-card').getBoundingClientRect();
              const map = document.querySelector('.contour-start-map').getBoundingClientRect();
              const sheet = document.querySelector('.contour-floor-controls').getBoundingClientRect();
              return card.width > 0 && card.left >= root.left && card.right <= root.right + 1 &&
                map.height > root.height * 0.5 && map.bottom <= sheet.top + 2 && sheet.bottom <= root.bottom + 2 &&
                !!document.querySelector('.contour-route-card select[aria-label="Starting point"]') &&
                !!document.querySelector('.contour-route-card select[aria-label="Saved floor destinations"]');
            })()
            """) as? Bool
        XCTAssertEqual(layout, true, "Route fields must fit the native viewport, with a large map and unobscured map footer above the route sheet")
        let source = try await root.web.evaluateJavaScript("document.getElementById('libraryMapImage').getAttribute('src')") as? String
        XCTAssertEqual(source, "data:image/png;base64," + value.image.base64EncodedString())
        let mainPins = try await root.web.evaluateJavaScript("document.querySelectorAll('#map .contour-floor-pin').length") as? Int
        XCTAssertEqual(mainPins, 0)
        let name = try await root.web.evaluateJavaScript("document.querySelector('.contour-floor-pin')?.getAttribute('aria-label')") as? String
        XCTAssertEqual(name, "Choose starting point Restored Room A")
        value.visible = false; json = String(decoding: try JSONEncoder().encode(value), as: UTF8.self)
        NotificationCenter.default.post(name: NativeFloorOverlayTransfer.savedNotification, object: nil)
        try await waitForMap(imageCount: 0, pinCount: 1)
        _ = try await root.web.evaluateJavaScript("document.getElementById('libraryMapClose').click(); true;")
        try await waitForMap(imageCount: 0, pinCount: 0)
        value.visible = true; json = String(decoding: try JSONEncoder().encode(value), as: UTF8.self)
        root.web.reload()
        try await waitForMap(imageCount: 0, pinCount: 0)
    }

    @MainActor
    func testDetailsReadingPositionSurvivesNativeGPSUpdatesInWebKit() async throws {
        let delegate = try XCTUnwrap(UIApplication.shared.delegate as? AppDelegate)
        let root = delegate.controller
        root.loadViewIfNeeded()
        let page = try XCTUnwrap(Bundle.main.url(forResource: "contour", withExtension: "html"))
        root.web.loadFileURL(page, allowingReadAccessTo: page.deletingLastPathComponent())
        func waitFor(_ expression: String) async throws {
            let deadline = Date().addingTimeInterval(12)
            while Date() < deadline {
                if (try? await root.web.evaluateJavaScript(expression)) as? Bool == true { return }
                try await Task.sleep(nanoseconds: 100_000_000)
            }
            XCTFail("WebKit Details condition failed: \(expression)")
        }
        try await waitFor("!!document.querySelector('.card .det')")
        _ = try await root.web.evaluateJavaScript("""
            document.getElementById('phone').style.height = '620px';
            document.getElementById('q').value = 'Central Library'; document.getElementById('q').dispatchEvent(new Event('input', { bubbles: true }));
            document.querySelector('.card:not(.hide) .det').click();
            """)
        try await waitFor("document.activeElement === document.getElementById('closeBtn')")
        let scrollable = try await root.web.evaluateJavaScript("document.getElementById('detail').scrollHeight - document.getElementById('detail').clientHeight > 80") as? Bool
        XCTAssertEqual(scrollable, true)
        _ = try await root.web.evaluateJavaScript("document.getElementById('detail').scrollTop = 80; window.__detailsPhoto = document.querySelector('#dPhoto img'); true;")
        for index in 0..<6 {
            _ = try await root.web.evaluateJavaScript("window.contourIOSLocation({coords:{latitude:35.15+\(index)*0.0003,longitude:136.96,accuracy:8},timestamp:Date.now()});")
            let offset = try await root.web.evaluateJavaScript("document.getElementById('detail').scrollTop") as? Double
            XCTAssertEqual(try XCTUnwrap(offset), 80, accuracy: 1)
        }
        let samePhoto = try await root.web.evaluateJavaScript("window.__detailsPhoto === document.querySelector('#dPhoto img')") as? Bool
        XCTAssertEqual(samePhoto, true)
        // Simulate an older hosted page's layout callback on the actual WKWebView.
        _ = try await root.web.evaluateJavaScript("""
            navigator.geolocation.watchPosition(() => {
              const detail = document.getElementById('detail');
              const height = detail.style.height; detail.style.height = 'auto'; void detail.offsetHeight; detail.style.height = height;
            });
            window.contourIOSLocation({coords:{latitude:35.151,longitude:136.96,accuracy:8},timestamp:Date.now()});
            """)
        let protectedOffset = try await root.web.evaluateJavaScript("document.getElementById('detail').scrollTop") as? Double
        XCTAssertEqual(try XCTUnwrap(protectedOffset), 80, accuracy: 1)
        _ = try await root.web.evaluateJavaScript("document.getElementById('closeBtn').click();")
    }

    func testAllCornerResizesKeepOppositeCornerFixedAfterRotation() {
        for angle in [0.0, 35, -90] {
            for corner in [CGPoint(x:-1,y:-1), CGPoint(x:1,y:-1), CGPoint(x:-1,y:1), CGPoint(x:1,y:1)] {
                let a = angle * .pi / 180
                let dx = Double(corner.x) * cos(a) - Double(corner.y) * 0.5 * sin(a)
                let dy = Double(corner.x) * sin(a) + Double(corner.y) * 0.5 * cos(a)
                let result = OverlayCornerGeometry.resize(center: CGPoint(x:200,y:300), width:100, aspect:0.5,
                    angle:angle, corner:corner, translation:CGPoint(x:dx * 50,y:dy * 50), minimumWidth:1, maximumWidth:1000)
                XCTAssertEqual(result.width,150,accuracy:0.0001)
                XCTAssertEqual(Double(result.center.x) - dx * result.width / 2,200 - dx * 50,accuracy:0.0001)
                XCTAssertEqual(Double(result.center.y) - dy * result.width / 2,300 - dy * 50,accuracy:0.0001)
            }
        }
        let clamped = OverlayCornerGeometry.resize(center:.zero,width:100,aspect:1,angle:0,
            corner:CGPoint(x:1,y:1),translation:CGPoint(x:-200,y:-200),minimumWidth:10,maximumWidth:1000)
        XCTAssertEqual(clamped.width,10)
        XCTAssertEqual(clamped.center.x - clamped.width / 2,-50)
    }

    @MainActor
    func testEditingKeepsMapInteractiveAndProvidesFourSeparateCornerHandles() throws {
        let renderer = UIGraphicsImageRenderer(size:CGSize(width:100,height:50))
        var value = sample
        value.destinations = [FloorDestination(name: "Room A", x: 0.2, y: 0.7)]
        value.image = try XCTUnwrap(renderer.image { context in
            UIColor.white.setFill(); context.fill(CGRect(x:0,y:0,width:100,height:50))
        }.pngData())
        let host = UIHostingController(rootView: GeographicOverlayMap(value:value,editing:true,focusID:UUID(),
            center:.constant(CLLocationCoordinate2D(latitude:35,longitude:137)),changed:{ _ in }))
        let scene = try XCTUnwrap(UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }.first)
        let previous = scene.windows.first { $0.isKeyWindow }
        let window = UIWindow(windowScene:scene)
        window.rootViewController = host; window.makeKeyAndVisible()
        defer { window.isHidden = true; previous?.makeKeyAndVisible() }
        host.view.layoutIfNeeded()
        RunLoop.main.run(until:Date(timeIntervalSinceNow:0.1))
        host.view.layoutIfNeeded()
        func findMap(_ view:UIView) -> MKMapView? {
            if let map = view as? MKMapView { return map }
            return view.subviews.lazy.compactMap { findMap($0) }.first
        }
        let map = try XCTUnwrap(findMap(host.view))
        let coordinator = try XCTUnwrap(map.delegate as? GeographicOverlayMap.Coordinator)
        coordinator.render()
        XCTAssertTrue(map.isScrollEnabled); XCTAssertTrue(map.isZoomEnabled)
        XCTAssertFalse(coordinator.image.isDescendant(of:map))
        XCTAssertEqual(coordinator.handles.count,4)
        let pin = try XCTUnwrap(value.destinations?.first)
        let pinButton = try XCTUnwrap(coordinator.pinButtons[pin.id])
        XCTAssertFalse(pinButton.isHidden)
        XCTAssertEqual(pinButton.accessibilityLabel, "Room A")
        let before = pinButton.center
        var rotated = value; rotated.rotate(to: 90); rotated.resize(to: 120)
        coordinator.parent.value = rotated; coordinator.render()
        let expected = coordinator.image.convert(CGPoint(x: 0.2 * coordinator.image.bounds.width,
            y: 0.7 * coordinator.image.bounds.height), to: coordinator.container)
        XCTAssertEqual(pinButton.center.x, expected.x, accuracy: 0.01)
        XCTAssertEqual(pinButton.center.y, expected.y, accuracy: 0.01)
        XCTAssertNotEqual(pinButton.center, before)

        for handle in coordinator.handles {
            XCTAssertFalse(handle.isHidden)
            XCTAssertEqual(handle.bounds.width,44)
            XCTAssertEqual(handle.bounds.height,44)
            XCTAssertFalse(handle.isDescendant(of:map))
            XCTAssertTrue(handle.gestureRecognizers?.contains { $0 is UIPanGestureRecognizer } == true)
            let container = try XCTUnwrap(coordinator.container)
            let hit = try XCTUnwrap(container.hitTest(handle.center,with:nil))
            XCTAssertTrue(hit === handle || hit.isDescendant(of:handle))
        }
    }

    func testBundledFloorOverlayContainsSavedImageAndValidAlignment() throws {
        let url = try XCTUnwrap(Bundle.main.url(forResource:"default-floor-overlay",withExtension:"json"))
        let value = try JSONDecoder().decode(GeographicOverlay.self,from:Data(contentsOf:url))
        XCTAssertTrue(value.isValid)
        let image = try XCTUnwrap(UIImage(data:value.image))
        XCTAssertGreaterThan(image.size.width,100)
        XCTAssertEqual(value.width,72.81804487261522,accuracy:0.00001)
        XCTAssertEqual(value.angle,26.552532957975586,accuracy:0.00001)
    }

    func testLegacyOverlayAndReviewedPinsRoundTrip() throws {
        var value = sample
        value.destinations = [FloorDestination(name: "Room A", x: 0.2, y: 0.7, confidence: 0.8)]
        value.rotate(to: 70); value.resize(to: 120); value.nudge(east: 5, north: 3)
        let decoded = try JSONDecoder().decode(GeographicOverlay.self, from: JSONEncoder().encode(value))
        XCTAssertEqual(decoded.destinations, value.destinations)
        XCTAssertTrue(decoded.isValid)
        var object = try XCTUnwrap(JSONSerialization.jsonObject(with: JSONEncoder().encode(sample)) as? [String: Any])
        object.removeValue(forKey: "destinations")
        let old = try JSONDecoder().decode(GeographicOverlay.self, from: JSONSerialization.data(withJSONObject: object))
        XCTAssertNil(old.destinations); XCTAssertTrue(old.isValid)
        XCTAssertEqual(old.floorName, "2F")
        var otherFloor = old; otherFloor.floor = "3F"
        XCTAssertEqual(try JSONDecoder().decode(GeographicOverlay.self, from: JSONEncoder().encode(otherFloor)).floorName, "3F")
        otherFloor.floor = "99F"; XCTAssertFalse(otherFloor.isValid)
        let duplicate = value.destinations![0]
        value.destinations?.append(duplicate)
        XCTAssertFalse(value.isValid, "Duplicate pin IDs must not enter storage")
    }
    func testOCRCoordinatesAndInvalidSuggestions() throws {
        let pin = try XCTUnwrap(FloorDestination.recognized(name: "  Room   A  ",
            boundingBox: CGRect(x: 0.1, y: 0.7, width: 0.2, height: 0.1), confidence: 0.8))
        XCTAssertEqual(pin.name, "Room A")
        XCTAssertEqual(pin.x, 0.2, accuracy: 0.000001)
        XCTAssertEqual(pin.y, 0.25, accuracy: 0.000001)
        XCTAssertNil(FloorDestination.recognized(name: "---", boundingBox: .zero, confidence: 0.9))
        XCTAssertNil(FloorDestination.recognized(name: "A", boundingBox: CGRect(x: 2, y: 0, width: 1, height: 1), confidence: 0.9))
        var invalid = pin; invalid.x = .nan; XCTAssertFalse(invalid.isValid)
        invalid = pin; invalid.name = "  "; XCTAssertFalse(invalid.isValid)
    }
    @MainActor
    func testVisionRecognizesPrintedLabelsWithoutAnExternalModel() async throws {
        let renderer = UIGraphicsImageRenderer(size: CGSize(width: 900, height: 500))
        let data = try XCTUnwrap(renderer.image { context in
            UIColor.white.setFill(); context.fill(CGRect(x: 0, y: 0, width: 900, height: 500))
            let attributes: [NSAttributedString.Key: Any] = [.font: UIFont.systemFont(ofSize: 60, weight: .bold), .foregroundColor: UIColor.black]
            ("ROOM 201" as NSString).draw(at: CGPoint(x: 60, y: 60), withAttributes: attributes)
            ("EXIT B" as NSString).draw(at: CGPoint(x: 60, y: 350), withAttributes: attributes)
        }.pngData())
        let start = Date()
        let pins = try await OverlayDisk.shared.detectLabels(data)
        let room = try XCTUnwrap(pins.first { $0.name.contains("201") })
        let exit = try XCTUnwrap(pins.first { $0.name.contains("EXIT") })
        XCTAssertLessThan(room.y, 0.4); XCTAssertGreaterThan(exit.y, 0.6)
        XCTAssertTrue(pins.allSatisfy(\.isValid))
        print("Synthetic floor OCR: \(pins.count) labels in \(Date().timeIntervalSince(start)) seconds (simulator)")
        let url = try XCTUnwrap(Bundle.main.url(forResource: "default-floor-overlay", withExtension: "json"))
        let floor = try JSONDecoder().decode(GeographicOverlay.self, from: Data(contentsOf: url))
        let actual = try await OverlayDisk.shared.detectLabels(floor.image)
        XCTAssertFalse(actual.isEmpty, "The bundled library plan should produce reviewable text")
        let reloaded = FloorLabelDeduplicator.deduplicate(actual)
        XCTAssertEqual(reloaded.count, actual.count)
        for (before, after) in zip(actual, reloaded) {
            XCTAssertTrue(before == after, "Reload changed \(before.name) into \(after.name)")
        }
        print("Bundled floor OCR: \(actual.count) suggestions; first labels: \(actual.prefix(8).map(\.name))")
    }

    func testBilingualCaptionsProduceOnePinAndRetainBothNames() throws {
        func label(_ name: String, x: Double, y: Double, width: Double = 0.16) throws -> FloorDestination {
            try XCTUnwrap(FloorDestination.recognized(name: name,
                boundingBox: CGRect(x: x, y: 1 - y - 0.02, width: width, height: 0.02), confidence: 0.9))
        }
        let jp = try label("セミナールーム", x: 0.2, y: 0.2)
        let en = try label("Seminar Room", x: 0.2, y: 0.225)
        let otherJP = try label("セミナールーム", x: 0.6, y: 0.7)
        let otherEN = try label("Seminar Room", x: 0.6, y: 0.725)
        let result = FloorLabelDeduplicator.deduplicate([jp, en, otherJP, otherEN])
        XCTAssertEqual(result.count, 2, "Translations merge, different rooms with the same name stay separate")
        XCTAssertTrue(result.allSatisfy { $0.name == "Seminar Room" })
        XCTAssertTrue(result.allSatisfy { $0.sourceLabels?.contains("セミナールーム") == true })
        XCTAssertEqual(result[0].id, en.id)
        let rerun = FloorLabelDeduplicator.merge(existing: [jp, en], detected: [jp, en])
        XCTAssertEqual(rerun.count, 1); XCTAssertEqual(rerun[0].id, en.id)
        XCTAssertEqual(FloorLabelDeduplicator.deduplicate(result), result, "Repeated loading must be idempotent")
        let separate = try label("Work Pods", x: 0.6, y: 0.225)
        XCTAssertEqual(FloorLabelDeduplicator.deduplicate([jp, separate]).count, 2)
        let japaneseOnly = try label("受付", x: 0.3, y: 0.8)
        XCTAssertEqual(FloorLabelDeduplicator.deduplicate([japaneseOnly]).map(\.name), [japaneseOnly.name])
    }
    func testMultilineCaptionAndLegacySavedTranslationCleanup() throws {
        let a = try XCTUnwrap(FloorDestination.recognized(name: "Reference", boundingBox: CGRect(x: 0.2, y: 0.7, width: 0.1, height: 0.02), confidence: 0.9))
        let b = try XCTUnwrap(FloorDestination.recognized(name: "Books", boundingBox: CGRect(x: 0.22, y: 0.677, width: 0.06, height: 0.02), confidence: 0.9))
        let result = FloorLabelDeduplicator.deduplicate([a, b])
        XCTAssertEqual(result.count, 1); XCTAssertEqual(result[0].name, "Reference Books")
        let oldJP = FloorDestination(name: "参考図書", x: 0.25, y: 0.28)
        let oldEN = FloorDestination(name: "Reference Books", x: 0.25, y: 0.305)
        let migrated = FloorLabelDeduplicator.deduplicate([oldJP, oldEN])
        XCTAssertEqual(migrated.count, 1); XCTAssertEqual(migrated[0].id, oldEN.id)
        let merged = FloorLabelDeduplicator.merge(existing: [oldJP, oldEN], detected: result)
        XCTAssertEqual(merged.count, 1); XCTAssertEqual(merged[0].id, oldEN.id)
    }

    private var sample: GeographicOverlay {
        GeographicOverlay(name: "2F", image: Data([1, 2, 3]), latitude: 35, longitude: 137, width: 60, aspect: 0.5)
    }
    func testRoundTripRetainsAlignmentAndVisibility() throws {
        var value = sample
        value.rotate(to: 390); value.opacity = 0.4; value.visible = false
        let decoded = try JSONDecoder().decode(GeographicOverlay.self, from: JSONEncoder().encode(value))
        XCTAssertEqual(decoded, value)
        XCTAssertEqual(decoded.angle, 30)
        XCTAssertTrue(decoded.isValid)
    }
    func testResizePreservesAspectAndBoundsBothDimensions() {
        var value = sample
        value.aspect = 4
        value.resize(to: 900)
        XCTAssertEqual(value.width, 500)
        XCTAssertEqual(value.height, 2000)
        value.resize(to: -10)
        XCTAssertEqual(value.width, 1)
        XCTAssertTrue(value.isValid)
    }
    func testRejectInvalidCoordinatesAndDimensions() {
        var value = sample
        value.latitude = .nan; XCTAssertFalse(value.isValid)
        value = sample; value.longitude = 181; XCTAssertFalse(value.isValid)
        value = sample; value.width = .infinity; XCTAssertFalse(value.isValid)
        value = sample; value.aspect = 0; XCTAssertFalse(value.isValid)
        value = sample; value.opacity = 0; XCTAssertFalse(value.isValid)
    }
    func testNudgeGroundMetresAndWrapLongitude() {
        var value = sample
        value.nudge(east: 0.5, north: 0.5)
        let north = (value.latitude - sample.latitude) * .pi / 180 * 6_378_137
        let east = (value.longitude - sample.longitude) * .pi / 180 * 6_378_137 * cos(value.latitude * .pi / 180)
        XCTAssertEqual(north, 0.5, accuracy: 0.00001)
        XCTAssertEqual(east, 0.5, accuracy: 0.00001)
        value.longitude = 179.999999; value.nudge(east: 1, north: 0)
        XCTAssertTrue(value.isValid); XCTAssertLessThan(value.longitude, 0)
    }
}
