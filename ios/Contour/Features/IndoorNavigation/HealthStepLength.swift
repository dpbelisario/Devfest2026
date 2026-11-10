import Foundation
import HealthKit

struct HealthStepLengthSummary {
    let metres: Double
    let sampleCount: Int
    let latest: Date

    /// Median of recent usable samples; the tracker accepts 0.4–1.1 metres per step.
    static func summarize(_ samples: [(metres: Double, date: Date)], now: Date = Date()) -> Self? {
        let valid = samples.filter {
            $0.metres.isFinite && (0.4...1.1).contains($0.metres) &&
                $0.date <= now && $0.date >= now.addingTimeInterval(-30 * 86400)
        }.sorted { $0.date > $1.date }.prefix(50)
        let lengths = valid.map(\.metres).sorted()
        guard !lengths.isEmpty, let latest = valid.first?.date else { return nil }
        let middle = lengths.count / 2
        let median = lengths.count.isMultiple(of: 2) ? (lengths[middle - 1] + lengths[middle]) / 2 : lengths[middle]
        return Self(metres: median, sampleCount: lengths.count, latest: latest)
    }
}

/// Requests only read access to Walking Step Length. Raw samples stay in native memory.
@MainActor
final class HealthStepLengthImporter {
    private let store = HKHealthStore()
    static var available: Bool { HKHealthStore.isHealthDataAvailable() }

    func load() async throws -> HealthStepLengthSummary? {
        let type = HKQuantityType(.walkingStepLength)
        // Completion means the permission sheet finished, not that read access was granted.
        try await store.requestAuthorization(toShare: [], read: [type])
        try Task.checkCancellation()
        let now = Date()
        let predicate = HKQuery.predicateForSamples(withStart: now.addingTimeInterval(-30 * 86400),
            end: now, options: [.strictStartDate, .strictEndDate])
        let samples: [HKQuantitySample] = try await withCheckedThrowingContinuation { continuation in
            let query = HKSampleQuery(sampleType: type, predicate: predicate, limit: 50,
                sortDescriptors: [NSSortDescriptor(key: HKSampleSortIdentifierEndDate, ascending: false)]) { _, samples, error in
                    if let error { continuation.resume(throwing: error) }
                    else { continuation.resume(returning: samples as? [HKQuantitySample] ?? []) }
                }
            store.execute(query)
        }
        try Task.checkCancellation()
        return HealthStepLengthSummary.summarize(samples.map { ($0.quantity.doubleValue(for: .meter()), $0.endDate) }, now: now)
    }
}
