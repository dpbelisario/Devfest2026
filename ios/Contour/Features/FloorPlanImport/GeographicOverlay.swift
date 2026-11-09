import Foundation

/// One geographically aligned image. Dimensions are ground metres; angle is clockwise from north-up.
struct GeographicOverlay: Codable, Equatable {
    var version = 1
    var name: String
    var image: Data
    var latitude: Double
    var longitude: Double
    var width: Double
    var aspect: Double
    var angle: Double = 0
    var opacity: Double = 0.65
    var visible = true
    // Optional for compatibility with floor plans saved before destination pins.
    var destinations: [FloorDestination]? = nil
    var wallGeometry: FloorWallGeometry? = nil
    var walkingNetwork: FloorWalkingNetwork? = nil
    var floor: String? = nil
    var floorName: String { floor ?? "2F" }

    var height: Double { width * aspect }
    var maximumWidth: Double { min(2000, 2000 / aspect) }
    var isValid: Bool {
        ["B1", "1F", "2F", "3F", "4F"].contains(floorName) &&
        (destinations?.count ?? 0) <= 120 && (destinations ?? []).allSatisfy(\.isValid) &&
        Set((destinations ?? []).map(\.id)).count == (destinations?.count ?? 0) &&
        (wallGeometry?.isValid ?? true) && (walkingNetwork?.isValid(for: destinations ?? []) ?? true) &&
        version == 1 && !image.isEmpty && image.count <= 12_000_000 && name.count <= 80 &&
        latitude.isFinite && abs(latitude) < 85 && longitude.isFinite && abs(longitude) <= 180 &&
        width.isFinite && width >= 1 && width <= 2000 && aspect.isFinite && aspect >= 0.05 &&
        aspect <= 20 && height <= 2000 && angle.isFinite && opacity.isFinite && (0.1...1).contains(opacity)
    }
    mutating func rotate(to degrees: Double) {
        guard degrees.isFinite else { return }
        angle = (degrees.truncatingRemainder(dividingBy: 360) + 540).truncatingRemainder(dividingBy: 360) - 180
    }
    mutating func resize(to metres: Double) {
        guard metres.isFinite else { return }
        width = min(maximumWidth, max(1, metres))
    }
    mutating func nudge(east: Double, north: Double) {
        let radius = 6_378_137.0
        latitude = min(84.9, max(-84.9, latitude + north / radius * 180 / .pi))
        longitude += east / (radius * cos(latitude * .pi / 180)) * 180 / .pi
        longitude = (longitude + 540).truncatingRemainder(dividingBy: 360) - 180
    }
}

/// Uniform corner resizing in screen space; the opposite corner stays fixed, including after rotation.
enum OverlayCornerGeometry {
    static func resize(center: CGPoint, width: Double, aspect: Double, angle: Double,
                       corner: CGPoint, translation: CGPoint, minimumWidth: Double, maximumWidth: Double) -> (width: Double, center: CGPoint) {
        let radians = angle * .pi / 180
        let dx = Double(corner.x) * cos(radians) - Double(corner.y) * aspect * sin(radians)
        let dy = Double(corner.x) * sin(radians) + Double(corner.y) * aspect * cos(radians)
        let fixedX = Double(center.x) - dx * width / 2
        let fixedY = Double(center.y) - dy * width / 2
        let proposed = width + (Double(translation.x) * dx + Double(translation.y) * dy) / (dx * dx + dy * dy)
        let resized = min(maximumWidth, max(minimumWidth, proposed))
        return (resized, CGPoint(x: fixedX + dx * resized / 2, y: fixedY + dy * resized / 2))
    }
}

