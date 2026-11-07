import AudioToolbox
import CoreHaptics

/// Strong foreground pulses, bounded so an unattended alert cannot vibrate forever.
final class AlertHaptics {
    static let pulseCount = 12
    static let pulseSpacing = 0.8
    static let pulseDuration = 0.5
    private var engine: CHHapticEngine?
    private var player: CHHapticPatternPlayer?

    func start() {
        stop()
        guard CHHapticEngine.capabilitiesForHardware().supportsHaptics else {
            AudioServicesPlaySystemSound(kSystemSoundID_Vibrate)
            return
        }
        do {
            let engine = try CHHapticEngine()
            self.engine = engine
            try engine.start()
            let events = (0..<Self.pulseCount).map { index in
                CHHapticEvent(eventType: .hapticContinuous, parameters: [
                    CHHapticEventParameter(parameterID: .hapticIntensity, value: 1),
                    CHHapticEventParameter(parameterID: .hapticSharpness, value: 0.8)
                ], relativeTime: Double(index) * Self.pulseSpacing, duration: Self.pulseDuration)
            }
            let player = try engine.makePlayer(with: CHHapticPattern(events: events, parameters: []))
            self.player = player
            try player.start(atTime: CHHapticTimeImmediate)
        } catch {
            stop()
            AudioServicesPlaySystemSound(kSystemSoundID_Vibrate)
        }
    }

    func stop() {
        try? player?.stop(atTime: CHHapticTimeImmediate)
        player = nil
        engine?.stop(completionHandler: nil)
        engine = nil
    }
}
