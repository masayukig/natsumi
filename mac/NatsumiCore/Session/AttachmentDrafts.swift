import Foundation

/// A file the owner chose, pasted or dropped, before it goes up (ADR 0071). The adapter that took it in has already
/// read its name and size; the bytes are read when it is uploaded.
public struct PickedFile: Equatable, Sendable {
    public enum Source: Equatable, Sendable {
        /// A file on this device, read from where it is.
        case file(URL)
        /// Bytes with no file of their own: a pasted picture, or a photo from the library.
        case data(Data)
    }

    public let name: String
    public let bytes: Int
    public let source: Source

    public init(name: String, bytes: Int, source: Source) {
        self.name = name
        self.bytes = bytes
        self.source = source
    }
}

/// A file to upload, under the ID its draft has on this device.
public struct PendingUpload: Equatable, Sendable {
    public let localId: String
    public let file: PickedFile
}

/// One file waiting to go with the next message.
public struct DraftAttachment: Equatable, Sendable {
    public enum Status: Equatable, Sendable {
        case uploading
        case ready(ShownAttachment)
        /// It will not go; the words say why.
        case failed(String)
    }

    public let localId: String
    public let name: String
    public let bytes: Int
    public internal(set) var status: Status
    /// A small copy of a picture, made on this device while it goes up.
    public internal(set) var preview: LoadedImage?
}

/// The files for the next message: each goes up as it is chosen, and the message takes those that are up
/// (ADR 0071, client-contract「ファイルの添付」). It is part of the mediator's state; the root only uploads what it is
/// asked to.
public struct AttachmentDrafts: Equatable, Sendable {
    public private(set) var items: [DraftAttachment] = []
    /// The local IDs are never used twice, so that an answer to a draft that was removed finds nothing.
    private var count = 0

    public init() {}

    /// Takes the files in, failing those past the server's limits at once, and returns the ones to upload. Without
    /// the limits nothing is checked here, and the server's answer decides.
    public mutating func add(_ files: [PickedFile], limits: UploadLimits?) -> [PendingUpload] {
        var uploads: [PendingUpload] = []
        for file in files {
            count += 1
            let localId = "file-\(count)"
            let going = items.filter { if case .failed = $0.status { false } else { true } }.count
            var status = DraftAttachment.Status.uploading
            if let limits, file.bytes > limits.maxFileBytes {
                status = .failed("\(Self.sizeWords(limits.maxFileBytes)) までです")
            } else if let limits, going >= limits.maxFiles {
                status = .failed("ひとつのメッセージに添えられるのは \(limits.maxFiles) 個までです")
            } else {
                uploads.append(PendingUpload(localId: localId, file: file))
            }
            items.append(DraftAttachment(localId: localId, name: file.name, bytes: file.bytes, status: status))
        }
        return uploads
    }

    /// Puts what came of an upload in its place. An answer for a draft that is gone is dropped.
    public mutating func finish(_ localId: String, _ result: UploadResult) {
        guard let index = items.firstIndex(where: { $0.localId == localId }), items[index].status == .uploading else { return }
        items[index].status = switch result {
        case .uploaded(let shown): .ready(shown)
        case .failed(let failure): .failed(Self.failureWords(failure))
        }
    }

    public mutating func preview(_ localId: String, _ image: LoadedImage) {
        guard let index = items.firstIndex(where: { $0.localId == localId }) else { return }
        items[index].preview = image
    }

    public mutating func remove(_ localId: String) {
        items.removeAll { $0.localId == localId }
    }

    /// The message went, or the session did: every draft goes with it.
    public mutating func clear() {
        items = []
    }

    /// A message waits until no file is still going up.
    public var isUploading: Bool { items.contains { $0.status == .uploading } }

    /// The files that are up, in the order shown.
    public var ready: [ShownAttachment] {
        items.compactMap { if case .ready(let shown) = $0.status { shown } else { nil } }
    }

    static func failureWords(_ failure: UploadFailure) -> String {
        switch failure {
        case .tooLarge: "大きすぎるため上げられませんでした"
        case .unauthorized: "ログインが切れていて上げられませんでした"
        case .failed: "上げられませんでした"
        }
    }

    /// A file's size as the owner reads it: bytes, then KB and MB to one place, dropping a place of 0.
    public static func sizeWords(_ bytes: Int) -> String {
        if bytes < 1024 { return "\(bytes) B" }
        let (value, unit) = bytes < 1024 * 1024 ? (Double(bytes) / 1024, "KB") : (Double(bytes) / 1024 / 1024, "MB")
        let rounded = (value * 10).rounded() / 10
        let text = rounded == rounded.rounded() ? String(Int(rounded)) : String(format: "%.1f", rounded)
        return "\(text) \(unit)"
    }
}
