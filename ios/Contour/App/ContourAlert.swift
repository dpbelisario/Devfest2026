import ContourShared
import Foundation

struct ContourAlert {
    let kind: String
    let title: String
    let text: String

    /// Shared Kotlin wire kinds are used by both phone apps; unknown values are rejected.
    init?(payload: [AnyHashable: Any]) {
        guard let kind = payload["kind"] as? String,
              AlertKind.companion.fromId(id: kind) != nil else { return nil }
        let alert = (payload["aps"] as? [String: Any])?["alert"] as? [String: Any]
        self.kind = kind
        title = String(((payload["title"] as? String) ?? (alert?["title"] as? String) ?? "SEA").prefix(256))
        text = String(((payload["text"] as? String) ?? (alert?["body"] as? String) ?? "").prefix(2000))
    }

    var payload: [String: String] { ["kind": kind, "title": title, "text": text] }
}
