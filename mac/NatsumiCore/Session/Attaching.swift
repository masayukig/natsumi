import Foundation

/// The rules of attaching files that the Mac and the iPhone share (ADR 0071).
enum Attaching {
    /// The files that go with a message the owner sends, taken out of the drafts; nil when nothing is to be sent. A
    /// message waits while a file is still going up, and its files alone are a message. The drafts that failed go
    /// with it.
    static func takeForSending(_ text: String, drafts: inout AttachmentDrafts) -> [ShownAttachment]? {
        guard !drafts.isUploading else { return nil }
        let ready = drafts.ready
        guard !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || !ready.isEmpty else { return nil }
        drafts.clear()
        return ready
    }

    /// The pictures the owner attached to these messages, to fetch by their upload IDs.
    static func pictureIds(_ messages: [ShownMessage]) -> [String] {
        messages.flatMap { $0.attachments.filter(\.isImage).map(\.uploadId) }
    }
}
