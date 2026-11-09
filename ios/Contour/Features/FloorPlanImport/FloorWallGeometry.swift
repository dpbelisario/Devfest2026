import Foundation
import UIKit
import SwiftUI
import ImageIO

/// Image-relative coordinates, with the origin at the PNG's top-left.
struct FloorPlanPoint: Codable, Equatable {
    var x: Double
    var y: Double
    var isValid: Bool { x.isFinite && y.isFinite && (0...1).contains(x) && (0...1).contains(y) }
}

struct FloorWallSegment: Codable, Equatable, Identifiable {
    var id = UUID()
    var start: FloorPlanPoint
    var end: FloorPlanPoint
    var isValid: Bool { start.isValid && end.isValid && hypot(end.x - start.x, end.y - start.y) > 0.0001 }
}

/// Detection is only a draft. Constraints are enabled by an explicit review/save.
struct FloorWallGeometry: Codable, Equatable {
    var version = 1
    var walls: [FloorWallSegment] = []
    var openings: [FloorWallSegment] = []
    var reviewed = false
    var isValid: Bool {
        version == 1 && walls.count <= 1000 && openings.count <= 200 &&
        (walls + openings).allSatisfy(\.isValid) && Set((walls + openings).map(\.id)).count == walls.count + openings.count
    }
}

/// Metric wall constraints use the same alignment transform as the image and destination pins.
struct FloorWallMap: Codable {
    let latitude: Double
    let longitude: Double
    let width: Double
    let aspect: Double
    let angle: Double
    let geometry: FloorWallGeometry
    var isValid: Bool {
        latitude.isFinite && abs(latitude) < 85 && longitude.isFinite && abs(longitude) <= 180 &&
        width.isFinite && (1...2000).contains(width) && aspect.isFinite && (0.05...20).contains(aspect) &&
        width * aspect <= 2000 && angle.isFinite && geometry.isValid && geometry.reviewed
    }
    func local(latitude lat: Double, longitude lon: Double) -> CGPoint {
        let east = (lon - longitude) * 111319.49079327358 * cos(latitude * .pi / 180)
        // Match the overlay's Web Mercator transform exactly, including rotation.
        let mercator: (Double) -> Double = { 6378137 * log(tan(.pi / 4 + $0 * .pi / 360)) }
        let south = (mercator(latitude) - mercator(lat)) * cos(latitude * .pi / 180)
        let r = angle * .pi / 180
        return CGPoint(x: east * cos(r) + south * sin(r), y: -east * sin(r) + south * cos(r))
    }
    func metric(_ p: FloorPlanPoint) -> CGPoint { CGPoint(x: (p.x - 0.5) * width, y: (p.y - 0.5) * width * aspect) }

    /// Openings cut collinear wall portions only. A crossing door stroke cannot erase an unrelated wall.
    var barriers: [(CGPoint, CGPoint)] {
        geometry.walls.flatMap { wall -> [(CGPoint, CGPoint)] in
            let a = metric(wall.start), b = metric(wall.end), dx = b.x - a.x, dy = b.y - a.y
            let length = hypot(dx, dy)
            guard length > 0.01 else { return [] }
            var ranges: [(Double, Double)] = [(0, 1)]
            for door in geometry.openings {
                let c = metric(door.start), d = metric(door.end), doorLength = hypot(d.x - c.x, d.y - c.y)
                guard doorLength >= 0.3,
                      abs((d.x - c.x) * dx + (d.y - c.y) * dy) / (length * doorLength) > 0.9,
                      abs((c.x - a.x) * dy - (c.y - a.y) * dx) / length <= 0.35,
                      abs((d.x - a.x) * dy - (d.y - a.y) * dx) / length <= 0.35 else { continue }
                let t1 = ((c.x - a.x) * dx + (c.y - a.y) * dy) / (length * length)
                let t2 = ((d.x - a.x) * dx + (d.y - a.y) * dy) / (length * length)
                let lower = max(0, min(t1, t2)), upper = min(1, max(t1, t2))
                guard upper > lower else { continue }
                ranges = ranges.flatMap { lo, hi -> [(Double, Double)] in
                    if upper <= lo || lower >= hi { return [(lo, hi)] }
                    return [(lo, min(hi, lower)), (max(lo, upper), hi)].filter { $0.1 - $0.0 > 0.00001 }
                }
            }
            return ranges.map { lo, hi in
                (CGPoint(x: a.x + dx * lo, y: a.y + dy * lo), CGPoint(x: a.x + dx * hi, y: a.y + dy * hi))
            }
        }
    }