/// A reviewed text-label position in the original image, measured from its top-left.
/// Image-relative coordinates survive all geographic alignment edits.
struct FloorDestination: Codable, Equatable, Identifiable {
    var id = UUID()
    var name: String
    var x: Double
    var y: Double
    var confidence: Float = 1
    var textBounds: CGRect? = nil
    var sourceLabels: [String]? = nil
    var labelGroupingVersion: Int? = nil
    private var validMetadata: Bool {
        if let box = textBounds {
            guard box.minX.isFinite, box.minY.isFinite, box.width.isFinite, box.height.isFinite,
                  box.width > 0, box.height > 0, box.minX >= 0, box.minY >= 0,
                  box.maxX <= 1.000001, box.maxY <= 1.000001 else { return false }
        }
        return (labelGroupingVersion == nil || labelGroupingVersion == 1) && (sourceLabels?.count ?? 0) <= 40 && (sourceLabels ?? []).allSatisfy { !$0.isEmpty && $0.count <= 80 }
    }
    var isValid: Bool {
        validMetadata && !name.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty && name.count <= 80 &&
        x.isFinite && y.isFinite && (0...1).contains(x) && (0...1).contains(y) &&
        confidence.isFinite && (0...1).contains(confidence)
    }
    static func recognized(name: String, boundingBox: CGRect, confidence: Float) -> FloorDestination? {
        let label = name.split(whereSeparator: \.isWhitespace).joined(separator: " ")
        guard !label.isEmpty, label.count <= 80,
              label.unicodeScalars.contains(where: { CharacterSet.alphanumerics.contains($0) }) else { return nil }
        // Vision boxes have a bottom-left origin; the displayed PNG uses top-left.
        let pin = FloorDestination(name: label, x: Double(boundingBox.midX),
            y: 1 - Double(boundingBox.midY), confidence: confidence,
            textBounds: CGRect(x: boundingBox.minX, y: 1 - boundingBox.maxY, width: boundingBox.width, height: boundingBox.height), sourceLabels: [label])
        return pin.isValid ? pin : nil
    }
}

