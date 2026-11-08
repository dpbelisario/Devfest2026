import ARKit
import SceneKit
import UIKit

/// Close-object evidence only. Missing depth never establishes a clear passage.
enum ObstacleProbe {
    enum Evidence { case unknown, near, farther }
    static func depthEvidence(_ samples: [Float]) -> Evidence {
        let valid = samples.filter { $0.isFinite && $0 > 0.15 && $0 < 8 }.sorted()
        guard valid.count >= 12 else { return .unknown }
        if valid[valid.count / 5] < 1.2 { return .near }
        if valid[valid.count / 5] > 1.5 { return .farther }
        return .unknown
    }
    static func closeDepth(_ samples: [Float]) -> Bool { depthEvidence(samples) == .near }
    static func closeFeatures(_ points: [SIMD3<Float>]) -> Bool {
        points.filter { abs($0.x) < 0.35 && abs($0.y) < 0.35 && $0.z < -0.25 && $0.z > -1.2 }.count >= 6
    }
    static func cue(center: Evidence, left: Evidence, right: Evidence) -> String {
        if center == .farther { return "forward" }
        if center == .near {
            if left == .farther { return "left" }
            if right == .farther { return "right" }
            if left == .near && right == .near { return "stop" }
        }
        return "scan"
    }

}

final class ObstacleScanViewController: UIViewController, ARSessionDelegate {
    var completion: ((String, String) -> Void)?
    private let scene = ARSCNView()
    private let status = UILabel()
    private let arrow = UILabel()
    private var stableCue = "scan"
    private var cueFrames = 0
    private let blocked = UIButton(type: .system)
    private var lastUpdate: TimeInterval = 0
    private var closeFrames = 0
    private var observers: [NSObjectProtocol] = []
    private var reason = "unknown"

