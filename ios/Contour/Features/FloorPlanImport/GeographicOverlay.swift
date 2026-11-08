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

    var height: Double { width * aspect }
    var maximumWidth: Double { min(2000, 2000 / aspect) }
    var isValid: Bool {
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