    static func distance(_ p: CGPoint, to a: CGPoint, _ b: CGPoint) -> Double {
        let dx = b.x - a.x, dy = b.y - a.y, squared = dx * dx + dy * dy
        let t = squared > 0 ? min(1, max(0, ((p.x - a.x) * dx + (p.y - a.y) * dy) / squared)) : 0
        return hypot(p.x - a.x - t * dx, p.y - a.y - t * dy)
    }
    /// Checks the entire step segment, so a long step cannot tunnel through a thin wall.
    static func blocks(from a: CGPoint, to b: CGPoint, barriers: [(CGPoint, CGPoint)]) -> Bool {
        func cross(_ x: CGPoint, _ y: CGPoint, _ z: CGPoint) -> Double {
            (y.x - x.x) * (z.y - x.y) - (y.y - x.y) * (z.x - x.x)
        }
        return barriers.contains { c, d in
            let intersects = cross(a, b, c) * cross(a, b, d) <= 0 && cross(c, d, a) * cross(c, d, b) <= 0 &&
                max(min(a.x, b.x), min(c.x, d.x)) <= min(max(a.x, b.x), max(c.x, d.x)) + 1e-9 &&
                max(min(a.y, b.y), min(c.y, d.y)) <= min(max(a.y, b.y), max(c.y, d.y)) + 1e-9
            // Small numerical margin, not a human-body clearance or a surveyed wall thickness.
            return intersects || (distance(b, to: c, d) < 0.08 && distance(b, to: c, d) < distance(a, to: c, d))
        }
    }
}

