import XCTest
import UIKit
import MapKit
import SwiftUI
import WebKit
@testable import Contour

final class GeographicOverlayTests: XCTestCase {
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
        try await waitForMap(imageCount: 1, pinCount: 0)
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
        try await waitForMap(imageCount: 1, pinCount: 1)
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
        try await waitForMap(imageCount: 1, pinCount: 0)
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
