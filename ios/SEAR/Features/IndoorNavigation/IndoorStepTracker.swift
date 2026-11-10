import CoreMotion
import Foundation
import UIKit

/// Foreground-only, user-anchored pedestrian dead reckoning. No GPS or camera positions enter this model.
struct IndoorStepRequest: Codable {
    let sessionID: String
    let floor: String
    let latitude: Double
    let longitude: Double
    let heading: Double
    let stepLength: Double
    var wallMap: FloorWallMap? = nil
    var isValid: Bool {
        !sessionID.isEmpty && sessionID.count <= 80 && ["B1", "1F", "2F", "3F", "4F"].contains(floor) &&
        latitude.isFinite && abs(latitude) < 85 && longitude.isFinite && abs(longitude) <= 180 &&
        heading.isFinite && heading >= 0 && heading < 360 && stepLength.isFinite && (0.4...1.1).contains(stepLength) &&
        (wallMap?.isValid ?? true)
    }
}

struct IndoorStepPose: Codable {
    let sessionID: String
    let floor: String
    var latitude: Double
    var longitude: Double
    var heading: Double
    var steps: Int
    var distance: Double
    let stepLength: Double
    var status: String
    var timestamp: Double
    var wallBlocked = false
}

/// Integrates turns around gravity and advances only on new pedometer counts.
struct IndoorStepModel {
    let request: IndoorStepRequest
    private(set) var pose: IndoorStepPose
    private var east = 0.0
    private var north = 0.0
    private var lastMotion: TimeInterval?
    private var lastStepTime: TimeInterval
    private var headings: [(time: TimeInterval, degrees: Double)]
    private let barriers: [(CGPoint, CGPoint)]

    init(request: IndoorStepRequest, time: TimeInterval) {
        self.request = request
        pose = IndoorStepPose(sessionID: request.sessionID, floor: request.floor, latitude: request.latitude,
            longitude: request.longitude, heading: request.heading, steps: 0, distance: 0,
            stepLength: request.stepLength, status: "starting", timestamp: time * 1000)
        lastStepTime = time
        headings = [(time, request.heading)]
        barriers = request.wallMap?.barriers ?? []
    }
    mutating func turn(clockwiseRadiansPerSecond rate: Double, time: TimeInterval) -> Bool {
        guard time.isFinite, rate.isFinite, abs(rate) <= 8 else { return false }
        if let last = lastMotion {
            guard time > last, time - last <= 0.5 else { return false }
            pose.heading = (pose.heading + rate * (time - last) * 180 / .pi + 360).truncatingRemainder(dividingBy: 360)
        }
        lastMotion = time
        headings.append((time, pose.heading))
        headings.removeAll { $0.time < time - 60 }
        pose.status = "tracking"; pose.timestamp = time * 1000
        return true
    }
    mutating func countSteps(_ total: Int, time: TimeInterval) -> Bool {
        guard time.isFinite, time >= lastStepTime, total >= pose.steps else { return false }
        let count = total - pose.steps
        guard count > 0 else { lastStepTime = time; return true }
        guard count <= 100, Double(count) <= max(3, (time - lastStepTime) * 4 + 3),
              let motionTime = lastMotion, time - motionTime <= 2, motionTime - time <= 60 else { return false }
        // iOS reports cumulative batches, not individual step timestamps. Spread a batch
        // over its interval and use historical gyro headings instead of the latest turn.
        pose.wallBlocked = false
        let intervalStart = max(lastStepTime, headings.first?.time ?? lastStepTime)
        for index in 1...count {
            let stepTime = intervalStart + (time - intervalStart) * Double(index) / Double(count)
            let heading = headings.last(where: { $0.time <= stepTime })?.degrees ?? pose.heading
            let nextEast = east + request.stepLength * sin(heading * .pi / 180)
            let nextNorth = north + request.stepLength * cos(heading * .pi / 180)
            let nextLatitude = request.latitude + nextNorth / 111319.49079327358
            let nextLongitude = request.longitude + nextEast / (111319.49079327358 * cos(request.latitude * .pi / 180))
            if let map = request.wallMap, !barriers.isEmpty {
                let currentLatitude = request.latitude + north / 111319.49079327358
                let currentLongitude = request.longitude + east / (111319.49079327358 * cos(request.latitude * .pi / 180))
                if FloorWallMap.blocks(from: map.local(latitude: currentLatitude, longitude: currentLongitude),
                    to: map.local(latitude: nextLatitude, longitude: nextLongitude), barriers: barriers) {
                    pose.wallBlocked = true
                    // Keep consuming counts, but never teleport across a mapped wall or choose
                    // an arbitrary side. The user can correct the start, heading, stride or geometry.
                    continue
                }
            }
            east = nextEast; north = nextNorth
        }
        pose.steps = total; pose.distance = Double(total) * request.stepLength
        pose.latitude = request.latitude + north / 111319.49079327358
        pose.longitude = request.longitude + east / (111319.49079327358 * cos(request.latitude * .pi / 180))
        // Pedometer batches may be seconds behind the gyro. Publishing their old date
        // would make the page reject the new coordinates as an out-of-order pose.
        lastStepTime = time; pose.timestamp = max(pose.timestamp, time * 1000)
        return true
    }
    mutating func setStatus(_ status: String, time: TimeInterval) { pose.status = status; pose.timestamp = time * 1000 }
}