/// Lightweight raster detector for upright architectural plans. Long thin dark/green runs
/// are candidates; furniture, coloured labels and diagonal walls still require human review.
enum FloorWallDetector {
    static func detect(_ data: Data, ink: String = "Automatic") throws -> FloorWallGeometry {
        try Task.checkCancellation()
        guard let source = CGImageSourceCreateWithData(data as CFData, nil),
              let image = CGImageSourceCreateThumbnailAtIndex(source, 0, [
                kCGImageSourceCreateThumbnailFromImageAlways: true,
                kCGImageSourceCreateThumbnailWithTransform: true,
                kCGImageSourceThumbnailMaxPixelSize: 1400
              ] as CFDictionary) else { throw CocoaError(.fileReadCorruptFile) }
        let width = image.width, height = image.height
        var pixels = [UInt8](repeating: 255, count: width * height * 4)
        let drawn = pixels.withUnsafeMutableBytes { bytes -> Bool in
            guard let context = CGContext(data: bytes.baseAddress, width: width, height: height, bitsPerComponent: 8,
                bytesPerRow: width * 4, space: CGColorSpaceCreateDeviceRGB(),
                bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue | CGBitmapInfo.byteOrder32Big.rawValue) else { return false }
            context.setFillColor(UIColor.white.cgColor); context.fill(CGRect(x: 0, y: 0, width: width, height: height))
            context.draw(image, in: CGRect(x: 0, y: 0, width: width, height: height)); return true
        }
        guard drawn else { throw CocoaError(.fileReadCorruptFile) }
        var greenMask = [Bool](repeating: false, count: width * height)
        var darkMask = greenMask
        for index in greenMask.indices {
            let i = index * 4, r = Int(pixels[i]), g = Int(pixels[i + 1]), b = Int(pixels[i + 2])
            let dark = max(r, max(g, b)) < 155 && max(r, max(g, b)) - min(r, min(g, b)) < 35
            let green = g > r + 7 && g > b + 18 && g < 195 && r < 175
            greenMask[index] = green; darkMask[index] = dark
        }
        let minimum = max(24, Int(Double(min(width, height)) * 0.035))
        let maximumThickness = max(5, Int(Double(min(width, height)) * 0.012))
        // A coloured architectural plan can have dark boxed captions whose borders look
        // exactly like wall runs. Prefer green only when several thin green runs exist.
        var greenRuns = 0
        for y in 0..<height {
            var x = 0
            while x < width {
                guard greenMask[y * width + x] else { x += 1; continue }
                let lo = x
                while x < width && greenMask[y * width + x] { x += 1 }
                guard x - lo >= minimum else { continue }
                let mid = (lo + x - 1) / 2
                var top = y, bottom = y
                while top > 0 && greenMask[(top - 1) * width + mid] && y - top <= maximumThickness { top -= 1 }
                while bottom + 1 < height && greenMask[(bottom + 1) * width + mid] && bottom - y <= maximumThickness { bottom += 1 }
                if bottom - top + 1 <= maximumThickness { greenRuns += 1 }
            }
        }
        let useGreen = ink == "Green" || (ink == "Automatic" && greenRuns >= 4)
        let mask = useGreen ? greenMask : darkMask
        struct Run { var line: Int; var lo: Int; var hi: Int }
        func scan(horizontal: Bool) throws -> [FloorWallSegment] {
            let across = horizontal ? width : height, lines = horizontal ? height : width
            func ink(_ x: Int, _ y: Int) -> Bool { horizontal ? mask[y * width + x] : mask[x * width + y] }
            var runs: [Run] = []
            for line in 0..<lines {
                if line % 32 == 0 { try Task.checkCancellation() }
                var x = 0
                while x < across {
                    guard ink(x, line) else { x += 1; continue }
                    let lo = x
                    while x < across && ink(x, line) { x += 1 }
                    let hi = x - 1
                    guard hi - lo + 1 >= minimum else { continue }
                    // Reject thick filled rectangles (shelves, headings and background colour).
                    let mid = (lo + hi) / 2
                    var low = line, high = line
                    while low > 0 && ink(mid, low - 1) && line - low <= maximumThickness { low -= 1 }
                    while high + 1 < lines && ink(mid, high + 1) && high - line <= maximumThickness { high += 1 }
                    guard high - low + 1 <= maximumThickness else { continue }
                    runs.append(Run(line: line, lo: lo, hi: hi))
                }
            }
            // Collapse parallel pixel rows into one centerline. Never bridge gaps along a wall.
            var groups: [[Run]] = []
            for run in runs {
                if let index = groups.lastIndex(where: { group in
                    guard let last = group.last else { return false }
                    return run.line - last.line <= maximumThickness &&
                        abs(run.lo - last.lo) <= 4 && abs(run.hi - last.hi) <= 4
                }) { groups[index].append(run) } else { groups.append([run]) }
            }
            return groups.prefix(500).map { group in
                let row = group.map(\.line).reduce(0, +) / group.count
                // Keep the common interval, not the union: avoid sealing small door gaps.
                let lo = group.map(\.lo).max()!, hi = group.map(\.hi).min()!
                func point(_ p: Int) -> FloorPlanPoint {
                    FloorPlanPoint(x: Double(horizontal ? p : row) / Double(width),
                                   y: Double(horizontal ? row : p) / Double(height))
                }
                return FloorWallSegment(start: point(lo), end: point(max(lo + 1, hi)))
            }
        }
        let walls = try scan(horizontal: true) + scan(horizontal: false)
        return FloorWallGeometry(walls: walls.filter(\.isValid))
    }
}

