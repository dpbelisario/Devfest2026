import ARKit
import SceneKit
import UIKit
import CoreLocation
import CryptoKit
import ContourShared

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

    static func guidance(center:Evidence,left:Evidence,right:Evidence,relative:Float, alignmentTolerance:Float = .pi / 6)->String {
        if center == .near { return cue(center:center,left:left,right:right) }
        guard relative.isFinite else { return "scan" }
        // Turning in place does not claim the unseen walking path is clear.
        if abs(relative) > .pi * 0.8 { return "around" }
        if abs(relative) > alignmentTolerance { return relative > 0 ? "face-right" : "face-left" }
        guard center == .farther else { return "scan" }
        return "forward"
    }

}

/// Camera geometry is sparse: require spatial coverage, not repeated points at one spot.
enum CameraObstacleProbe {
    static func evidence(points: [SIMD3<Float>], sector: Int, planeDistances: [Float] = []) -> ObstacleProbe.Evidence {
        guard (0..<3).contains(sector) else { return .unknown }
        let limits: [(Float, Float)] = [(-0.6, -0.15), (-0.15, 0.15), (0.15, 0.6)]
        let (lower, upper) = limits[sector]
        var close = Set<Int>(), farther = Set<Int>()
        var hasUncertainClosePoint = false
        for point in points {
            let depth = -point.z
            guard point.x.isFinite, point.y.isFinite, depth.isFinite, depth > 0.25, depth < 5,
                  point.y > -1.4, point.y < 0.5 else { continue }
            let x = point.x / depth, y = point.y / depth
            guard x >= lower, x <= upper, y >= -0.65, y <= 0.35 else { continue }
            let column = min(2, Int((x - lower) / (upper - lower) * 3))
            let row = min(3, Int((y + 0.65) * 4))
            let cell = row * 3 + column
            if depth < 1.2 { close.insert(cell) }
            if depth <= 1.5 { hasUncertainClosePoint = true }
            else { farther.insert(cell) }
        }
        let planes = planeDistances.filter { $0.isFinite && $0 > 0.25 && $0 < 5 }
        if close.count >= 2 || planes.contains(where: { $0 < 1.2 }) { return .near }
        if hasUncertainClosePoint || planes.contains(where: { $0 <= 1.5 }) { return .unknown }
        let columns = Set(farther.map { $0 % 3 }), rows = Set(farther.map { $0 / 3 })
        // A single distant plane/ray cannot establish a walking corridor.
        if farther.count >= 6 && columns.count >= 2 && rows.count >= 2 { return .farther }
        return .unknown
    }
}

/// Farther/side suggestions need sustained fresh observations; hazards remove them immediately.
struct CameraCueGate {
    private var candidate = "scan"
    private var count = 0
    private var lastTime: TimeInterval?
    mutating func reset() { candidate = "scan"; count = 0; lastTime = nil }
    mutating func update(cue: String, timestamp: TimeInterval, now: TimeInterval, tracking: Bool = true) -> String {
        guard tracking, timestamp.isFinite, now.isFinite, now - timestamp >= 0, now - timestamp < 0.6,
              lastTime.map({ timestamp > $0 }) ?? true else { reset(); return "scan" }
        if let lastTime, timestamp - lastTime > 0.6 { reset() }
        lastTime = timestamp
        count = cue == candidate ? count + 1 : 1; candidate = cue
        if cue == "stop" { return "stop" }
        return count >= 3 ? cue : "scan"
    }
}

