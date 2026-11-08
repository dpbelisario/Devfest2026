import XCTest
@testable import Contour

final class ContourTests: XCTestCase {
    func testContinuousDemoDirectionRequiresObservedSide() {
        XCTAssertEqual(ObstacleProbe.guidance(center:.farther,left:.unknown,right:.unknown,relative:0),"forward")
        XCTAssertEqual(ObstacleProbe.guidance(center:.farther,left:.farther,right:.near,relative:1),"left")
        XCTAssertEqual(ObstacleProbe.guidance(center:.farther,left:.unknown,right:.unknown,relative:1),"scan")
        XCTAssertEqual(ObstacleProbe.guidance(center:.near,left:.near,right:.near,relative:0),"stop")
        XCTAssertEqual(ObstacleProbe.guidance(center:.farther,left:.farther,right:.farther,relative:.nan),"scan")
    }
    func testRelativeObstacleDirectionsStopOnUnknownEvidence() {
        XCTAssertEqual(ObstacleProbe.cue(center: .farther, left: .unknown, right: .unknown), "forward")
        XCTAssertEqual(ObstacleProbe.cue(center: .near, left: .farther, right: .near), "left")
        XCTAssertEqual(ObstacleProbe.cue(center: .near, left: .near, right: .farther), "right")
        XCTAssertEqual(ObstacleProbe.cue(center: .near, left: .near, right: .near), "stop")
        XCTAssertEqual(ObstacleProbe.cue(center: .near, left: .unknown, right: .unknown), "scan")
        XCTAssertEqual(ObstacleProbe.cue(center: .unknown, left: .farther, right: .farther), "scan")
    }
    func testObstacleEvidenceNeverTreatsMissingDepthAsClear() {
        XCTAssertEqual(ObstacleProbe.depthEvidence([0.8]+Array(repeating: 2.5,count:24)), .unknown)
        XCTAssertFalse(ObstacleProbe.closeDepth([]))
        XCTAssertFalse(ObstacleProbe.closeDepth(Array(repeating: .nan, count: 40)))
        XCTAssertFalse(ObstacleProbe.closeDepth(Array(repeating: 0, count: 40)))
        XCTAssertTrue(ObstacleProbe.closeDepth(Array(repeating: 0.8, count: 40)))
        XCTAssertFalse(ObstacleProbe.closeDepth(Array(repeating: 2.5, count: 40)))
        XCTAssertFalse(ObstacleProbe.closeFeatures([SIMD3<Float>(0, 0, -0.6)]))
        XCTAssertTrue(ObstacleProbe.closeFeatures(Array(repeating: SIMD3<Float>(0.1, 0, -0.6), count: 6)))
        XCTAssertFalse(ObstacleProbe.closeFeatures(Array(repeating: SIMD3<Float>(1.2, 0, -0.6), count: 20)))
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
