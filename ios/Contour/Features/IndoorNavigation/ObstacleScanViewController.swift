import ARKit
import SceneKit
import UIKit
import CoreLocation
import CryptoKit
import ContourShared
import Vision

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
    static func cameraEvidence(_ depths:[Float], planeDistance:Float? = nil)->Evidence {
        let valid = depths.filter { $0.isFinite && $0 > 0.25 && $0 < 5 }
        let close = valid.filter { $0 < 1.2 }.count
        let plane = planeDistance.flatMap { $0.isFinite && $0 > 0.25 && $0 < 5 ? $0 : nil }
        if close >= 6 || (plane.map { $0 < 1.2 } ?? false) { return .near }
        // Sparse farther points cannot rule out even a small observed close obstacle.
        if close > 0 || (plane.map { $0 <= 1.5 } ?? false) { return .unknown }
        if valid.filter({$0 > 1.5}).count >= 6 || (plane.map { $0 > 1.5 } ?? false) { return .farther }
        return .unknown
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
        if center == .near {
            if relative.isFinite && relative > .pi/6 && right == .farther { return "right" }
            if relative.isFinite && relative < -.pi/6 && left == .farther { return "left" }
            return cue(center:center,left:left,right:right)
        }
        guard relative.isFinite else { return "scan" }
        // shortcut: nearby sector evidence is not a full aisle map; upgrade after on-site route surveying.
        if abs(relative) > .pi * 0.8 { return "around" }
        if center == .farther && relative > .pi/6 && right == .farther { return "right" }
        if center == .farther && relative < -.pi/6 && left == .farther { return "left" }
        guard center == .farther else { return "scan" }
        return "forward"
    }

}

/// Camera-relative chevrons stay on screen even while AR acquires observations.
final class CameraArrowsView: UIView {
    var cue = "scan" { didSet { setNeedsDisplay() } }
    override func draw(_ rect: CGRect) {
        guard let context = UIGraphicsGetCurrentContext() else { return }
        let turn:CGFloat = cue == "left" ? -.pi/3 : cue == "right" ? .pi/3 : cue == "around" ? .pi : 0
        context.translateBy(x:bounds.midX,y:bounds.height*0.65)
        for index in 0..<5 {
            context.saveGState()
            context.translateBy(x:0,y:-CGFloat(index)*bounds.height*0.055)
            context.rotate(by:turn)
            let scale=bounds.width/450*(1-CGFloat(index)*0.12)
            context.scaleBy(x:scale,y:scale*0.5)
            let path=UIBezierPath()
            for (i,p) in [CGPoint(x:0,y:-50),CGPoint(x:34,y:-16),CGPoint(x:22,y:-4),CGPoint(x:0,y:-26),CGPoint(x:-22,y:-4),CGPoint(x:-34,y:-16)].enumerated() {
                if i == 0 { path.move(to:p) } else { path.addLine(to:p) }
            }
            path.close()
            (cue == "scan" || cue == "around" ? UIColor.systemOrange : UIColor.white).setFill()
            path.fill();UIColor.black.setStroke();path.lineWidth=2;path.stroke()
            context.restoreGState()
        }
    }
}

final class ObstacleScanViewController: UIViewController, ARSessionDelegate, ARSCNViewDelegate, CLLocationManagerDelegate {
    var exitDemo = false
    var completion: ((String, String) -> Void)?
    private let scene = ARSCNView()
    private let usesDepth = ARWorldTrackingConfiguration.supportsFrameSemantics(.sceneDepth)
    private let status = UILabel()
    private let arrow = UILabel()
    private let review = UIButton(type:.system)
    private let floorBubble = UIButton(type:.system)
    private let headingBubble = UIButton(type:.system)
    private var guessedFloor = "2F"
    private var manualGoalHeading: Float?
    private var currentHeading: Float = .nan
    private var currentRelative: Float = .nan
    private var nearFrames = 0
    private let directionArrow = CameraArrowsView()
    private let location = CLLocationManager()
    private let waypointGuide = LibraryWaypointGuidance()
    private let startBubble = UIButton(type:.system)
    private var manualRouteHeading = false
    private var currentCameraX: Double = 0
    private var currentCameraZ: Double = 0
    private var planReady = false
    private var headingAt: Date?
    private var headingAccuracy: CLLocationDirection = -1
    private var stableCue = "scan"
    private var cueFrames = 0
    private var lastUpdate: TimeInterval = 0
    private var observers: [NSObjectProtocol] = []
    private var reason = "unknown"
    private let markerQueue = DispatchQueue(label: "contour.library-marker")
    private var markerBusy = false
    private var lastMarkerScan: TimeInterval = 0
    private var planAngle = LibraryExitGeometry.shared.defaultAngle
    private var lastMarker: (id: String, time: Date)?