    override func viewDidLoad() {
        super.viewDidLoad()
        view.backgroundColor = .black
        scene.translatesAutoresizingMaskIntoConstraints = false
        scene.session.delegate = self
        view.addSubview(scene)
        let heading = UILabel()
        heading.text = "Relative obstacle arrows · demo"
        heading.textColor = .white
        heading.font = .preferredFont(forTextStyle: .headline)
        status.textColor = .white
        status.numberOfLines = 0
        status.font = .preferredFont(forTextStyle: .body)
        status.text = "Hold the camera upright and level. Slowly scan ahead. Detection is incomplete; keep watching your surroundings."
        let aim = UILabel()
        aim.text = "+"
        aim.font = .systemFont(ofSize: 48)
        aim.textColor = .white
        aim.translatesAutoresizingMaskIntoConstraints = false
        view.addSubview(aim)
        blocked.setTitle("Possible obstacle · review route segment", for: .normal)
        blocked.isEnabled = false
        blocked.addTarget(self, action: #selector(finishBlocked), for: .touchUpInside)
        let back = UIButton(type: .system)
        back.setTitle("Return to map · passage remains unverified", for: .normal)
        back.addTarget(self, action: #selector(finishUnknown), for: .touchUpInside)
        arrow.text = "·"
        arrow.textColor = .white
        arrow.font = .systemFont(ofSize: 72, weight: .bold)
        arrow.textAlignment = .center
        let panel = UIStackView(arrangedSubviews: [heading, arrow, status, blocked, back])
        panel.axis = .vertical
        panel.spacing = 12
        panel.backgroundColor = UIColor.black.withAlphaComponent(0.8)
        panel.isLayoutMarginsRelativeArrangement = true
        panel.layoutMargins = UIEdgeInsets(top: 16, left: 16, bottom: 16, right: 16)
        panel.translatesAutoresizingMaskIntoConstraints = false
        view.addSubview(panel)
        NSLayoutConstraint.activate([
            scene.leadingAnchor.constraint(equalTo: view.leadingAnchor), scene.trailingAnchor.constraint(equalTo: view.trailingAnchor),
            scene.topAnchor.constraint(equalTo: view.topAnchor), scene.bottomAnchor.constraint(equalTo: view.bottomAnchor),
            aim.centerXAnchor.constraint(equalTo: view.centerXAnchor), aim.centerYAnchor.constraint(equalTo: view.centerYAnchor),
            panel.leadingAnchor.constraint(equalTo: view.safeAreaLayoutGuide.leadingAnchor), panel.trailingAnchor.constraint(equalTo: view.safeAreaLayoutGuide.trailingAnchor),
            panel.bottomAnchor.constraint(equalTo: view.safeAreaLayoutGuide.bottomAnchor)
        ])
        observers.append(NotificationCenter.default.addObserver(forName: UIApplication.willResignActiveNotification, object: nil, queue: .main) { [weak self] _ in self?.pause() })
        observers.append(NotificationCenter.default.addObserver(forName: UIApplication.didBecomeActiveNotification, object: nil, queue: .main) { [weak self] _ in
            if self?.view.window != nil { self?.start() }
        })
    }

    override func viewDidAppear(_ animated: Bool) { super.viewDidAppear(animated); start() }
    override func viewWillDisappear(_ animated: Bool) { super.viewWillDisappear(animated); pause() }
    deinit { for observer in observers { NotificationCenter.default.removeObserver(observer) } }

    private func start() {
        guard ARWorldTrackingConfiguration.isSupported else { status.text = "AR tracking unavailable on this device. Use the map."; return }
        let config = ARWorldTrackingConfiguration()
        config.planeDetection = [.horizontal, .vertical]
        if ARWorldTrackingConfiguration.supportsFrameSemantics(.sceneDepth) { config.frameSemantics.insert(.sceneDepth) }
        closeFrames = 0
        blocked.isEnabled = false
        scene.session.run(config, options: [.resetTracking, .removeExistingAnchors])
    }

    func pause() { scene.session.pause(); arrow.text = "·"; cueFrames = 0; stableCue = "scan"; closeFrames = 0; blocked.isEnabled = false; reason = "unknown" }

    func session(_ session: ARSession, didUpdate frame: ARFrame) {
        guard frame.timestamp - lastUpdate >= 0.2 else { return }
        lastUpdate = frame.timestamp
        DispatchQueue.main.async { [weak self] in self?.inspect(frame) }
    }

    private func inspect(_ frame: ARFrame) {
        guard UIApplication.shared.applicationState == .active, view.window != nil else { return }
        guard case .normal = frame.camera.trackingState, CACurrentMediaTime() - frame.timestamp < 0.6,
              abs(frame.camera.transform.columns.2.y) < 0.35 else {
            closeFrames = 0; blocked.isEnabled = false; arrow.text = "·"; cueFrames = 0
            status.text = "Tracking uncertain or camera tilted. Hold upright, level, and slowly scan."
            return
        }
        var evidence = [ObstacleProbe.Evidence](repeating: .unknown, count: 3)
        if let depth = frame.sceneDepth {
            let buffer = depth.depthMap
            CVPixelBufferLockBaseAddress(buffer, .readOnly)
            if let confidence = depth.confidenceMap { CVPixelBufferLockBaseAddress(confidence, .readOnly) }
            defer {
                CVPixelBufferUnlockBaseAddress(buffer, .readOnly)
                if let confidence = depth.confidenceMap { CVPixelBufferUnlockBaseAddress(confidence, .readOnly) }
            }
            if let base = CVPixelBufferGetBaseAddress(buffer) {
                let width = CVPixelBufferGetWidth(buffer), height = CVPixelBufferGetHeight(buffer)
                let imageFromView = frame.displayTransform(for: .portrait, viewportSize: scene.bounds.size).inverted()
                for sector in 0..<3 {
                    var samples: [Float] = []
                    for rowIndex in 0..<5 {
                        for columnIndex in 0..<5 {
                            let viewPoint = CGPoint(x: 0.17 + Double(sector) * 0.25 + Double(columnIndex) * 0.04, y: 0.42 + Double(rowIndex) * 0.04)
                            let pixel = viewPoint.applying(imageFromView)
                            guard pixel.x >= 0, pixel.x < 1, pixel.y >= 0, pixel.y < 1 else { continue }
                            let x = min(width - 1, Int(pixel.x * Double(width))), y = min(height - 1, Int(pixel.y * Double(height)))
                            if let confidence = depth.confidenceMap, let cbase = CVPixelBufferGetBaseAddress(confidence) {
                                if cbase.advanced(by: y * CVPixelBufferGetBytesPerRow(confidence)).assumingMemoryBound(to: UInt8.self)[x] < 2 { continue }
                            }
                            samples.append(base.advanced(by: y * CVPixelBufferGetBytesPerRow(buffer)).assumingMemoryBound(to: Float.self)[x])
                        }
                    }
                    evidence[sector] = ObstacleProbe.depthEvidence(samples)
                }
            }
            reason = "lidar-depth"
        } else {
            // shortcut: XS Max has sparse features/planes only, blank surfaces and low obstacles may be missed.
            let viewFromWorld = frame.camera.viewMatrix(for: .portrait)
            let points = frame.rawFeaturePoints?.points.map { point -> SIMD3<Float> in
                let local = viewFromWorld * SIMD4<Float>(point.x, point.y, point.z, 1)
                return SIMD3<Float>(local.x, local.y, local.z)
            } ?? []
            for sector in 0..<3 {
                let sectorPoints = points.filter { point in
                    let depth = -point.z
                    guard depth > 0.25, depth < 5, abs(point.y) < 0.4 else { return false }
                    let ratio = point.x / depth
                    return sector == 0 ? ratio < -0.15 && ratio > -0.6 : sector == 2 ? ratio > 0.15 && ratio < 0.6 : abs(ratio) <= 0.15
                }
                if sectorPoints.filter({ -$0.z < 1.2 }).count >= 6 { evidence[sector] = .near }
                else if sectorPoints.filter({ -$0.z > 1.5 }).count >= 6 { evidence[sector] = .farther }
                if let query = scene.raycastQuery(from: CGPoint(x: scene.bounds.width * (0.25 + Double(sector) * 0.25), y: scene.bounds.midY), allowing: .existingPlaneGeometry, alignment: .vertical) {
                    let camera = frame.camera.transform.columns.3
                    for hit in scene.session.raycast(query) {
                        let target = hit.worldTransform.columns.3
                        let distance = simd_distance(SIMD3<Float>(camera.x, camera.y, camera.z), SIMD3<Float>(target.x, target.y, target.z))
                        if distance > 0.25 && distance < 1.2 { evidence[sector] = .near; break }
                        if distance > 1.5 && distance < 5 && evidence[sector] != .near { evidence[sector] = .farther }
                    }
                }
            }
            reason = "sparse-features-or-plane"
        }
        closeFrames = evidence[1] == .near ? closeFrames + 1 : 0
        blocked.isEnabled = closeFrames >= 3
        let cue = ObstacleProbe.cue(center: evidence[1], left: evidence[0], right: evidence[2])
        cueFrames = cue == stableCue ? cueFrames + 1 : 1
        stableCue = cue
        // A new blocker cancels the forward cue immediately, before a turn stabilizes.
        if evidence[1] == .near || cue == "scan" { arrow.text = "·" }
        if cueFrames >= 3 {
            arrow.text = ["forward":"↑", "left":"←", "right":"→", "stop":"×", "scan":"·"][cue]
        }
        let instruction = ["forward":"Relative forward cue · only visible samples checked.", "left":"Stop, then turn left to check. The full passage is unverified.", "right":"Stop, then turn right to check. The full passage is unverified.", "stop":"Stop. All sampled directions are close; check behind manually.", "scan":"Stop and slowly scan left / right. No reliable direction yet."][cue] ?? "Stop and scan."
        status.text = instruction + (reason == "lidar-depth" ? " LiDAR depth demo; not a collision guarantee." : " Camera-only heuristic: glass, blank walls, low objects and people may be missed.")
    }

    func session(_ session: ARSession, didFailWithError error: Error) {
        DispatchQueue.main.async { [weak self] in self?.pause(); self?.status.text = "Camera tracking failed. Return to the map and check your surroundings." }
    }
    func sessionWasInterrupted(_ session: ARSession) { DispatchQueue.main.async { [weak self] in self?.pause() } }
    func sessionInterruptionEnded(_ session: ARSession) { DispatchQueue.main.async { [weak self] in self?.start() } }
    @objc private func finishBlocked() { finish("blocked", reason) }
    @objc private func finishUnknown() { finish("unknown", "not-confirmed") }
    private func finish(_ result: String, _ reason: String) {
        let callback = completion; completion = nil; pause()
        dismiss(animated: true) { callback?(result, reason) }
    }
}
