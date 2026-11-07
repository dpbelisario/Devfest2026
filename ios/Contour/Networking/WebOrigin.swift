import Foundation

enum WebOrigin {
    static func sameOrigin(_ left: URL, _ right: URL) -> Bool {
        left.scheme == "https" && right.scheme == "https" && left.host == right.host && (left.port ?? 443) == (right.port ?? 443)
    }
}
