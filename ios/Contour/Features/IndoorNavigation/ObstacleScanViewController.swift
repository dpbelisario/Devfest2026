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
        if valid.count >= 18 && !valid.contains(where: { $0 <= 1.2 }) && valid[valid.count / 5] > 1.5 { return .farther }
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

    static func guidance(center:Evidence,left:Evidence,right:Evidence,relative:Float)->String {
        guard relative.isFinite else { return "scan" }
        if center == .near { return cue(center:center,left:left,right:right) }
        guard center == .farther else { return "scan" }
        if abs(relative) <= .pi/6 { return "forward" }
        let desired = relative > 0 ? right : left
        let other = relative > 0 ? left : right
        if desired == .farther { return relative > 0 ? "right" : "left" }
        if desired == .near && other == .farther { return relative > 0 ? "left" : "right" }
        return "scan"
    }

}

final class ObstacleScanViewController: UIViewController, ARSessionDelegate, ARSCNViewDelegate {
    var exitDemo = false
    var completion: ((String, String) -> Void)?
    private let scene = ARSCNView()
    private let status = UILabel()
    private let arrow = UILabel()
    private let review = UIButton(type:.system)
    private var nearFrames = 0
    private let directionArrow = SCNNode()
    private var goalYaw: Float?
    private var stableCue = "scan"
    private var cueFrames = 0
    private var lastUpdate: TimeInterval = 0
    private var observers: [NSObjectProtocol] = []
    private var reason = "unknown"