/// Consumes raw cumulative counts, but forwards only counts overlapping confident walking.
/// Stationary/unknown counts are discarded permanently rather than caught up later.
struct IndoorWalkingGate {
    struct Activity { let time: TimeInterval; let walking: Bool }
    private(set) var rawSteps = 0
    private(set) var acceptedSteps = 0
    private var lastTime: TimeInterval
    private var activity: [Activity] = []
    init(time: TimeInterval) { lastTime = time }
    mutating func record(time: TimeInterval, walking: Bool) {
        guard time.isFinite else { return }
        activity.append(Activity(time: time, walking: walking))
        activity.sort { $0.time < $1.time }
    }
    mutating func consume(total: Int, time: TimeInterval) -> Int {
        guard total > rawSteps, time.isFinite, time >= lastTime else { return acceptedSteps }
        let count = total - rawSteps
        if count <= 100 {
            for index in 1...count {
                let stepTime = lastTime + (time - lastTime) * Double(index) / Double(count)
                if activity.last(where: { $0.time <= stepTime })?.walking == true { acceptedSteps += 1 }
            }
        }
        rawSteps = total; lastTime = time
        // Retain the last state before the history window as well as newer transitions.
        if let boundary = activity.lastIndex(where: { $0.time < time - 60 }), boundary > 0 {
            activity.removeFirst(boundary)
        }
        return acceptedSteps
    }
}

@MainActor
final class IndoorStepTracker {
    var onUpdate: ((IndoorStepPose) -> Void)?
    private(set) var model: IndoorStepModel?
    var pose: IndoorStepPose? { model?.pose }
    private let motion = CMMotionManager()
    private let pedometer = CMPedometer()
    private let activityManager = CMMotionActivityManager()
    private var walkingGate: IndoorWalkingGate?
    private var generation = UUID()
    private var lastPublish = 0.0
    private var backgroundObserver: NSObjectProtocol?
    private var watchdog: Timer?
    private var lastMotionDate: Date?
    private var pendingSteps: (total: Int, time: TimeInterval)?