    override func viewDidLoad() {
        super.viewDidLoad()
        location.delegate = self
        location.desiredAccuracy = kCLLocationAccuracyBest
        view.backgroundColor = .black
        scene.translatesAutoresizingMaskIntoConstraints = false
        scene.session.delegate = self
        scene.delegate = self
        view.addSubview(scene)
        let heading = UILabel()
        heading.text = usesDepth ? "Library exit AR · LiDAR" : "Library exit AR · Camera"
        heading.textColor = .white
        heading.font = .preferredFont(forTextStyle: .headline)
        status.textColor = .white
        status.numberOfLines = 3
        status.font = .preferredFont(forTextStyle: .body)
        status.text = ""
        status.isHidden = true
        floorBubble.setTitle("Floor guess · 2F · Edit",for:.normal)
        floorBubble.accessibilityIdentifier = "exitFloorGuess"
        floorBubble.addTarget(self,action:#selector(editFloor),for:.touchUpInside)
        headingBubble.setTitle("Exit direction · Edit",for:.normal)
        headingBubble.accessibilityIdentifier = "exitHeadingGuess"
        headingBubble.isEnabled = false
        headingBubble.addTarget(self,action:#selector(editHeading),for:.touchUpInside)
        startBubble.setTitle("Start guess · North-east aisle · Edit",for:.normal)
        startBubble.accessibilityIdentifier = "exitStartGuess"
        startBubble.addTarget(self,action:#selector(editStart),for:.touchUpInside)
        let guesses = UIStackView(arrangedSubviews:[floorBubble,startBubble,headingBubble])
        guesses.axis = .vertical; guesses.spacing = 4
        guesses.backgroundColor = UIColor.black.withAlphaComponent(0.8)
        guesses.layer.cornerRadius = 16
        guesses.translatesAutoresizingMaskIntoConstraints = false
        view.addSubview(guesses)
        NSLayoutConstraint.activate([
            guesses.topAnchor.constraint(equalTo:view.safeAreaLayoutGuide.topAnchor,constant:8),
            guesses.centerXAnchor.constraint(equalTo:view.centerXAnchor),
            guesses.leadingAnchor.constraint(greaterThanOrEqualTo:view.safeAreaLayoutGuide.leadingAnchor,constant:12),
            guesses.trailingAnchor.constraint(lessThanOrEqualTo:view.safeAreaLayoutGuide.trailingAnchor,constant:-12)
        ])
        review.setTitle("Review possible obstacle",for:.normal)
        review.isEnabled = false
        review.isHidden = exitDemo
        review.addTarget(self,action:#selector(finishBlocked),for:.touchUpInside)
        let back = UIButton(type: .system)
        back.setTitle("Close", for: .normal)
        back.addTarget(self, action: #selector(finishUnknown), for: .touchUpInside)
        arrow.text = "Hold"
        arrow.textColor = .white
        arrow.font = .systemFont(ofSize: 22, weight: .semibold)
        arrow.textAlignment = .center
        directionArrow.backgroundColor = .clear
        directionArrow.isOpaque = false
        directionArrow.isUserInteractionEnabled = false
        directionArrow.accessibilityIdentifier = "cameraArrows"
        directionArrow.translatesAutoresizingMaskIntoConstraints = false
        view.addSubview(directionArrow)
        NSLayoutConstraint.activate([
            directionArrow.leadingAnchor.constraint(equalTo:scene.leadingAnchor),directionArrow.trailingAnchor.constraint(equalTo:scene.trailingAnchor),
            directionArrow.topAnchor.constraint(equalTo:scene.topAnchor),directionArrow.bottomAnchor.constraint(equalTo:scene.bottomAnchor)
        ])
        // The arrow overlay must sit below the editable controls.
        view.bringSubviewToFront(guesses)
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

    @objc private func editFloor() {
        let picker = UIAlertController(title:"Current floor",message:nil,preferredStyle:.actionSheet)
        for floor in ["B1","1F","2F","3F","4F"] {
            picker.addAction(UIAlertAction(title:floor,style:.default) { [weak self] _ in
                self?.guessedFloor = floor
                self?.floorBubble.setTitle("Floor · \(floor) · Edit",for:.normal)
                self?.startBubble.isEnabled = floor == "2F"
                self?.waypointGuide.reset()
            })
        }
        picker.addAction(UIAlertAction(title:"Cancel",style:.cancel))
        picker.popoverPresentationController?.sourceView = floorBubble
        present(picker,animated:true)
    }

    @objc private func editStart() {
        let picker = UIAlertController(title:"Assumed 2F start",message:nil,preferredStyle:.actionSheet)
        for node in waypointGuide.starts {
            picker.addAction(UIAlertAction(title:node.label,style:.default) { [weak self] _ in
                guard let self else { return }
                _ = self.waypointGuide.selectStart(id:node.id)
                self.manualGoalHeading = nil; self.manualRouteHeading = false; self.cueFrames = 0
                self.startBubble.setTitle("Start guess · \(node.label) · Edit",for:.normal)
            })
        }
        picker.addAction(UIAlertAction(title:"Cancel",style:.cancel))
        picker.popoverPresentationController?.sourceView = startBubble
        present(picker,animated:true)
    }

    @objc private func editHeading() {
        let picker = UIAlertController(title:"Next waypoint from where you face",message:nil,preferredStyle:.actionSheet)
        for (label,offset) in [("Ahead",Float(0)),("Right",Float.pi/2),("Left",-Float.pi/2),("Behind",Float.pi)] {
            picker.addAction(UIAlertAction(title:label,style:.default) { [weak self] _ in
                guard let self else { return }
                self.manualGoalHeading = offset
                self.manualRouteHeading = true
                self.cueFrames = 0
            })
        }
        picker.addAction(UIAlertAction(title:"Reset route estimate",style:.default) { [weak self] _ in
            self?.manualGoalHeading = nil; self?.manualRouteHeading = false; self?.waypointGuide.reset()
        })
        picker.addAction(UIAlertAction(title:"Cancel",style:.cancel))
        picker.popoverPresentationController?.sourceView = headingBubble
        present(picker,animated:true)
    }

    private func updateHeadingBubble() {
        let bearing = currentRelative.isFinite ? abs(currentRelative) < .pi/6 ? "Ahead" : "\(Int(abs(currentRelative)*180 / .pi))° \(currentRelative > 0 ? "right" : "left")" : "Unknown"
        headingBubble.setTitle("Next \(manualRouteHeading ? "direction" : "guess") · \(bearing) · Edit",for:.normal)
    }

    override func viewDidAppear(_ animated: Bool) { super.viewDidAppear(animated); start() }
    override func viewWillDisappear(_ animated: Bool) { super.viewWillDisappear(animated); pause() }
    deinit { for observer in observers { NotificationCenter.default.removeObserver(observer) } }

    private func start() {
        guard ARWorldTrackingConfiguration.isSupported else { directionArrow.isHidden = true; status.isHidden = false; status.text = "AR camera tracking is unavailable on this phone. Use Library floor maps."; return }
        let config = ARWorldTrackingConfiguration()
        if exitDemo {
            config.worldAlignment = .gravityAndHeading
            Task { [weak self] in
                guard let json = try? await NativeFloorOverlayTransfer.json(),
                      let overlay = try? JSONDecoder().decode(GeographicOverlay.self,from:Data(json.utf8)),overlay.isValid,
                      SHA256.hash(data:overlay.image).map({String(format:"%02x",$0)}).joined() == LibraryExitGeometry.shared.imageSha256 else { return }
                guard let self else { return }
                self.planReady = self.waypointGuide.configure(width:overlay.width,aspect:overlay.aspect,angle:overlay.angle)
                if self.planReady { self.planAngle = overlay.angle }
            }
            if location.authorizationStatus == .notDetermined { location.requestWhenInUseAuthorization() }
            startLocation()
        }
        config.planeDetection = [.horizontal, .vertical]
        if usesDepth {
            config.frameSemantics.insert(.sceneDepth)
            if ARWorldTrackingConfiguration.supportsSceneReconstruction(.mesh) { config.sceneReconstruction = .mesh }
        }
        waypointGuide.reset()
        manualGoalHeading = nil; manualRouteHeading = false; currentHeading = .nan; headingBubble.isEnabled = false
        nearFrames = 0; review.isEnabled = false; cueFrames = 0; stableCue = "scan"
        directionArrow.isHidden = false; directionArrow.cue = "scan"
        scene.session.run(config, options: [.resetTracking, .removeExistingAnchors])
    }

    func pause() { scene.session.pause(); location.stopUpdatingLocation(); location.stopUpdatingHeading(); headingAt=nil; waypointGuide.reset(); nearFrames = 0; review.isEnabled = false; directionArrow.isHidden = true; arrow.text = "Hold"; cueFrames = 0; stableCue = "scan"; reason = "unknown" }

    private func startLocation() {
        guard exitDemo, view.window != nil, [.authorizedAlways,.authorizedWhenInUse].contains(location.authorizationStatus) else { return }
        location.startUpdatingLocation()
        if CLLocationManager.headingAvailable() { location.startUpdatingHeading() }
    }
    func locationManagerDidChangeAuthorization(_ manager:CLLocationManager) { startLocation() }
    func locationManager(_ manager:CLLocationManager,didUpdateHeading heading:CLHeading) {
        headingAt=heading.timestamp; headingAccuracy=heading.headingAccuracy
    }
    func locationManager(_ manager:CLLocationManager,didFailWithError error:Error) { }

    func session(_ session: ARSession, didUpdate frame: ARFrame) {
        guard frame.timestamp - lastUpdate >= 0.2 else { return }
        lastUpdate = frame.timestamp
        DispatchQueue.main.async { [weak self] in self?.inspect(frame) }
        scanMarker(frame)
    }

    /// Looks for a printed library location QR marker roughly 3 times per second. A marker is an absolute
    /// fix: its plan position and the map direction a person faces when looking straight at it.
    private func scanMarker(_ frame: ARFrame) {
        guard exitDemo, case .normal = frame.camera.trackingState, frame.timestamp - lastMarkerScan >= 0.33, !markerBusy else { return }
        lastMarkerScan = frame.timestamp; markerBusy = true
        let buffer = frame.capturedImage
        let transform = frame.camera.transform
        markerQueue.async { [weak self] in
            let sighting = LibraryMarkerDetector.detect(in: buffer)
            DispatchQueue.main.async {
                guard let self else { return }
                self.markerBusy = false
                guard let sighting else { return }
                self.applyMarker(sighting, cameraTransform: transform)
            }
        }
    }

    private func applyMarker(_ sighting: LibraryMarkerSighting, cameraTransform: simd_float4x4) {
        guard view.window != nil, exitDemo, sighting.marker.floor == "2F" else { return }
        let heading = atan2(-cameraTransform.columns.2.x, cameraTransform.columns.2.z)
        // A centred marker means the camera faces it; the marker's facing bearing then fixes AR-to-map rotation.
        let bearing = (planAngle + sighting.marker.facing) * .pi / 180
        let rotation = Double(heading) - bearing
        let camera = cameraTransform.columns.3
        guard waypointGuide.locate(imageX: sighting.marker.imageX, imageY: sighting.marker.imageY,
            cameraX: Double(camera.x), cameraZ: Double(camera.z), mapRotation: atan2(sin(rotation), cos(rotation))) else {
            status.isHidden = false
            status.text = "Location marker \(sighting.marker.label) is not on the supported 2F exit path."
            return
        }
        guessedFloor = "2F"; floorBubble.setTitle("Floor · 2F · QR", for: .normal); startBubble.isEnabled = true
        manualGoalHeading = nil; manualRouteHeading = false; cueFrames = 0
        startBubble.setTitle("Located · \(sighting.marker.label) · QR", for: .normal)
        if lastMarker?.id != sighting.marker.id || lastMarker.map({ Date().timeIntervalSince($0.time) > 10 }) == true {
            UINotificationFeedbackGenerator().notificationOccurred(.success)
            status.isHidden = false
            status.text = "Position fixed at \(sighting.marker.label). Turn toward the arrow."
            let shown = sighting.marker.id
            DispatchQueue.main.asyncAfter(deadline: .now() + 3) { [weak self] in
                if self?.lastMarker?.id == shown { self?.status.isHidden = true }
            }
        }
        lastMarker = (sighting.marker.id, Date())
    }

    private func inspect(_ frame: ARFrame) {
        guard UIApplication.shared.applicationState == .active, view.window != nil else { return }
        guard case .normal = frame.camera.trackingState, CACurrentMediaTime() - frame.timestamp < 0.6,
              abs(frame.camera.transform.columns.2.y) < 0.35 else {
            nearFrames = 0; review.isEnabled = false
            headingBubble.isEnabled = false; currentRelative = .nan; updateHeadingBubble()
            directionArrow.isHidden = false; directionArrow.cue = "scan"; arrow.text = "Hold"; cueFrames = 0
            status.text = "Tracking uncertain or camera tilted. Hold upright, level, and slowly scan."
            return
        }
        let heading = atan2(-frame.camera.transform.columns.2.x, frame.camera.transform.columns.2.z)
        let compassReady = headingAccuracy >= 0 && headingAccuracy <= 25 && headingAt.map { abs($0.timeIntervalSinceNow)<3 } == true
        let camera=frame.camera.transform.columns.3
        currentHeading = heading
        currentCameraX = Double(camera.x); currentCameraZ = Double(camera.z)
        headingBubble.isEnabled = true
        var relative:Float = !exitDemo ? 0 : .nan
        if exitDemo && planReady && guessedFloor == "2F" {
            relative = Float(waypointGuide.update(cameraX:currentCameraX,cameraZ:currentCameraZ,cameraHeading:Double(heading),mapRotation:compassReady ? 0 : .nan))
            if let manualGoalHeading {
                _ = waypointGuide.align(cameraX:currentCameraX,cameraZ:currentCameraZ,cameraHeading:Double(heading),relativeHeading:Double(manualGoalHeading))
                self.manualGoalHeading = nil
                relative = Float(waypointGuide.update(cameraX:currentCameraX,cameraZ:currentCameraZ,cameraHeading:Double(heading),mapRotation:.nan))
            }
        }
        currentRelative = relative
        updateHeadingBubble()

        var evidence = [ObstacleProbe.Evidence](repeating: .unknown, count: 3)
        if usesDepth, let depth = frame.sceneDepth {
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
        } else if !usesDepth {
            // Restored from the earlier camera-only branch; unobserved surfaces remain unknown.
            let cameraFromWorld = frame.camera.viewMatrix(for:.portrait)
            let points = frame.rawFeaturePoints?.points.map { point -> SIMD3<Float> in
                let local = cameraFromWorld * SIMD4<Float>(point.x,point.y,point.z,1)
                return SIMD3<Float>(local.x,local.y,local.z)
            } ?? []
            for sector in 0..<3 {
                let depths = points.filter { point in
                    let depth = -point.z
                    guard depth > 0.25,depth < 5,abs(point.y)<0.4 else {return false}
                    let ratio=point.x/depth
                    return sector == 0 ? ratio < -0.15 && ratio > -0.6 : sector == 2 ? ratio > 0.15 && ratio < 0.6 : abs(ratio)<=0.15
                }.map { -$0.z }
                var distance:Float?
                if let query=scene.raycastQuery(from:CGPoint(x:scene.bounds.width*(0.25+Double(sector)*0.25),y:scene.bounds.midY),allowing:.existingPlaneGeometry,alignment:.vertical) {
                    let camera=frame.camera.transform.columns.3
                    distance=scene.session.raycast(query).map { hit in
                        let target=hit.worldTransform.columns.3
                        return simd_distance(SIMD3<Float>(camera.x,camera.y,camera.z),SIMD3<Float>(target.x,target.y,target.z))
                    }.filter {$0 > 0.25 && $0 < 5}.min()
                }
                evidence[sector]=ObstacleProbe.cameraEvidence(depths,planeDistance:distance)
            }
            reason="camera-features-or-plane"
        }
        nearFrames = evidence[1] == .near ? nearFrames+1 : 0
        review.isEnabled = nearFrames >= 3
        let cue = ObstacleProbe.guidance(center:evidence[1],left:evidence[0],right:evidence[2],relative:relative)
        cueFrames = cue == stableCue ? cueFrames + 1 : 1
        stableCue = cue
        let displayed = cueFrames >= 3 ? cue : evidence[1] == .near ? "stop" : "scan"
        arrow.text = ["forward":"Move straight", "left":"Move left", "right":"Move right", "face-left":"Turn left", "face-right":"Turn right", "around":"Turn around", "stop":"Stop", "scan":"Hold"][displayed]
        if exitDemo && waypointGuide.complete { arrow.text = "Check exit doors" }
        else if exitDemo && guessedFloor != "2F" { arrow.text = "2F demo only" }
        status.text = !relative.isFinite ? "Finding location/compass · obstacle scan active. Exit direction unavailable." : displayed == "stop" ? "Nearby directions blocked. Check your surroundings." : displayed == "scan" ? "Entrance Hall direction found · checking nearby surfaces." : "Entrance Hall exit · approximate map/GPS bearing. Check the real path."
        if !usesDepth { status.text = (status.text ?? "") + " Camera estimate; blank walls/glass can be missed." }
        renderArrow(frame,heading:heading,relative:relative,cue:displayed)
        if evidence[1] == .near && displayed == "scan" { directionArrow.isHidden = true }
    }

    private func renderArrow(_ frame:ARFrame,heading:Float,relative:Float,cue:String) {
        directionArrow.cue = cue
        directionArrow.isHidden = cue == "stop"
        directionArrow.accessibilityLabel = cue == "scan" ? "Hold, arrow preview" : arrow.text
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

/// Printed QR payload: `CONTOUR-LOC|1|2F|<x>|<y>|<facing>|<label>`. x/y are normalised on the
/// 1178×817 saved 2F plan; facing is degrees clockwise from map-up when looking straight at the marker.
struct LibraryMarker: Equatable {
    let floor: String
    let imageX: Double
    let imageY: Double
    let facing: Double
    let label: String
    var id: String { "\(floor)|\(imageX)|\(imageY)" }

    init?(payload: String) {
        let parts = payload.split(separator: "|", omittingEmptySubsequences: false).map(String.init)
        guard parts.count >= 7, parts[0] == "CONTOUR-LOC", parts[1] == "1", ["B1", "1F", "2F", "3F", "4F"].contains(parts[2]),
              let x = Double(parts[3]), let y = Double(parts[4]), let facing = Double(parts[5]),
              x.isFinite, y.isFinite, facing.isFinite, (0...1).contains(x), (0...1).contains(y), (-360...360).contains(facing) else { return nil }
        floor = parts[2]; imageX = x; imageY = y; self.facing = facing
        label = String(parts[6...].joined(separator: "|").prefix(60))
    }
}

struct LibraryMarkerSighting { let marker: LibraryMarker; let centre: CGPoint; let size: CGFloat }

enum LibraryMarkerDetector {
    /// Returns a marker only when it is near the image centre and large enough that the person is close and facing it.
    static func detect(in buffer: CVPixelBuffer) -> LibraryMarkerSighting? {
        let request = VNDetectBarcodesRequest()
        request.symbologies = [.qr]
        let handler = VNImageRequestHandler(cvPixelBuffer: buffer, orientation: .right, options: [:])
        guard (try? handler.perform([request])) != nil, let results = request.results else { return nil }
        return results.compactMap { observation -> LibraryMarkerSighting? in
            guard let payload = observation.payloadStringValue, let marker = LibraryMarker(payload: payload) else { return nil }
            let box = observation.boundingBox
            return LibraryMarkerSighting(marker: marker, centre: CGPoint(x: box.midX, y: box.midY), size: max(box.width, box.height))
        }
        .filter { abs($0.centre.x - 0.5) < 0.3 && abs($0.centre.y - 0.5) < 0.3 && $0.size > 0.06 }
        .max { $0.size < $1.size }
    }
}
