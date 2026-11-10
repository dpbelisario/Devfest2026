import Foundation

enum WebOrigin {
    static func sameOrigin(_ left: URL, _ right: URL) -> Bool {
        left.scheme == "https" && right.scheme == "https" && left.host == right.host && (left.port ?? 443) == (right.port ?? 443)
    }

    static func sameOrigin(scheme: String, host: String, port: Int, to url: URL) -> Bool {
        scheme == "https" && url.scheme == "https" && host == url.host && (port == 0 ? 443 : port) == (url.port ?? 443)
    }
}
