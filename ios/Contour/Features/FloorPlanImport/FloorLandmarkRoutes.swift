import Foundation
import CryptoKit
import SwiftUI

struct FloorWalkingPoint: Codable, Equatable, Identifiable {
    var destinationID: UUID
    var position: FloorPlanPoint
    var id: UUID { destinationID }
}

struct FloorWalkingConnection: Codable, Equatable, Identifiable {
    var id = UUID()
    var from: UUID
    var to: UUID
    var via: [FloorPlanPoint] = []
}

/// Reviewed bidirectional passages between named landmarks. Coordinates belong to the image,
/// so walking points can sit in an aisle rather than on an OCR caption or bookshelf.
struct FloorWalkingNetwork: Codable, Equatable {
    var version = 1
    var points: [FloorWalkingPoint] = []
    var connections: [FloorWalkingConnection] = []
    var reviewed = false
    func isValid(for destinations: [FloorDestination]) -> Bool {
        let ids = Set(points.map(\.id)), destinationIDs = Set(destinations.map(\.id))
        return version == 1 && points.count <= 120 && connections.count <= 600 && ids.count == points.count &&
            ids.isSubset(of: destinationIDs) && points.allSatisfy { $0.position.isValid } &&
            Set(connections.map(\.id)).count == connections.count &&
            Set(connections.map { [$0.from.uuidString, $0.to.uuidString].sorted().joined(separator: ":") }).count == connections.count &&
            connections.allSatisfy { $0.from != $0.to && ids.contains($0.from) && ids.contains($0.to) &&
                $0.via.count <= 24 && $0.via.allSatisfy(\.isValid) }
    }
    /// OCR rescans may remove/merge pin IDs. Never leave dangling connections in a saved plan.
    func pruning(destinations: [FloorDestination]) -> FloorWalkingNetwork {
        var result = self
        let ids = Set(destinations.map(\.id))
        result.points.removeAll { !ids.contains($0.id) }
        let remaining = Set(result.points.map(\.id))
        result.connections.removeAll { !remaining.contains($0.from) || !remaining.contains($0.to) }
        if result != self { result.reviewed = false }
        return result
    }
    static func draft(for overlay: GeographicOverlay) -> FloorWalkingNetwork {
        var result = overlay.walkingNetwork?.pruning(destinations: overlay.destinations ?? []) ?? FloorWalkingNetwork()
        for pin in overlay.destinations ?? [] where !result.points.contains(where: { $0.id == pin.id }) {
            result.points.append(.init(destinationID: pin.id, position: .init(x: pin.x, y: pin.y)))
            result.reviewed = false
        }
        return result
    }
    func path(_ edge: FloorWalkingConnection) -> [FloorPlanPoint] {
        guard let from = points.first(where: { $0.id == edge.from }), let to = points.first(where: { $0.id == edge.to }) else { return [] }
        return [from.position] + edge.via + [to.position]
    }
}

struct FloorLandmarkRoute: Codable {
    struct Coordinate: Codable { let latitude: Double; let longitude: Double }
    let status: String
    let floor: String
    let routingRevision: String
    let message: String
    var instructions: [String] = []
    var landmarkIDs: [UUID] = []
    var path: [Coordinate] = []
    var distance: Double = 0
}