/// A user-confirmed origin and printed destination; this is a bearing goal, not a wall-aware route.
struct FloorARGoal: Codable {
    struct Point: Codable {
        let latitude: Double
        let longitude: Double
        let name: String
        var isValid: Bool { latitude.isFinite && abs(latitude) < 85 && longitude.isFinite && abs(longitude) <= 180 && !name.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty && name.count <= 80 }
    }
    struct Heading: Codable {
        let degrees: Double
        let accuracy: Double
        let timestamp: Double
        func isFresh(now: Date = Date()) -> Bool {
            degrees.isFinite && degrees >= 0 && degrees < 360 && accuracy.isFinite && accuracy >= 0 && accuracy <= 60 &&
            timestamp.isFinite && abs(now.timeIntervalSince1970 * 1000 - timestamp) <= 10000
        }
    }
    var heading: Heading? = nil
    var trackingID: String? = nil
    let version: Int
    let floor: String
    let start: Point
    let destination: Point
    var offset: SIMD2<Float> {
        let scale = cos(start.latitude * .pi / 180)
        return SIMD2(Float((destination.longitude - start.longitude) * 111319.49079327358 * scale),
                     Float((destination.latitude - start.latitude) * 111319.49079327358))
    }
    var isValid: Bool {
        version == 1 && ["B1", "1F", "2F", "3F", "4F"].contains(floor) && start.isValid && destination.isValid &&
        simd_length(offset).isFinite && simd_length(offset) > 0.5 && simd_length(offset) <= 1000
    }
    func guidance(from pose: IndoorStepPose) -> (distance: Float, relative: Float) {
        let north = (destination.latitude - pose.latitude) * 111319.49079327358
        let east = (destination.longitude - pose.longitude) * 111319.49079327358 * cos(pose.latitude * .pi / 180)
        let angle = atan2(east, north) - pose.heading * .pi / 180
        return (Float(hypot(east, north)), Float(atan2(sin(angle), cos(angle))))
    }
    /// Convert east/north displacement into the AR session frame using its current yaw and a fresh compass heading.
    func target(camera: SIMD2<Float>, cameraYaw: Float, compassDegrees: Double) -> SIMD2<Float> {
        let bearing = atan2(offset.x, offset.y)
        let angle = cameraYaw + bearing - Float(compassDegrees * .pi / 180)
        let distance = simd_length(offset)
        return camera + SIMD2(distance * sin(angle), -distance * cos(angle))
    }
}

/// Always-visible camera overlay: direction is independent of obstacle evidence and AR surface detection.
final class DestinationArrowView: UIView {
    var stopped = false
    func update(relative: Float?, caution: Bool = false, stopped: Bool = false) {
        self.stopped = stopped
        tintColor = stopped ? .systemRed : caution ? .systemOrange : .white
        transform = CGAffineTransform(rotationAngle: CGFloat(relative?.isFinite == true ? relative! : 0))
        accessibilityLabel = stopped ? "Stop, obstacle ahead" : relative == nil ? "Direction initializing" : "Direction to destination"
        setNeedsDisplay()
    }
    override init(frame: CGRect) {
        super.init(frame: frame); backgroundColor = .clear; isOpaque = false
        isUserInteractionEnabled = false; isAccessibilityElement = true
    }
    required init?(coder: NSCoder) { fatalError("init(coder:) has not been implemented") }
    override func draw(_ rect: CGRect) {
        guard let context = UIGraphicsGetCurrentContext() else { return }
        context.setShadow(offset: CGSize(width: 0, height: 2), blur: 5, color: UIColor.black.withAlphaComponent(0.7).cgColor)
        tintColor.setFill()
        if stopped {
            let size = min(bounds.width, bounds.height) * 0.55
            UIBezierPath(roundedRect: CGRect(x: (bounds.width-size)/2, y: (bounds.height-size)/2, width: size, height: size), cornerRadius: 12).fill()
            return
        }
        let width = bounds.width * 0.72
        for index in 0..<4 {
            let y = CGFloat(index) * bounds.height / 4 + 4
            let x = (bounds.width-width)/2
            let path = UIBezierPath()
            path.move(to: CGPoint(x: x+width/2, y: y))
            path.addLine(to: CGPoint(x: x+width, y: y+28))
            path.addLine(to: CGPoint(x: x+width-10, y: y+43))
            path.addLine(to: CGPoint(x: x+width/2, y: y+20))
            path.addLine(to: CGPoint(x: x+10, y: y+43))
            path.addLine(to: CGPoint(x: x, y: y+28)); path.close(); path.fill()
        }
    }
}

