import XCTest
@testable import Contour

final class ContourTests: XCTestCase {
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
        XCTAssertTrue(ContourViewController.sameOrigin(origin, URL(string: "https://example.com:443/other")!))
        for url in ["http://example.com", "https://example.com:444", "https://example.com.evil.test", "file:///app.html"] {
            XCTAssertFalse(ContourViewController.sameOrigin(origin, URL(string: url)!))
        }
    }

    func testForegroundHapticsAreStrongButBounded() {
        XCTAssertEqual(AlertHaptics.pulseCount, 12)
        XCTAssertGreaterThan(AlertHaptics.pulseSpacing, AlertHaptics.pulseDuration)
        XCTAssertLessThan(Double(AlertHaptics.pulseCount) * AlertHaptics.pulseSpacing, 10)
    }
}