/// Wall-constrained visibility graph over landmark pins, with optional reviewed bent passages.
/// Dijkstra compares (connection count, metres): fewer intermediate pins take priority over distance.
enum FloorLandmarkPlanner {
    static func revision(_ overlay: GeographicOverlay) throws -> String {
        // Exclude opacity/visibility; include the image and every item that can change route validity.
        struct Revision: Encodable {
            let image: String; let floor: String; let latitude: Double; let longitude: Double
            let width: Double; let aspect: Double; let angle: Double
            let destinations: [FloorDestination]; let walls: FloorWallGeometry?; let network: FloorWalkingNetwork?
        }
        let value = Revision(image: SHA256.hash(data: overlay.image).map { String(format: "%02x", $0) }.joined(),
            floor: overlay.floorName, latitude: overlay.latitude, longitude: overlay.longitude,
            width: overlay.width, aspect: overlay.aspect, angle: overlay.angle,
            destinations: overlay.destinations ?? [], walls: overlay.wallGeometry, network: overlay.walkingNetwork)
        let encoder = JSONEncoder(); encoder.outputFormatting = [.sortedKeys]
        return SHA256.hash(data: try encoder.encode(value)).map { String(format: "%02x", $0) }.joined()
    }
    static func length(_ path: [FloorPlanPoint], overlay: GeographicOverlay) -> Double {
        zip(path, path.dropFirst()).reduce(0) { $0 + hypot(($1.1.x - $1.0.x) * overlay.width, ($1.1.y - $1.0.y) * overlay.height) }
    }
    static func barriers(_ overlay: GeographicOverlay) -> [(CGPoint, CGPoint)] {
        guard let geometry = overlay.wallGeometry, geometry.reviewed else { return [] }
        return FloorWallMap(latitude: overlay.latitude, longitude: overlay.longitude, width: overlay.width,
            aspect: overlay.aspect, angle: overlay.angle, geometry: geometry).barriers
    }
    static func blocked(_ path: [FloorPlanPoint], overlay: GeographicOverlay, barriers: [(CGPoint, CGPoint)]) -> Bool {
        func metric(_ p: FloorPlanPoint) -> CGPoint { CGPoint(x: p.x * overlay.width, y: p.y * overlay.height) }
        let translated = barriers.map { (CGPoint(x: $0.0.x + overlay.width / 2, y: $0.0.y + overlay.height / 2),
                                         CGPoint(x: $0.1.x + overlay.width / 2, y: $0.1.y + overlay.height / 2)) }
        return zip(path, path.dropFirst()).contains { FloorWallMap.blocks(from: metric($0.0), to: metric($0.1), barriers: translated) }
    }
    static func suggest(_ network: FloorWalkingNetwork, overlay: GeographicOverlay) -> FloorWalkingNetwork {
        var result = network; result.reviewed = false
        let walls = barriers(overlay)
        // Draft only: nearest two visible neighbours within 18 m. Human review must establish access.
        for point in network.points {
            let nearby = network.points.filter { $0.id != point.id }.sorted {
                length([point.position, $0.position], overlay: overlay) < length([point.position, $1.position], overlay: overlay)
            }.filter { length([point.position, $0.position], overlay: overlay) <= 18 }
                .filter { !blocked([point.position, $0.position], overlay: overlay, barriers: walls) }.prefix(2)
            for next in nearby where result.connections.count < 600 {
                if !result.connections.contains(where: { Set([$0.from, $0.to]) == Set([point.id, next.id]) }) {
                    result.connections.append(.init(from: point.id, to: next.id))
                }
            }
        }
        return result
    }
    static func plan(overlay: GeographicOverlay, start: UUID, destination: UUID) throws -> FloorLandmarkRoute {
        let revision = try revision(overlay)
        func result(_ status: String, _ message: String) -> FloorLandmarkRoute {
            .init(status: status, floor: overlay.floorName, routingRevision: revision, message: message)
        }
        guard overlay.isValid, let first = overlay.destinations?.first(where: { $0.id == start }),
              let last = overlay.destinations?.first(where: { $0.id == destination }) else {
            return result("invalid", "Choose a saved start and destination on this floor.")
        }
        if start == destination {
            var value = result("same-place", "Your chosen start and destination are both \(first.name).")
            value.instructions = ["Start and finish at \(first.name). No walking sequence is needed."]; value.landmarkIDs = [start]
            return value
        }
        guard overlay.wallGeometry?.reviewed == true, !(overlay.wallGeometry?.walls.isEmpty ?? true) else {
            return result("needs-walls", "Detect, review and save the floor's walls and door openings first. A wall-avoiding route needs that geometry.")
        }
        let walls = barriers(overlay)
        guard !walls.isEmpty else { return result("needs-walls", "No wall barriers remain. Review the saved walls and openings before generating a route.") }
        let network = overlay.walkingNetwork?.reviewed == true ? overlay.walkingNetwork : nil
        let points: [FloorWalkingPoint] = (overlay.destinations ?? []).filter { pin in
            pin.id == start || pin.id == destination || pin.name.range(of: "^(?:B[0-9]+|[0-9]+\\s*F|F\\s*[0-9]+|[0-9]+階)$", options: [.regularExpression, .caseInsensitive]) == nil
        }.map { pin in
            network?.points.first(where: { $0.id == pin.id }) ?? .init(destinationID: pin.id, position: .init(x: pin.x, y: pin.y))
        }
        struct Hop { let to: UUID; let path: [FloorPlanPoint]; let cost: Double }
        var adjacency: [UUID: [Hop]] = [:]
        func add(from: UUID, to: UUID, path: [FloorPlanPoint]) {
            let cost = length(path, overlay: overlay)
            adjacency[from, default: []].append(Hop(to: to, path: path, cost: cost))
            adjacency[to, default: []].append(Hop(to: from, path: Array(path.reversed()), cost: cost))
        }
        // Cache metric positions and barriers once; each candidate checks its entire segment.
        let metric = points.map { CGPoint(x: ($0.position.x - 0.5) * overlay.width, y: ($0.position.y - 0.5) * overlay.height) }
        for i in points.indices {
            try Task.checkCancellation()
            for j in points.indices where j > i {
                guard hypot(metric[i].x - metric[j].x, metric[i].y - metric[j].y) > 0.05,
                      !FloorWallMap.blocks(from: metric[i], to: metric[j], barriers: walls) else { continue }
                add(from: points[i].id, to: points[j].id, path: [points[i].position, points[j].position])
            }
        }
        let idsInGraph = Set(points.map(\.id))
        for edge in network?.connections ?? [] where idsInGraph.contains(edge.from) && idsInGraph.contains(edge.to) {
            let path = network!.path(edge), cost = length(path, overlay: overlay)
            guard cost > 0.05, !blocked(path, overlay: overlay, barriers: walls) else { continue }
            add(from: edge.from, to: edge.to, path: path)
        }
        struct Cost {
            let hops: Int
            let metres: Double
            func precedes(_ other: Cost) -> Bool { hops == other.hops ? metres < other.metres : hops < other.hops }
        }
        var costs = [start: Cost(hops: 0, metres: 0)], previous: [UUID: (UUID, Hop)] = [:], visited = Set<UUID>()
        while let current = costs.keys.filter({ !visited.contains($0) }).min(by: {
            let a = costs[$0]!, b = costs[$1]!
            return a.hops == b.hops && a.metres == b.metres ? $0.uuidString < $1.uuidString : a.precedes(b)
        }) {
            if current == destination { break }
            visited.insert(current)
            for hop in adjacency[current] ?? [] {
                let cost = Cost(hops: costs[current]!.hops + 1, metres: costs[current]!.metres + hop.cost)
                if costs[hop.to].map({ cost.precedes($0) }) ?? true { costs[hop.to] = cost; previous[hop.to] = (current, hop) }
            }
        }
        guard let total = costs[destination] else {
            return result("no-path", "No wall-clear path through the available pins reaches this destination. Check the wall openings and walking points, or add a passage with bends.")
        }
        var hops: [Hop] = [], ids = [destination], cursor = destination
        while cursor != start {
            guard let entry = previous[cursor] else { return result("no-path", "No connected walking sequence is available.") }
            hops.insert(entry.1, at: 0); cursor = entry.0; ids.insert(cursor, at: 0)
        }
        let names = Dictionary(uniqueKeysWithValues: (overlay.destinations ?? []).map { ($0.id, $0.name) })
        var value = result("ok", "Fewest stops, shortest walk.")
        var path: [FloorPlanPoint] = [], incoming: (Double, Double)?
        for (index, hop) in hops.enumerated() {
            let segments = zip(hop.path, hop.path.dropFirst()).map { (($0.1.x - $0.0.x) * overlay.width, ($0.1.y - $0.0.y) * overlay.height) }
                .filter { hypot($0.0, $0.1) > 0.05 }
            let from = names[ids[index]] ?? "landmark", to = names[hop.to] ?? "destination"
            let distanceLabel = hop.cost < 1 ? "less than 1 m" : "about \(Int(hop.cost.rounded())) m"
            var action = "continue"
            if let incoming, let next = segments.first {
                let angle = atan2(incoming.0 * next.1 - incoming.1 * next.0, incoming.0 * next.0 + incoming.1 * next.1) * 180 / .pi
                if abs(angle) > 150 { action = "turn back along the marked passage" }
                else if angle > 35 { action = "turn right" }
                else if angle < -35 { action = "turn left" }
            }
            value.instructions.append(index == 0
                ? "From \(from), follow the marked passage toward \(to) (\(distanceLabel))."
                : "At \(from), \(action) and follow the marked passage toward \(to) (\(distanceLabel)).")
            incoming = segments.last
            path += index == 0 ? hop.path : Array(hop.path.dropFirst())
        }
        value.instructions.append("Finish at the marked approach point for \(last.name).")
        value.landmarkIDs = ids; value.distance = total.metres
        value.path = path.map { p in
            let r = overlay.angle * .pi / 180, dx = (p.x - 0.5) * overlay.width, dy = (p.y - 0.5) * overlay.height
            let east = dx * cos(r) - dy * sin(r), south = dx * sin(r) + dy * cos(r), scale = cos(overlay.latitude * .pi / 180)
            let y = 6378137 * log(tan(.pi / 4 + overlay.latitude * .pi / 360)) - south / scale
            return .init(latitude: atan(sinh(y / 6378137)) * 180 / .pi,
                longitude: overlay.longitude + east / (6378137 * scale) * 180 / .pi)
        }
        return value
    }
}