/// Two-tap wall/opening editing remains usable on a phone with zoom and two-axis scrolling.
@available(iOS 17.0, *)
struct FloorWallReview: View {
    @Environment(\.dismiss) private var dismiss
    let image: UIImage
    @State var geometry: FloorWallGeometry
    let save: (FloorWallGeometry) -> Void
    @State private var tool = "Remove"
    @State private var first: FloorPlanPoint?
    @State private var zoom = 1.0
    @State private var history: [FloorWallGeometry] = []
    @State private var checked = false
    @State private var redetecting = false
    @State private var notice = ""
    @State private var ink = "Automatic"
    var body: some View {
        NavigationStack {
            VStack(spacing: 10) {
                Text("Red: likely walls. Green: openings. Check every doorway and remove shelves/text mistaken for walls.").font(.footnote).padding(.horizontal)
                Picker("Edit walls", selection: $tool) {
                    Text("Remove").tag("Remove"); Text("Add wall").tag("Add wall"); Text("Opening").tag("Opening")
                }.pickerStyle(.segmented).padding(.horizontal).onChange(of: tool) { _, _ in first = nil }
                Text(tool == "Remove" ? "Tap a red or green line to remove it." : first == nil ? "Tap the first endpoint. Openings must follow the wall across the doorway." : "Tap the other endpoint. Scroll to reach another part of the plan.")
                    .font(.caption).padding(.horizontal)
                GeometryReader { proxy in
                    let width = max(1, proxy.size.width - 24) * zoom
                    let height = width * image.size.height / image.size.width
                    ScrollView([.horizontal, .vertical]) {
                        Image(uiImage: image).resizable().frame(width: width, height: height)
                            .overlay {
                                Canvas { context, _ in
                                    func draw(_ segment: FloorWallSegment, color: Color) {
                                        var path = Path()
                                        path.move(to: CGPoint(x: segment.start.x * width, y: segment.start.y * height))
                                        path.addLine(to: CGPoint(x: segment.end.x * width, y: segment.end.y * height))
                                        context.stroke(path, with: .color(color.opacity(0.8)), style: StrokeStyle(lineWidth: 3, lineCap: .round))
                                    }
                                    for wall in geometry.walls { draw(wall, color: .red) }
                                    for door in geometry.openings { draw(door, color: .green) }
                                    if let first {
                                        context.fill(Path(ellipseIn: CGRect(x: first.x * width - 5, y: first.y * height - 5, width: 10, height: 10)), with: .color(.blue))
                                    }
                                }.allowsHitTesting(false)
                            }
                            .contentShape(Rectangle())
                            .onTapGesture { p in edit(FloorPlanPoint(x: min(1, max(0, p.x / width)), y: min(1, max(0, p.y / height))), width: width, height: height) }
                            .padding(12)
                    }
                }
                HStack {
                    Text("Zoom"); Slider(value: $zoom, in: 1...4)
                    Button("Undo") { if let last = history.popLast() { geometry = last; checked = false }; first = nil }.disabled(history.isEmpty)
                }.padding(.horizontal)
                HStack {
                    Picker("Wall ink", selection: $ink) {
                        Text("Auto ink").tag("Automatic"); Text("Green walls").tag("Green"); Text("Dark walls").tag("Dark")
                    }
                    Text("Applies to Detect again").font(.caption)
                }.padding(.horizontal)
                HStack {
                    Text("\(geometry.walls.count) walls · \(geometry.openings.count) openings").font(.caption)
                    Spacer()
                    Button("Detect again") { redetect() }.disabled(redetecting)
                    Button("Clear") { remember(); geometry.walls = []; geometry.openings = []; first = nil }
                }.padding(.horizontal)
                if !notice.isEmpty { Text(notice).font(.caption).padding(.horizontal) }
                Toggle("I checked walls and door openings", isOn: $checked).font(.footnote).padding(.horizontal)
                Text("Detection can miss walls and mistake furniture for walls. Saved geometry constrains estimated steps; it does not certify a safe route.")
                    .font(.caption).foregroundStyle(.secondary).padding(.horizontal)
            }
            .navigationTitle("Review walls & openings").navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() } }
                ToolbarItem(placement: .confirmationAction) {
                    Button("Save walls") { var result = geometry; result.reviewed = true; save(result) }
                        .disabled(!checked || !geometry.isValid || redetecting)
                }
            }
            .interactiveDismissDisabled()
        }
    }
    private func remember() { history.append(geometry); if history.count > 30 { history.removeFirst() }; checked = false }
    private func edit(_ point: FloorPlanPoint, width: Double, height: Double) {
        if tool == "Remove" {
            let p = CGPoint(x: point.x * width, y: point.y * height)
            let nearest = (geometry.walls + geometry.openings).map { segment in
                (segment.id, FloorWallMap.distance(p, to: CGPoint(x: segment.start.x * width, y: segment.start.y * height), CGPoint(x: segment.end.x * width, y: segment.end.y * height)))
            }.min { $0.1 < $1.1 }
            if let nearest, nearest.1 <= 22 { remember(); geometry.walls.removeAll { $0.id == nearest.0 }; geometry.openings.removeAll { $0.id == nearest.0 } }
        } else if let start = first {
            let segment = FloorWallSegment(start: start, end: point)
            guard segment.isValid else { return }
            if tool == "Add wall" && geometry.walls.count < 1000 { remember(); geometry.walls.append(segment) }
            if tool == "Opening" && geometry.openings.count < 200 { remember(); geometry.openings.append(segment) }
            first = nil
        } else { first = point }
    }
    private func redetect() {
        guard let data = image.pngData() else { return }
        redetecting = true; first = nil
        Task {
            do {
                let detected = try await OverlayDisk.shared.detectWalls(data, ink: ink)
                remember(); geometry = detected; notice = "Detection replaced this draft. Undo restores your edits."
            } catch { notice = "Detection failed. Your edits were kept." }
            redetecting = false
        }
    }
}