    init() {
        backgroundObserver = NotificationCenter.default.addObserver(forName: UIApplication.didEnterBackgroundNotification,
            object: nil, queue: .main) { [weak self] _ in Task { @MainActor in self?.pause() } }
    }
    deinit {
        motion.stopDeviceMotionUpdates(); pedometer.stopUpdates(); activityManager.stopActivityUpdates(); watchdog?.invalidate()
        if let backgroundObserver { NotificationCenter.default.removeObserver(backgroundObserver) }
    }
    func start(_ request: IndoorStepRequest) {
        guard request.isValid else { return }
        stop()
        let now = Date(); model = IndoorStepModel(request: request, time: now.timeIntervalSince1970)
        guard CMPedometer.isStepCountingAvailable(), CMMotionActivityManager.isActivityAvailable(), motion.isDeviceMotionAvailable,
              CMPedometer.authorizationStatus() != .denied, CMPedometer.authorizationStatus() != .restricted else {
            model?.setStatus("motion-unavailable", time: now.timeIntervalSince1970); publish(); return
        }
        let run = generation
        walkingGate = IndoorWalkingGate(time: now.timeIntervalSince1970)
        activityManager.startActivityUpdates(to: .main) { [weak self] activity in
            guard let activity else { return }
            let time = activity.startDate.timeIntervalSince1970
            let walking = (activity.walking || activity.running) && !activity.stationary &&
                !activity.automotive && !activity.cycling && activity.confidence != .low
            Task { @MainActor [weak self] in
                guard let self, self.generation == run else { return }
                self.walkingGate?.record(time: time, walking: walking)
            }
        }
        let wallOffset = now.timeIntervalSince1970 - ProcessInfo.processInfo.systemUptime
        motion.deviceMotionUpdateInterval = 0.02
        motion.startDeviceMotionUpdates(using: .xArbitraryZVertical, to: .main) { [weak self] data, error in
            let sample: (rate: Double, time: Double)? = data.flatMap { data in
                guard error == nil else { return nil }
                let gravity = data.gravity, rate = data.rotationRate
                return (rate.x * gravity.x + rate.y * gravity.y + rate.z * gravity.z, data.timestamp + wallOffset)
            }
            Task { @MainActor [weak self] in
                guard let self, self.generation == run else { return }
                guard let sample else { self.pause(status: "motion-unavailable"); return }
                guard self.model?.turn(clockwiseRadiansPerSecond: sample.rate, time: sample.time) == true else {
                    self.pause(status: "motion-interrupted"); return
                }
                self.lastMotionDate = Date()
                if let pending = self.pendingSteps {
                    self.pendingSteps = nil
                    self.receiveSteps(pending.total, time: pending.time)
                }
                if sample.time - self.lastPublish >= 0.2 { self.lastPublish = sample.time; self.publish() }
            }
        }
        pedometer.startUpdates(from: now) { [weak self] data, error in
            DispatchQueue.main.async {
                guard let self, self.generation == run else { return }
                guard let data, error == nil else { self.pause(status: "motion-unavailable"); return }
                let total = data.numberOfSteps.intValue, time = data.endDate.timeIntervalSince1970
                // Give activity classification time to describe this delayed step batch.
                DispatchQueue.main.asyncAfter(deadline: .now() + 2) { [weak self] in
                    guard let self, self.generation == run else { return }
                    self.receiveSteps(total, time: time)
                }
            }
        }
        let timer = Timer(timeInterval: 1, repeats: true) { [weak self] _ in
            Task { @MainActor [weak self] in
                guard let self else { return }
                if let last = self.lastMotionDate {
                    if Date().timeIntervalSince(last) > 2 { self.pause(status: "motion-interrupted") }
                } else if Date().timeIntervalSince(now) > 30 { self.pause(status: "motion-unavailable") }
            }
        }
        watchdog = timer; RunLoop.main.add(timer, forMode: .common)
        publish()
    }
    /// Absolute correction from a scanned location marker: restart dead reckoning at the marker,
    /// keeping the same session, floor, stride and wall map so the map and AR keep accepting poses.
    @discardableResult
    func relocate(latitude: Double, longitude: Double, heading: Double) -> Bool {
        guard let request = model?.request else { return false }
        let corrected = IndoorStepRequest(sessionID: request.sessionID, floor: request.floor, latitude: latitude,
            longitude: longitude, heading: (heading.truncatingRemainder(dividingBy: 360) + 360).truncatingRemainder(dividingBy: 360),
            stepLength: request.stepLength, wallMap: request.wallMap)
        guard corrected.isValid else { return false }
        start(corrected)
        return true
    }
    func pause(status: String = "paused") {
        guard model != nil else { return }
        generation = UUID(); motion.stopDeviceMotionUpdates(); pedometer.stopUpdates(); activityManager.stopActivityUpdates(); watchdog?.invalidate(); watchdog = nil
        model?.setStatus(status, time: Date().timeIntervalSince1970); publish()
    }
    func stop() {
        generation = UUID(); motion.stopDeviceMotionUpdates(); pedometer.stopUpdates(); activityManager.stopActivityUpdates(); watchdog?.invalidate(); watchdog = nil
        model = nil; lastPublish = 0; lastMotionDate = nil; pendingSteps = nil; walkingGate = nil
    }
    private func receiveSteps(_ total: Int, time: TimeInterval) {
        guard let pose, total > (walkingGate?.rawSteps ?? 0) else { return }
        if pose.status == "starting" { pendingSteps = (total, time); return }
        guard let accepted = walkingGate?.consume(total: total, time: time) else { return }
        guard model?.countSteps(accepted, time: time) == true else { pause(status: "motion-interrupted"); return }
        publish()
    }
    private func publish() { if let pose { onUpdate?(pose) } }
}

