import XCTest
import UIKit
import MapKit
import SwiftUI
@testable import Contour

final class GeographicOverlayTests: XCTestCase {
    @MainActor
    func testCurrentAppHasVisibleNativeOverlayEntryAndPresentsEditor() throws {
        let delegate = try XCTUnwrap(UIApplication.shared.delegate as? AppDelegate)
        let root = try XCTUnwrap(delegate.window?.rootViewController as? ContourViewController)
        root.loadViewIfNeeded()
        root.view.layoutIfNeeded()
        func findButton(in view: UIView) -> UIButton? {
            if let button = view as? UIButton, button.accessibilityIdentifier == "nativeFloorOverlayButton" { return button }
            return view.subviews.lazy.compactMap { findButton(in: $0) }.first
        }
        let button = try XCTUnwrap(findButton(in: root.view))
        XCTAssertFalse(button.isHidden)
        XCTAssertGreaterThanOrEqual(button.bounds.height, 44)
        let frame = button.convert(button.bounds, to: root.view)
        XCTAssertTrue(root.view.safeAreaLayoutGuide.layoutFrame.contains(frame))
        if #available(iOS 17.0, *) {
            button.sendActions(for: .touchUpInside)
            XCTAssertTrue(root.presentedViewController is UIHostingController<NativeFloorOverlay>)
            root.dismiss(animated: false)
        }
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