/// Collapse nearby printed caption lines and Japanese/English translations into one destination.
/// Layout is evidence of a shared label, not semantic translation or room-boundary detection.
enum FloorLabelDeduplicator {
    private static func japanese(_ text: String) -> Bool {
        text.unicodeScalars.contains { (0x3040...0x30ff).contains($0.value) || (0x3400...0x9fff).contains($0.value) }
    }
    private static func latin(_ text: String) -> Bool {
        !japanese(text) && text.unicodeScalars.contains { (65...90).contains($0.value) || (97...122).contains($0.value) }
    }
    private static func key(_ text: String) -> String {
        text.folding(options: [.caseInsensitive, .widthInsensitive, .diacriticInsensitive], locale: Locale(identifier: "en_US_POSIX"))
            .filter { !$0.isWhitespace && !$0.isPunctuation }
    }
    private static func labels(_ pin: FloorDestination) -> [String] {
        Array(Set([pin.name] + (pin.sourceLabels ?? []))).sorted()
    }
    private static func bounds(_ pin: FloorDestination) -> CGRect {
        // Older saved pins have only centers. Conservative estimates support migration.
        pin.textBounds ?? CGRect(x: pin.x - 0.025, y: pin.y - 0.009, width: 0.05, height: 0.018)
    }
    private static func aligned(_ a: CGRect, _ b: CGRect) -> Bool {
        let overlap = max(0, min(a.maxX, b.maxX) - max(a.minX, b.minX))
        return overlap >= min(a.width, b.width) * 0.45 &&
            (abs(a.midX - b.midX) <= 0.025 || abs(a.minX - b.minX) <= 0.008)
    }
    static func deduplicate(_ input: [FloorDestination]) -> [FloorDestination] {
        var pins: [FloorDestination] = []
        for pin in input where pin.isValid {
            if let index = pins.firstIndex(where: { other in
                !Set(labels(other).map(key)).isDisjoint(with: labels(pin).map(key)) && hypot(other.x - pin.x, other.y - pin.y) < 0.025
            }) {
                pins[index].sourceLabels = Array(Set(labels(pins[index]) + labels(pin))).sorted()
            } else { pins.append(pin) }
        }
        pins.sort { $0.y == $1.y ? $0.x < $1.x : $0.y < $1.y }
        // Join tightly stacked lines of the same language, e.g. "Reference" + "Books".
        // Real bounding boxes are required: avoid combining manually positioned legacy pins.
        var consumed = Set<UUID>()
        var paragraphs: [FloorDestination] = []
        for var pin in pins where !consumed.contains(pin.id) {
            consumed.insert(pin.id)
            let lineHeight = pin.textBounds?.height
            while let index = pins.indices.first(where: { index in
                let next = pins[index]
                guard pin.labelGroupingVersion == nil, next.labelGroupingVersion == nil, !consumed.contains(next.id), let a = pin.textBounds, let b = next.textBounds, let lineHeight,
                      (latin(pin.name) && latin(next.name) || japanese(pin.name) && japanese(next.name)),
                      b.midY > a.midY, aligned(a, b), a.union(b).height <= 0.11,
                      max(lineHeight, b.height) / min(lineHeight, b.height) <= 1.9,
                      b.minY - a.maxY >= -min(lineHeight, b.height) * 0.25,
                      b.minY - a.maxY <= min(lineHeight, b.height) * 0.4,
                      (pin.name + " " + next.name).count <= 80 else { return false }
                return !pins.contains { blocker in
                    blocker.id != pin.id && blocker.id != next.id &&
                    blocker.y > pin.y && blocker.y < next.y && aligned(bounds(blocker), a) &&
                    japanese(blocker.name) != japanese(pin.name)
                }
            }) {
                let next = pins[index], box = bounds(pin).union(bounds(next))
                pin.name += " " + next.name
                pin.sourceLabels = Array(Set(labels(pin) + labels(next))).sorted()
                pin.textBounds = box; pin.x = box.midX; pin.y = box.midY
                pin.confidence = min(pin.confidence, next.confidence)
                consumed.insert(next.id)
            }
            paragraphs.append(pin)
        }
        // On these bilingual plans the Japanese caption sits immediately above English.
        // Match by column/overlap and line spacing, retaining a single English-named pin.
        var removed = Set<UUID>()
        for jp in paragraphs where jp.labelGroupingVersion == nil && japanese(jp.name) {
            let a = bounds(jp)
            let candidates = paragraphs.indices.filter { index in
                let en = paragraphs[index], b = bounds(en)
                let fontHeight = max(min(a.height, 0.03), min(b.height, 0.03))
                return en.labelGroupingVersion == nil && latin(en.name) && en.y > jp.y && aligned(a, b) &&
                    b.minY - a.maxY >= -fontHeight * 0.3 && b.minY - a.maxY <= fontHeight * 0.95
            }
            if let index = candidates.min(by: {
                let l = paragraphs[$0], r = paragraphs[$1]
                return abs(bounds(l).minY - a.maxY) + abs(l.x - jp.x) < abs(bounds(r).minY - a.maxY) + abs(r.x - jp.x)
            }) {
                paragraphs[index].sourceLabels = Array(Set(labels(paragraphs[index]) + labels(jp))).sorted()
                removed.insert(jp.id)
            }
        }
        return paragraphs.filter { !removed.contains($0.id) }.map { value in
            var pin = value; pin.labelGroupingVersion = 1; return pin
        }.sorted { $0.y == $1.y ? $0.x < $1.x : $0.y < $1.y }
    }
    /// Re-scans collapse saved language variants and retain the surviving saved pin's ID/position.
    static func merge(existing: [FloorDestination], detected: [FloorDestination]) -> [FloorDestination] {
        let fresh = deduplicate(detected)
        var remaining = deduplicate(existing)
        var output: [FloorDestination] = []
        for var pin in fresh {
            let keys = Set(labels(pin).map(key))
            let matches = remaining.filter { !keys.isDisjoint(with: labels($0).map(key)) && hypot($0.x - pin.x, $0.y - pin.y) < 0.065 }
            if let saved = matches.first(where: { latin($0.name) }) ?? matches.first {
                pin.id = saved.id
                // Preserve reviewed names and positions, but replace a former Japanese-only alias.
                if !japanese(saved.name) { pin.name = saved.name; pin.x = saved.x; pin.y = saved.y }
                pin.sourceLabels = Array(Set(labels(pin) + matches.flatMap(labels))).sorted()
                let ids = Set(matches.map(\.id)); remaining.removeAll { ids.contains($0.id) }
            }
            output.append(pin)
        }
        return Array(deduplicate(output + remaining).prefix(120))
    }
}