struct StepCalibrationResult: Codable {
    let requestID: String
    let status: String
    let steps: Int
    let stepLength: Double?
    let message: String
}

/// Measures steps over a user-measured distance, independently of the map tracker.
@MainActor
final class StepLengthCalibration {
    var onUpdate: ((StepCalibrationResult) -> Void)?
    private let pedometer = CMPedometer()
    private var run = UUID()
    private var requestID: String?
    private var started: Date?
    private var distance = 0.0
    private var steps = 0
    private var finishing = false
    private var observer: NSObjectProtocol?

    init() {
        observer = NotificationCenter.default.addObserver(forName: UIApplication.didEnterBackgroundNotification,
            object: nil, queue: .main) { [weak self] _ in Task { @MainActor in self?.cancel() } }
    }
    deinit {
        pedometer.stopUpdates()
        if let observer { NotificationCenter.default.removeObserver(observer) }
    }
    nonisolated static func length(distance: Double, steps: Int) -> Double? {
        guard distance.isFinite, (5...100).contains(distance), steps >= 8 else { return nil }
        let value = distance / Double(steps)
        return (0.4...1.1).contains(value) ? value : nil
    }
    func start(id: String, distance: Double) {
        cancel()
        guard !id.isEmpty, id.count <= 80, distance.isFinite, (5...100).contains(distance) else { return }
        requestID = id; self.distance = distance; steps = 0; finishing = false
        guard CMPedometer.isStepCountingAvailable(), CMPedometer.authorizationStatus() != .denied,
              CMPedometer.authorizationStatus() != .restricted else {
            report("error", "Allow Motion & Fitness access in Settings to calibrate."); cancel(notify: false); return
        }
        let start = Date(), generation = run
        started = start
        report("walking", "Walk the measured distance, then tap Finish calibration.")
        pedometer.startUpdates(from: start) { [weak self] data, error in
            DispatchQueue.main.async {
                guard let self, self.run == generation, !self.finishing else { return }
                guard error == nil, let data else {
                    self.report("error", "Step counting unavailable. Check Motion & Fitness permission and retry.")
                    self.cancel(notify: false); return
                }
                self.steps = data.numberOfSteps.intValue
                self.report("walking", "Walk the measured distance, then tap Finish calibration.")
            }
        }
    }
    func finish(id: String) {
        guard requestID == id, let started, !finishing else { return }
        finishing = true; pedometer.stopUpdates()
        report("finishing", "Reading the final step count…")
        let generation = run
        // Query through the finish time so delayed live batches don't shorten the measurement.
        pedometer.queryPedometerData(from: started, to: Date()) { [weak self] data, error in
            DispatchQueue.main.async {
                guard let self, self.run == generation else { return }
                guard error == nil, let data else {
                    self.report("error", "Could not read the final steps. Try calibration again.")
                    self.cancel(notify: false); return
                }
                self.steps = data.numberOfSteps.intValue
                if let length = Self.length(distance: self.distance, steps: self.steps) {
                    self.report("complete", "Step length saved for your next starting position.", length: length)
                } else { self.report("error", "Too few steps or an implausible step length. Check the distance and try a longer walk.") }
                self.cancel(notify: false)
            }
        }
    }
    func cancel(notify: Bool = true) {
        if notify, requestID != nil { report("cancelled", "Calibration cancelled.") }
        run = UUID(); requestID = nil; started = nil; finishing = false; pedometer.stopUpdates()
    }
    private func report(_ status: String, _ message: String, length: Double? = nil) {
        guard let requestID else { return }
        onUpdate?(StepCalibrationResult(requestID: requestID, status: status, steps: steps, stepLength: length, message: message))
    }
}