@available(iOS 17.0, *)
struct FloorWalkingConnectionReview: View {
    @Environment(\.dismiss) private var dismiss
    let overlay: GeographicOverlay
    @State var network: FloorWalkingNetwork
    let save: (FloorWalkingNetwork) -> Void
    @State private var tool = "Move point"
    @State private var selected: UUID?
    @State private var target: UUID?
    @State private var bends: [FloorPlanPoint] = []
    @State private var zoom = 1.0
    @State private var checked = false
    @State private var history: [FloorWalkingNetwork] = []
    private let wallBarriers: [(CGPoint, CGPoint)]
    init(overlay: GeographicOverlay, network: FloorWalkingNetwork, save: @escaping (FloorWalkingNetwork) -> Void) {
        self.overlay = overlay; _network = State(initialValue: network); self.save = save
        wallBarriers = FloorLandmarkPlanner.barriers(overlay)
    }
    private var pins: [FloorDestination] { overlay.destinations ?? [] }
    private func name(_ id: UUID) -> String { pins.first { $0.id == id }?.name ?? "Landmark" }
    private func blocked(_ edge: FloorWalkingConnection) -> Bool { FloorLandmarkPlanner.blocked(network.path(edge), overlay: overlay, barriers: wallBarriers) }
    var body: some View {
        NavigationStack {
            VStack(spacing: 8) {
                Text("Place each walking point in the aisle beside its landmark. Connect only passages people can walk through; add bends around shelves.").font(.footnote).padding(.horizontal)
                Picker("Connection tool", selection: $tool) { Text("Move point").tag("Move point"); Text("Draw connection").tag("Draw connection") }
                    .pickerStyle(.segmented).padding(.horizontal).onChange(of: tool) { _, _ in bends = [] }
                HStack {
                    pointPicker(tool == "Move point" ? "Landmark" : "From", selection: $selected)
                    if tool != "Move point" { pointPicker("To", selection: $target) }
                }.padding(.horizontal)
                Text(tool == "Move point" ? "Choose a landmark above, then tap its walking point on the image." : "Choose From and To. Tap the image to add passage bends, then Add connection.")
                    .font(.caption).padding(.horizontal)
                GeometryReader { proxy in
                    let width = max(1, proxy.size.width - 24) * zoom, height = width * overlay.aspect
                    ScrollView([.horizontal, .vertical]) {
                        if let image = UIImage(data: overlay.image) {
                            Image(uiImage: image).resizable().frame(width: width, height: height)
                                .overlay {
                                    Canvas { context, _ in
                                        func draw(_ points: [FloorPlanPoint], _ color: Color) {
                                            guard let first = points.first else { return }
                                            var path = Path(); path.move(to: CGPoint(x: first.x * width, y: first.y * height))
                                            for p in points.dropFirst() { path.addLine(to: CGPoint(x: p.x * width, y: p.y * height)) }
                                            context.stroke(path, with: .color(color.opacity(0.8)), style: StrokeStyle(lineWidth: 3, lineCap: .round))
                                        }
                                        for edge in network.connections { draw(network.path(edge), blocked(edge) ? .red : .blue) }
                                        if tool == "Draw connection", let selected, let p = network.points.first(where: { $0.id == selected }) {
                                            draw([p.position] + bends + (target.flatMap { id in network.points.first { $0.id == id } }.map { [$0.position] } ?? []), .orange)
                                        }
                                        for (index, pin) in pins.enumerated() {
                                            guard let p = network.points.first(where: { $0.id == pin.id })?.position else { continue }
                                            let box = CGRect(x: p.x * width - 12, y: p.y * height - 12, width: 24, height: 24)
                                            context.fill(Path(ellipseIn: box), with: .color(pin.id == selected ? .orange : .blue))
                                            context.draw(Text("\(index + 1)").font(.caption.bold()).foregroundStyle(.white), at: CGPoint(x: box.midX, y: box.midY))
                                        }
                                    }.allowsHitTesting(false)
                                }
                                .contentShape(Rectangle()).onTapGesture { p in
                                    let point = FloorPlanPoint(x: min(1, max(0, p.x / width)), y: min(1, max(0, p.y / height)))
                                    if tool == "Move point", let index = network.points.firstIndex(where: { $0.id == selected }) { remember(); network.points[index].position = point }
                                    else if tool == "Draw connection" && bends.count < 24 { bends.append(point) }
                                }.padding(12)
                        }
                    }
                }
                HStack {
                    Text("Zoom"); Slider(value: $zoom, in: 1...4)
                    Button("Undo") { if !bends.isEmpty { bends.removeLast() } else if let last = history.popLast() { network = last; checked = false } }
                        .disabled(history.isEmpty && bends.isEmpty)
                }.padding(.horizontal)
                HStack {
                    Button("Suggest nearby links") { remember(); network = FloorLandmarkPlanner.suggest(network, overlay: overlay) }
                    Button("Add connection") { addConnection() }.disabled(tool != "Draw connection" || selected == nil || target == nil || selected == target || network.connections.count >= 600)
                }.padding(.horizontal)
                List {
                    if network.connections.isEmpty { Text("No connections yet. Suggestions are drafts; review every passage.") }
                    ForEach(network.connections) { edge in
                        VStack(alignment: .leading) {
                            Text("\(name(edge.from)) ↔ \(name(edge.to))").font(.caption)
                            if blocked(edge) { Text("Crosses a mapped wall. Fix points, bends or doorway geometry.").font(.caption2).foregroundStyle(.red) }
                        }
                    }.onDelete { offsets in remember(); network.connections.remove(atOffsets: offsets) }
                }.frame(height: 110)
                Toggle("I checked these walking points and connections", isOn: $checked).font(.footnote).padding(.horizontal)
                Text("Blue: connections. Red: mapped-wall conflict. Draft suggestions do not establish access through furniture or closed rooms.")
                    .font(.caption).foregroundStyle(.secondary).padding(.horizontal)
            }
            .navigationTitle("Walking connections").navigationBarTitleDisplayMode(.inline)
            .onAppear { selected = selected ?? pins.first?.id; target = target ?? pins.dropFirst().first?.id }
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() } }
                ToolbarItem(placement: .confirmationAction) {
                    Button("Save") { var value = network; value.reviewed = true; save(value) }
                        .disabled(!checked || !network.isValid(for: pins) || network.connections.contains(where: blocked))
                }
            }.interactiveDismissDisabled()
        }
    }
    private func pointPicker(_ title: String, selection: Binding<UUID?>) -> some View {
        Picker(title, selection: selection) {
            Text("Choose landmark").tag(UUID?.none)
            ForEach(Array(pins.enumerated()), id: \.element.id) { index, pin in Text("\(index + 1). \(pin.name)").tag(Optional(pin.id)) }
        }.frame(maxWidth: .infinity).clipped().onChange(of: selection.wrappedValue) { _, _ in bends = [] }
    }
    private func remember() { history.append(network); if history.count > 30 { history.removeFirst() }; checked = false; network.reviewed = false }
    private func addConnection() {
        guard let selected, let target, selected != target else { return }
        remember()
        network.connections.removeAll { Set([$0.from, $0.to]) == Set([selected, target]) }
        network.connections.append(.init(from: selected, to: target, via: bends)); bends = []
    }
}