final class ObstacleScanViewController: UIViewController, ARSessionDelegate, ARSCNViewDelegate, CLLocationManagerDelegate {
    var exitDemo = false
    var floorGoal: FloorARGoal?
    var indoorTracker: IndoorStepTracker?
    private var lastObstacleAt: TimeInterval = 0
    private var lastBlocked = false
    private var lastFarther = false
    private var lastDetour: Float?
    private var compassDegrees: CLLocationDirection?
    private var requiresReconfirmation = false
    var completion: ((String, String) -> Void)?
    private let scene = ARSCNView()
    private var localOnly = false
    private let mode = UISegmentedControl(items: ["Obstacle arrow", "Library exit"])
    private let sectors = UILabel()
    private var cueGate = CameraCueGate()
    private var runID = UUID()
    private var watchdog: Timer?
    private let status = UILabel()
    private let arrow = UILabel()
    private let review = UIButton(type:.system)
    private var nearFrames = 0
    private let directionArrow = SCNNode()
    private let immediateArrow = DestinationArrowView()
    private var lastRelative: Float?
    private let location = CLLocationManager()
    private var entrance: ExitCoordinate?
    private var targetPosition: SIMD2<Float>?
    private var headingAt: Date?
    private var headingAccuracy: CLLocationDirection = -1
    private var lastUpdate: TimeInterval = 0
    private var observers: [NSObjectProtocol] = []
    private var reason = "unknown"