    override func viewDidLoad() {
        super.viewDidLoad()
        view.backgroundColor = .black
        scene.translatesAutoresizingMaskIntoConstraints = false
        scene.session.delegate = self
        scene.delegate = self
        view.addSubview(scene)
        let heading = UILabel()
        heading.text = "Library exit AR · LiDAR"
        heading.textColor = .white
        heading.font = .preferredFont(forTextStyle: .headline)
        status.textColor = .white
        status.numberOfLines = 3
        status.font = .preferredFont(forTextStyle: .body)
        status.text = "Exit · 2F entrance. Starting direction assumed for this demo. Scanning nearby obstacles…"
        review.setTitle("Review possible obstacle",for:.normal)
        review.isEnabled = false
        review.isHidden = exitDemo
        review.addTarget(self,action:#selector(finishBlocked),for:.touchUpInside)
        let back = UIButton(type: .system)
        back.setTitle("Close", for: .normal)
        back.addTarget(self, action: #selector(finishUnknown), for: .touchUpInside)
        arrow.text = "Scan slowly"
        arrow.textColor = .white
        arrow.font = .systemFont(ofSize: 22, weight: .semibold)
        arrow.textAlignment = .center
        // Reuse the normal AR screen's five white chevrons, on a camera-relative plane.
        for index in 0..<5 {
            let path = UIBezierPath()
            for (i, point) in [CGPoint(x:36,y:4), CGPoint(x:70,y:38), CGPoint(x:58,y:50), CGPoint(x:36,y:28), CGPoint(x:14,y:50), CGPoint(x:2,y:38)].enumerated() {
                let p = CGPoint(x:(point.x-36)/100,y:(54-point.y)/100)
                if i == 0 { path.move(to:p) } else { path.addLine(to:p) }
            }
            path.close()
            let chevron = SCNNode(geometry: SCNShape(path:path,extrusionDepth:0.01))
            chevron.eulerAngles.x = -.pi / 2
            chevron.position.z = -Float(index)*0.55
            chevron.geometry?.firstMaterial?.diffuse.contents = UIColor.white
            chevron.geometry?.firstMaterial?.lightingModel = .constant
            chevron.geometry?.firstMaterial?.isDoubleSided = true
            let pulse = SCNAction.sequence([.fadeOpacity(to:0.3,duration:0.8),.fadeOpacity(to:1,duration:0.8)])
            chevron.runAction(.repeatForever(.sequence([.wait(duration:Double(index)*0.17),pulse])))
            directionArrow.addChildNode(chevron)
        }
        scene.scene.rootNode.addChildNode(directionArrow)
        directionArrow.isHidden = true
        let panel = UIStackView(arrangedSubviews: [heading, arrow, status, review, back])
        panel.axis = .vertical; panel.spacing = 10
        panel.backgroundColor = UIColor.black.withAlphaComponent(0.8)
        panel.isLayoutMarginsRelativeArrangement = true
        panel.layoutMargins = UIEdgeInsets(top:16,left:16,bottom:16,right:16)
        panel.translatesAutoresizingMaskIntoConstraints = false
        view.addSubview(panel)
        NSLayoutConstraint.activate([
            scene.leadingAnchor.constraint(equalTo:view.leadingAnchor),scene.trailingAnchor.constraint(equalTo:view.trailingAnchor),
            scene.topAnchor.constraint(equalTo:view.topAnchor),scene.bottomAnchor.constraint(equalTo:view.bottomAnchor),
            panel.leadingAnchor.constraint(equalTo:view.safeAreaLayoutGuide.leadingAnchor),panel.trailingAnchor.constraint(equalTo:view.safeAreaLayoutGuide.trailingAnchor),
            panel.bottomAnchor.constraint(equalTo:view.safeAreaLayoutGuide.bottomAnchor)
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
        guard ARWorldTrackingConfiguration.isSupported, ARWorldTrackingConfiguration.supportsFrameSemantics(.sceneDepth) else { status.text = "This exit AR demo requires an iPhone with LiDAR. Use Library floor maps on this device."; return }
        let config = ARWorldTrackingConfiguration()
        config.planeDetection = [.horizontal, .vertical]
        config.frameSemantics.insert(.sceneDepth)
        if ARWorldTrackingConfiguration.supportsSceneReconstruction(.mesh) { config.sceneReconstruction = .mesh }
        goalYaw = nil
        nearFrames = 0; review.isEnabled = false; cueFrames = 0; stableCue = "scan"
        scene.session.run(config, options: [.resetTracking, .removeExistingAnchors])
    }

    func pause() { scene.session.pause(); nearFrames = 0; review.isEnabled = false; goalYaw = nil; directionArrow.isHidden = true; arrow.text = "Scan slowly"; cueFrames = 0; stableCue = "scan"; reason = "unknown" }

    func session(_ session: ARSession, didUpdate frame: ARFrame) {
        guard frame.timestamp - lastUpdate >= 0.2 else { return }
        lastUpdate = frame.timestamp
        DispatchQueue.main.async { [weak self] in self?.inspect(frame) }
    }

    private func inspect(_ frame: ARFrame) {
        guard UIApplication.shared.applicationState == .active, view.window != nil else { return }
        guard case .normal = frame.camera.trackingState, CACurrentMediaTime() - frame.timestamp < 0.6,
              abs(frame.camera.transform.columns.2.y) < 0.35 else {
            nearFrames = 0; review.isEnabled = false
            directionArrow.isHidden = true; arrow.text = "Scan slowly"; cueFrames = 0
            status.text = "Tracking uncertain or camera tilted. Hold upright, level, and slowly scan."
            return
        }
        let heading = atan2(-frame.camera.transform.columns.2.x, frame.camera.transform.columns.2.z)
        // shortcut: opening camera direction stands in for exit bearing, replace after library pose registration.
        if goalYaw == nil { goalYaw = heading }
        guard let goalYaw else { return }
        let relative = atan2(sin(goalYaw-heading),cos(goalYaw-heading))
        renderArrow(frame, heading:heading, relative:relative, cue:"scan")
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
        } else { nearFrames = 0; review.isEnabled = false; cueFrames = 0; stableCue = "scan"; status.text = "Starting direction assumed · waiting for LiDAR depth. Scan slowly."; return }
        nearFrames = evidence[1] == .near ? nearFrames+1 : 0
        review.isEnabled = nearFrames >= 3
        let cue = ObstacleProbe.guidance(center:evidence[1],left:evidence[0],right:evidence[2],relative:relative)
        cueFrames = cue == stableCue ? cueFrames + 1 : 1
        stableCue = cue
        let displayed = cueFrames >= 3 ? cue : "scan"
        arrow.text = ["forward":"Continue ahead", "left":"Turn left", "right":"Turn right", "stop":"Stop", "scan":"Scan slowly"][displayed]
        status.text = displayed == "stop" ? "Nearby directions blocked. Check your surroundings." : displayed == "scan" ? "Checking depth · direction is a demo assumption." : "Exit · 2F entrance · demo direction. Check the real path as you move."
        renderArrow(frame,heading:heading,relative:relative,cue:displayed)
        if evidence[1] == .near && displayed == "scan" { directionArrow.isHidden = true }
    }

    private func renderArrow(_ frame:ARFrame,heading:Float,relative:Float,cue:String) {
        let camera = frame.camera.transform.columns.3
        let forward = frame.camera.transform.columns.2
        directionArrow.position = SCNVector3(camera.x-forward.x*0.8,camera.y-0.6,camera.z-forward.z*0.8)
        let turn:Float = cue == "left" ? -.pi/3 : cue == "right" ? .pi/3 : relative
        directionArrow.eulerAngles.y = -(heading+turn)
        directionArrow.isHidden = cue == "stop"
        // Amber is an orientation preview while evidence is missing; it never means walk forward.
        let color:UIColor = cue == "scan" ? .systemOrange : .white
        for node in directionArrow.childNodes { node.geometry?.firstMaterial?.diffuse.contents = color }
    }

    func renderer(_ renderer: SCNSceneRenderer,didAdd node:SCNNode,for anchor:ARAnchor) { drawMesh(node,anchor) }
    func renderer(_ renderer: SCNSceneRenderer,didUpdate node:SCNNode,for anchor:ARAnchor) { drawMesh(node,anchor) }
    private func drawMesh(_ node:SCNNode,_ anchor:ARAnchor) {
        guard let mesh=anchor as? ARMeshAnchor else {return}
        let vertices=mesh.geometry.vertices,faces=mesh.geometry.faces
        let source=SCNGeometrySource(buffer:vertices.buffer,vertexFormat:.float3,semantic:.vertex,vertexCount:vertices.count,dataOffset:vertices.offset,dataStride:vertices.stride)
        let data=Data(bytes:faces.buffer.contents(),count:faces.count*faces.indexCountPerPrimitive*faces.bytesPerIndex)
        let element=SCNGeometryElement(data:data,primitiveType:.triangles,primitiveCount:faces.count,bytesPerIndex:faces.bytesPerIndex)
        let geometry=SCNGeometry(sources:[source],elements:[element])
        let material=SCNMaterial();material.diffuse.contents=UIColor.systemOrange;material.transparency=0.12;material.isDoubleSided=true;material.lightingModel = .constant;material.writesToDepthBuffer=false;geometry.materials=[material]
        node.childNode(withName:"lidar-surfaces",recursively:false)?.removeFromParentNode()
        let surface=SCNNode(geometry:geometry);surface.name="lidar-surfaces";node.addChildNode(surface)
    }

    func session(_ session: ARSession, didFailWithError error: Error) {
        DispatchQueue.main.async { [weak self] in self?.pause(); self?.status.text = "Camera tracking failed. Return to the map and check your surroundings." }
    }
    func sessionWasInterrupted(_ session: ARSession) { DispatchQueue.main.async { [weak self] in self?.pause() } }
    func sessionInterruptionEnded(_ session: ARSession) { DispatchQueue.main.async { [weak self] in self?.start() } }
    @objc private func finishBlocked() {
        guard review.isEnabled, let frame=scene.session.currentFrame, CACurrentMediaTime()-frame.timestamp < 0.6 else { review.isEnabled=false; return }
        finish("blocked",reason)
    }
    @objc private func finishUnknown() { finish("unknown", "not-confirmed") }
    private func finish(_ result: String, _ reason: String) {
        let callback = completion; completion = nil; pause()
        dismiss(animated: true) { callback?(result, reason) }
    }
}
