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
    var isValid: Bool {
        !sessionID.isEmpty && sessionID.count <= 80 && ["B1", "1F", "2F", "3F", "4F"].contains(floor) &&
        latitude.isFinite && abs(latitude) < 85 && longitude.isFinite && abs(longitude) <= 180 &&
        heading.isFinite && heading >= 0 && heading < 360 && stepLength.isFinite && (0.4...1.1).contains(stepLength)
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

    init(request: IndoorStepRequest, time: TimeInterval) {
        self.request = request
        pose = IndoorStepPose(sessionID: request.sessionID, floor: request.floor, latitude: request.latitude,
            longitude: request.longitude, heading: request.heading, steps: 0, distance: 0,
            stepLength: request.stepLength, status: "starting", timestamp: time * 1000)
        lastStepTime = time
        headings = [(time, request.heading)]
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
        guard count > 0 else { return true }
        guard count <= 100, Double(count) <= max(3, (time - lastStepTime) * 4 + 3),
              let motionTime = lastMotion, abs(time - motionTime) <= 2 else { return false }
        // iOS reports cumulative batches, not individual step timestamps. Spread a batch
        // over its interval and use historical gyro headings instead of the latest turn.
        for index in 1...count {
            let stepTime = lastStepTime + (time - lastStepTime) * Double(index) / Double(count)
            let heading = headings.last(where: { $0.time <= stepTime })?.degrees ?? pose.heading
            east += request.stepLength * sin(heading * .pi / 180)
            north += request.stepLength * cos(heading * .pi / 180)
        }
        pose.steps = total; pose.distance = Double(total) * request.stepLength
        pose.latitude = request.latitude + north / 111319.49079327358
        pose.longitude = request.longitude + east / (111319.49079327358 * cos(request.latitude * .pi / 180))
        lastStepTime = time; pose.timestamp = time * 1000
        return true
    }
    mutating func setStatus(_ status: String, time: TimeInterval) { pose.status = status; pose.timestamp = time * 1000 }
}

@MainActor
final class IndoorStepTracker {
    var onUpdate: ((IndoorStepPose) -> Void)?
    private(set) var model: IndoorStepModel?
    var pose: IndoorStepPose? { model?.pose }
    private let motion = CMMotionManager()
    private let pedometer = CMPedometer()
    private var generation = UUID()
    private var lastPublish = 0.0
    private var backgroundObserver: NSObjectProtocol?
    private var watchdog: Timer?
    private var lastMotionDate: Date?

    init() {
        backgroundObserver = NotificationCenter.default.addObserver(forName: UIApplication.didEnterBackgroundNotification,
            object: nil, queue: .main) { [weak self] _ in Task { @MainActor in self?.pause() } }
    }
    deinit {
        motion.stopDeviceMotionUpdates(); pedometer.stopUpdates(); watchdog?.invalidate()
        if let backgroundObserver { NotificationCenter.default.removeObserver(backgroundObserver) }
    }
    func start(_ request: IndoorStepRequest) {
        guard request.isValid else { return }
        stop()
        let now = Date(); model = IndoorStepModel(request: request, time: now.timeIntervalSince1970)
        guard CMPedometer.isStepCountingAvailable(), motion.isDeviceMotionAvailable,
              CMPedometer.authorizationStatus() != .denied, CMPedometer.authorizationStatus() != .restricted else {
            model?.setStatus("motion-unavailable", time: now.timeIntervalSince1970); publish(); return
        }
        let run = generation
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
                if sample.time - self.lastPublish >= 0.2 { self.lastPublish = sample.time; self.publish() }
            }
        }
        pedometer.startUpdates(from: now) { [weak self] data, error in
            DispatchQueue.main.async {
                guard let self, self.generation == run else { return }
                guard let data, error == nil else { self.pause(status: "motion-unavailable"); return }
                if self.model?.countSteps(data.numberOfSteps.intValue, time: data.endDate.timeIntervalSince1970) == false {
                    self.pause(status: "motion-interrupted"); return
                }
                self.publish()
            }
        }
        let timer = Timer(timeInterval: 1, repeats: true) { [weak self] _ in
            Task { @MainActor [weak self] in
                guard let self, let last = self.lastMotionDate else { return }
                if Date().timeIntervalSince(last) > 2 { self.pause(status: "motion-interrupted") }
            }
        }
        watchdog = timer; RunLoop.main.add(timer, forMode: .common)
        publish()
    }
    func pause(status: String = "paused") {
        guard model != nil else { return }
        generation = UUID(); motion.stopDeviceMotionUpdates(); pedometer.stopUpdates(); watchdog?.invalidate(); watchdog = nil
        model?.setStatus(status, time: Date().timeIntervalSince1970); publish()
    }
    func stop() {
        generation = UUID(); motion.stopDeviceMotionUpdates(); pedometer.stopUpdates(); watchdog?.invalidate(); watchdog = nil
        model = nil; lastPublish = 0; lastMotionDate = nil
    }
    private func publish() { if let pose { onUpdate?(pose) } }
}