    override func viewDidLoad() {
        super.viewDidLoad()
        location.delegate = self
        location.desiredAccuracy = kCLLocationAccuracyBest
        view.backgroundColor = .black
        scene.translatesAutoresizingMaskIntoConstraints = false
        scene.session.delegate = self
        scene.session.delegateQueue = .main
        scene.delegate = self
        view.addSubview(scene)
        let heading = UILabel()
        heading.text = floorGoal.map { "AR · \($0.destination.name) · \($0.floor)" } ?? "Camera obstacle AR"
        heading.numberOfLines = 2
        localOnly = floorGoal == nil && !exitDemo
        mode.isHidden = floorGoal != nil
        mode.selectedSegmentIndex = localOnly ? 0 : 1
        mode.addTarget(self, action: #selector(changeMode), for: .valueChanged)
        sectors.isHidden = floorGoal != nil
        sectors.font = .preferredFont(forTextStyle: .caption1)
        sectors.textColor = .white; sectors.numberOfLines = 2
        sectors.text = "Left: unobserved · Ahead: unobserved · Right: unobserved"
        heading.textColor = .white
        heading.font = .preferredFont(forTextStyle: .headline)
        status.textColor = .white
        status.numberOfLines = 0
        status.font = .preferredFont(forTextStyle: .footnote)
        status.text = "Move the phone slowly side-to-side to observe surfaces. Camera estimates can miss glass and low objects."
        review.setTitle("Review possible obstacle",for:.normal)
        review.isEnabled = false
        review.isHidden = exitDemo || floorGoal != nil
        review.addTarget(self,action:#selector(finishBlocked),for:.touchUpInside)
        let back = UIButton(type: .system)
        back.setTitle("Close", for: .normal)
        back.addTarget(self, action: #selector(finishUnknown), for: .touchUpInside)
        arrow.text = floorGoal == nil ? "Scan slowly" : "Toward your destination"
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
            chevron.scale = SCNVector3(0.45, 0.45, 0.45)
            chevron.position.z = -0.55-Float(index)*0.22
            chevron.geometry?.firstMaterial?.diffuse.contents = UIColor.white
            chevron.geometry?.firstMaterial?.lightingModel = .constant
            chevron.geometry?.firstMaterial?.isDoubleSided = true
            let pulse = SCNAction.sequence([.fadeOpacity(to:0.3,duration:0.8),.fadeOpacity(to:1,duration:0.8)])
            chevron.runAction(.repeatForever(.sequence([.wait(duration:Double(index)*0.17),pulse])))
            directionArrow.addChildNode(chevron)
        }
        scene.scene.rootNode.addChildNode(directionArrow)
        directionArrow.isHidden = true
        immediateArrow.translatesAutoresizingMaskIntoConstraints = false
        immediateArrow.isHidden = floorGoal == nil
        view.addSubview(immediateArrow)
        NSLayoutConstraint.activate([
            immediateArrow.centerXAnchor.constraint(equalTo: view.centerXAnchor),
            immediateArrow.centerYAnchor.constraint(equalTo: view.centerYAnchor, constant: -65),
            immediateArrow.widthAnchor.constraint(equalToConstant: 155),
            immediateArrow.heightAnchor.constraint(equalToConstant: 210)
        ])
        if let snapshot = floorGoal?.heading, snapshot.isFresh() {
            compassDegrees = snapshot.degrees; headingAt = Date(timeIntervalSince1970: snapshot.timestamp / 1000); headingAccuracy = snapshot.accuracy
        }
        showImmediateDirection()
        let panel = UIStackView(arrangedSubviews: [heading, mode, arrow, sectors, status, review, back])
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
    deinit { watchdog?.invalidate(); for observer in observers { NotificationCenter.default.removeObserver(observer) } }

    private func start() {
        guard !requiresReconfirmation else {
            directionArrow.isHidden = true
            immediateArrow.isHidden = floorGoal == nil
            immediateArrow.update(relative: nil, stopped: true)
            arrow.text = "Reconfirm your position"
            status.text = "Tracking was interrupted. Close AR, set your starting position again, then reopen navigation."
            return
        }
        guard ARWorldTrackingConfiguration.isSupported else { status.text = "AR camera tracking is unavailable on this phone. Use Library floor maps."; return }
        runID = UUID()
        let currentRun = runID
        location.stopUpdatingLocation(); location.stopUpdatingHeading()
        entrance = nil
        if floorGoal == nil { headingAt = nil; headingAccuracy = -1; compassDegrees = nil }
        else if let snapshot = floorGoal?.heading, snapshot.isFresh() {
            compassDegrees = snapshot.degrees; headingAt = Date(timeIntervalSince1970: snapshot.timestamp / 1000); headingAccuracy = snapshot.accuracy
        }
        let config = Self.cameraConfiguration(exitGoal: floorGoal == nil && !localOnly)
        if floorGoal != nil {
            if indoorTracker == nil && CLLocationManager.headingAvailable() { location.startUpdatingHeading() }
            status.text = "Direction from your confirmed start. Obstacle checks run in the background."
            immediateArrow.isHidden = false
            showImmediateDirection()
        } else if !localOnly {
            Task { [weak self] in
                guard let json = try? await NativeFloorOverlayTransfer.json(),
                      let overlay = try? JSONDecoder().decode(GeographicOverlay.self,from:Data(json.utf8)),overlay.isValid,
                      SHA256.hash(data:overlay.image).map({String(format:"%02x",$0)}).joined() == LibraryExitGeometry.shared.imageSha256 else { return }
                guard let self, self.runID == currentRun, self.view.window != nil else { return }
                self.entrance = LibraryExitGeometry.shared.entrance(latitude:overlay.latitude,longitude:overlay.longitude,
                    width:overlay.width,aspect:overlay.aspect,angle:overlay.angle)
            }
            if location.authorizationStatus == .notDetermined { location.requestWhenInUseAuthorization() }
            startLocation()
        }
        targetPosition = nil
        nearFrames = 0; review.isEnabled = false; cueGate.reset(); lastUpdate = 0
        scene.session.run(config, options: [.resetTracking, .removeExistingAnchors])
        scene.isPlaying = true
        watchdog?.invalidate()
        let timer = Timer(timeInterval: 0.25, repeats: true) { [weak self] _ in
            guard let self, self.view.window != nil else { return }
            guard let frame = self.scene.session.currentFrame, CACurrentMediaTime() - frame.timestamp < 0.6 else {
                self.directionArrow.isHidden = true; self.cueGate.reset(); self.nearFrames = 0; self.review.isEnabled = false
                if self.floorGoal != nil {
                    self.showImmediateDirection(caution: true)
                    self.arrow.text = "Direction preview · movement updating"
                } else { self.arrow.text = "Camera paused · scan again" }
                self.sectors.text = "Left: unobserved · Ahead: unobserved · Right: unobserved"
                return
            }
        }
        watchdog = timer; RunLoop.main.add(timer, forMode: .common)
    }

    /// Explicit camera-only configuration, also on LiDAR-capable iPhones.
    static func cameraConfiguration(exitGoal: Bool) -> ARWorldTrackingConfiguration {
        let config = ARWorldTrackingConfiguration()
        config.worldAlignment = exitGoal ? .gravityAndHeading : .gravity
        config.planeDetection = [.horizontal, .vertical]
        config.frameSemantics = []
        config.sceneReconstruction = []
        config.isAutoFocusEnabled = true
        return config
    }
    @objc private func changeMode() { localOnly = mode.selectedSegmentIndex == 0; start() }
    func pause() {
        if floorGoal != nil && indoorTracker == nil && targetPosition != nil { requiresReconfirmation = true }
        lastObstacleAt = 0; lastBlocked = false; lastDetour = nil; lastFarther = false
        runID = UUID(); watchdog?.invalidate(); watchdog = nil; scene.isPlaying = false; scene.session.pause(); location.stopUpdatingLocation(); location.stopUpdatingHeading()
        headingAt = nil; targetPosition = nil; nearFrames = 0; review.isEnabled = false
        directionArrow.isHidden = true; immediateArrow.isHidden = true; arrow.text = floorGoal == nil ? "Scan slowly" : "Direction preview"; cueGate.reset(); lastUpdate = 0; reason = "unknown"
        sectors.text = "Left: unobserved · Ahead: unobserved · Right: unobserved"
    }

    private func startLocation() {
        guard floorGoal == nil, !localOnly, view.window != nil, [.authorizedAlways,.authorizedWhenInUse].contains(location.authorizationStatus) else { return }
        location.startUpdatingLocation()
        if CLLocationManager.headingAvailable() { location.startUpdatingHeading() }
    }
    func locationManagerDidChangeAuthorization(_ manager:CLLocationManager) { startLocation() }
    func locationManager(_ manager:CLLocationManager,didUpdateHeading heading:CLHeading) {
        headingAt=heading.timestamp; headingAccuracy=heading.headingAccuracy
        let degrees = heading.trueHeading >= 0 ? heading.trueHeading : heading.magneticHeading
        compassDegrees = degrees >= 0 && degrees < 360 ? degrees : nil
        if floorGoal != nil && targetPosition == nil { showImmediateDirection() }
    }
    func locationManager(_ manager:CLLocationManager,didFailWithError error:Error) { }

    /// The map and AR read the same pedometer/gyro pose. Camera transforms only support obstacle checks here.
    func refreshIndoorPose() {
        guard isViewLoaded, let floorGoal, indoorTracker != nil else { return }
        immediateArrow.isHidden = false; directionArrow.isHidden = true
        guard let pose = indoorTracker?.pose, pose.sessionID == floorGoal.trackingID else {
            immediateArrow.update(relative: nil, stopped: true); arrow.text = "Reconfirm your position"
            status.text = "Indoor tracking ended. Close AR and set your position again."; return
        }
        guard pose.status == "tracking" else {
            immediateArrow.update(relative: nil, stopped: true)
            arrow.text = pose.status == "starting" ? "Starting motion tracking" : "Reconfirm your position"
            status.text = "Motion tracking is paused or unavailable. Close AR and set your position again."
            return
        }
        guard !pose.wallBlocked else {
            immediateArrow.update(relative: nil, stopped: true)
            arrow.text = "Position reached a mapped wall"
            status.text = "Estimated movement crossed a reviewed wall. Close AR and check your position, heading or the saved doorway geometry."
            return
        }
        let goal = floorGoal.guidance(from: pose)
        let fresh = CACurrentMediaTime() - lastObstacleAt < 0.6
        let blocked = fresh && lastBlocked
        let detour = fresh ? lastDetour : nil
        immediateArrow.update(relative: detour ?? goal.relative, caution: !fresh || !lastFarther, stopped: blocked && detour == nil)
        arrow.text = blocked ? (detour == nil ? "Stop · obstacle ahead" : "Obstacle ahead · check side")
            : goal.distance <= 1.5 ? "Destination nearby · check the room sign" : "Toward your destination"
        status.text = "\(floorGoal.destination.name) · approximately \(Int(goal.distance.rounded())) m · \(pose.steps) steps. Hold the phone in front of you. Local obstacle cues; no wall-aware route."
    }

    private func showImmediateDirection(relative: Float? = nil, caution: Bool = false, stopped: Bool = false) {
        guard let floorGoal else { return }
        if indoorTracker != nil { refreshIndoorPose(); return }
        let fallback: Float?
        if targetPosition == nil, let compassDegrees, headingAccuracy >= 0, headingAccuracy <= 60,
           headingAt.map({ abs($0.timeIntervalSinceNow) <= 10 }) == true {
            let bearing = atan2(floorGoal.offset.x, floorGoal.offset.y) - Float(compassDegrees * .pi / 180)
            fallback = atan2(sin(bearing), cos(bearing))
        } else { fallback = lastRelative }
        let direction = relative?.isFinite == true ? relative : fallback
        if let direction { lastRelative = direction }
        immediateArrow.isHidden = false
        immediateArrow.update(relative: stopped ? 0 : direction, caution: caution || direction == nil, stopped: stopped)
        directionArrow.isHidden = true
        if direction == nil { arrow.text = "Arrow ready · aligning direction" }
    }

    func session(_ session: ARSession, didUpdate frame: ARFrame) {
        guard frame.timestamp - lastUpdate >= 0.2 else { return }
        lastUpdate = frame.timestamp
        inspect(frame)
    }

    private func inspect(_ frame: ARFrame) {
        guard UIApplication.shared.applicationState == .active, view.window != nil else { return }
        guard case .normal = frame.camera.trackingState, CACurrentMediaTime() - frame.timestamp < 0.6,
              abs(frame.camera.transform.columns.2.y) < 0.35 else {
            nearFrames = 0; review.isEnabled = false
            directionArrow.isHidden = true; cueGate.reset()
            if floorGoal != nil {
                showImmediateDirection(caution: true)
                if indoorTracker == nil {
                    arrow.text = "Direction preview · movement updating"
                    status.text = "Hold the phone upright. The arrow stays visible while camera tracking initializes."
                }
            } else {
                arrow.text = "Scan slowly"
                status.text = "Tracking uncertain or camera tilted. Hold upright, level, and slowly scan."
            }
            return
        }
        let heading = atan2(-frame.camera.transform.columns.2.x, frame.camera.transform.columns.2.z)
        let compassReady = headingAccuracy >= 0 && headingAccuracy <= 25 && headingAt.map { abs($0.timeIntervalSinceNow)<3 } == true
        if indoorTracker == nil, let floorGoal, targetPosition == nil, compassReady, let compassDegrees {
            let camera = frame.camera.transform.columns.3
            targetPosition = floorGoal.target(camera: SIMD2(camera.x, camera.z), cameraYaw: heading, compassDegrees: compassDegrees)
        }
        if floorGoal == nil, targetPosition == nil, compassReady, let entrance, let fix=location.location, abs(fix.timestamp.timeIntervalSinceNow)<10 {
            let bearing=LibraryExitGeometry.shared.bearing(latitude:fix.coordinate.latitude,longitude:fix.coordinate.longitude,accuracy:fix.horizontalAccuracy,target:entrance)
            if bearing.isFinite {
                let distance=Float(LibraryExitGeometry.shared.distance(latitude:fix.coordinate.latitude,longitude:fix.coordinate.longitude,target:entrance))
                let camera=frame.camera.transform.columns.3
                // Initial GPS uncertainty remains; AR motion tracks displacement, not a surveyed indoor pose.
                targetPosition=SIMD2<Float>(camera.x+distance*Float(sin(bearing)),camera.z-distance*Float(cos(bearing)))
            }
        }
        let camera=frame.camera.transform.columns.3
        let stepGoal = indoorTracker?.pose.flatMap { pose in pose.sessionID == floorGoal?.trackingID && pose.status == "tracking" ? floorGoal?.guidance(from: pose) : nil }
        let remaining = stepGoal?.distance ?? targetPosition.map { hypot($0.x-camera.x, $0.y-camera.z) }
        let nearDestination = floorGoal != nil && remaining.map { $0 <= 1.5 } == true
        let goal=targetPosition.flatMap { target -> Float? in
            guard hypot(target.x-camera.x,target.y-camera.z) >= (floorGoal == nil ? 4 : 1.5) else { return nil }
            return atan2(target.x-camera.x,camera.z-target.y)
        }
        let relative:Float = stepGoal?.relative ?? (localOnly ? 0 : (floorGoal != nil ? targetPosition != nil : compassReady) ? goal.map { atan2(sin($0-heading),cos($0-heading)) } : nil) ?? .nan
        var evidence = [ObstacleProbe.Evidence](repeating: .unknown, count: 3)
        let cameraFromWorld = frame.camera.viewMatrix(for: .portrait)
        let floors = frame.anchors.compactMap { $0 as? ARPlaneAnchor }.filter {
            $0.alignment == .horizontal && $0.classification == .floor && $0.transform.columns.3.y < camera.y - 0.6
        }
        let points = (frame.rawFeaturePoints?.points ?? []).compactMap { point -> SIMD3<Float>? in
            // Only exclude points on an actually observed/classified floor, inside its tracked extent.
            if floors.contains(where: { floor in
                let p = simd_inverse(floor.transform) * SIMD4<Float>(point.x, point.y, point.z, 1)
                return abs(p.y) < 0.08 && abs(p.x - floor.center.x) <= floor.extent.x / 2 && abs(p.z - floor.center.z) <= floor.extent.z / 2
            }) { return nil }
            let local = cameraFromWorld * SIMD4<Float>(point.x, point.y, point.z, 1)
            return SIMD3<Float>(local.x, local.y, local.z)
        }
        for sector in 0..<3 {
            var distances: [Float] = []
            // Probe several parts of a tracked plane; do not infer obstacles from an estimated plane.
            for xOffset in [-0.04, 0.04] {
                for height in [0.42, 0.58, 0.72] {
                    if let query = scene.raycastQuery(from: CGPoint(x: scene.bounds.width * (0.25 + Double(sector) * 0.25 + xOffset),
                        y: scene.bounds.height * height), allowing: .existingPlaneGeometry, alignment: .vertical) {
                        distances += scene.session.raycast(query).map { hit in
                            let p = hit.worldTransform.columns.3
                            return simd_distance(SIMD3<Float>(camera.x, camera.y, camera.z), SIMD3<Float>(p.x, p.y, p.z))
                        }
                    }
                }
            }
            evidence[sector] = CameraObstacleProbe.evidence(points: points, sector: sector, planeDistances: distances)
        }
        reason = "camera-spatial-features-or-plane"
        let descriptions = evidence.map { $0 == .near ? "near obstacle" : $0 == .farther ? "farther features" : "unobserved" }
        sectors.text = "Left: \(descriptions[0]) · Ahead: \(descriptions[1]) · Right: \(descriptions[2])"
        nearFrames = evidence[1] == .near ? nearFrames+1 : 0
        review.isEnabled = nearFrames >= 3
        let cue = nearDestination ? "scan" : ObstacleProbe.guidance(center:evidence[1],left:evidence[0],right:evidence[2],relative:relative,alignmentTolerance:floorGoal == nil ? .pi / 6 : atan(0.15))
        let displayed = cueGate.update(cue: cue, timestamp: frame.timestamp, now: CACurrentMediaTime())
        arrow.text = ["forward":"↑ Check ahead", "left":"↖ Obstacle ahead · Check left", "right":"↗ Obstacle ahead · Check right",
            "face-left":"↶ Turn left in place", "face-right":"↷ Turn right in place", "around":"↶ Turn around in place", "stop":"Stop · obstacle ahead", "scan":"Move phone slowly to scan"][displayed]
        arrow.textColor = displayed == "stop" ? .systemRed : ["scan", "face-left", "face-right", "around"].contains(displayed) ? .systemOrange : .white
        let goalStatus: String
        if let floorGoal {
            if nearDestination {
                arrow.text = "Destination nearby · check the room sign"
                goalStatus = "Near \(floorGoal.destination.name). The pin marks printed text, not a verified entrance."
            } else if let remaining, targetPosition != nil {
                goalStatus = "\(floorGoal.destination.name) · approximately \(Int(remaining.rounded())) m. AR movement from your confirmed start."
            } else {
                goalStatus = "Waiting for a fresh compass heading to align your confirmed start."
            }
        } else {
            goalStatus = localOnly ? "Local obstacle preview." : !relative.isFinite ? "Exit location/compass unavailable; local scanning is active." : "Approximate Entrance Hall bearing."
        }
        status.text = goalStatus + " Local obstacle cues only; walls and rooms are not routed. Glass, people and low objects can be missed."
        renderArrow(frame,heading:heading,relative:relative,cue:displayed)
        if indoorTracker != nil {
            lastObstacleAt = CACurrentMediaTime(); lastBlocked = evidence[1] == .near; lastFarther = evidence[1] == .farther
            lastDetour = displayed == "left" ? -atan(0.35) : displayed == "right" ? atan(0.35) : nil
            refreshIndoorPose()
        } else if floorGoal != nil {
            let blocked = evidence[1] == .near
            let detour: Float? = displayed == "left" ? -atan(0.35) : displayed == "right" ? atan(0.35) : nil
            showImmediateDirection(relative: detour ?? (relative.isFinite ? relative : nil),
                caution: evidence[1] != .farther, stopped: blocked && detour == nil)
            if blocked { arrow.text = detour == nil ? "Stop · obstacle ahead" : displayed == "left" ? "Obstacle ahead · check left" : "Obstacle ahead · check right" }
            else if nearDestination { immediateArrow.update(relative: 0, caution: true); arrow.text = "Destination nearby · check the room sign" }
            else { arrow.text = relative.isFinite ? "Toward your destination" : "Arrow ready · aligning direction" }
        } else if evidence[1] == .near && displayed == "scan" { directionArrow.isHidden = true }
    }

    private func renderArrow(_ frame: ARFrame, heading: Float, relative: Float, cue: String) {
        let camera = frame.camera.transform.columns.3
        directionArrow.position = SCNVector3(camera.x, camera.y - 0.2, camera.z)
        // Side arrows point into the observed side sector, not outside the sampled field of view.
        let turn: Float = cue == "left" ? -atan(0.35) : cue == "right" ? atan(0.35) : (floorGoal != nil && cue == "forward" && relative.isFinite ? max(-atan(0.15), min(atan(0.15), relative)) : 0)
        directionArrow.eulerAngles.y = -heading
        directionArrow.isHidden = !["forward", "left", "right"].contains(cue)
        for (index, node) in directionArrow.childNodes.enumerated() {
            let distance = Float(0.55) + Float(index) * 0.22
            node.position = SCNVector3(sin(turn) * distance, 0, -cos(turn) * distance)
            node.eulerAngles.y = -turn
            node.geometry?.firstMaterial?.diffuse.contents = UIColor.white
        }
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
