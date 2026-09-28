import CryptoKit
import Foundation

public enum AvatarReceiveError: Error, Equatable {
    /// `GET /v1/avatar` did not answer with a listing of the contract's shape.
    case invalidListing
    /// A file came with another length than the listing says.
    case wrongSize(String)
    /// A file came with other bytes than the listing says.
    case wrongDigest(String)
    /// Every file checked out, and still they do not load as an avatar.
    case unreadable
}

/// One file of the avatar the server hands out.
public struct AvatarListingFile: Codable, Equatable, Sendable {
    public let path: String
    public let bytes: Int
    public let sha256: String
}

/// What `GET /v1/avatar` answers (client-contract「アバター」): the version, the avatar's ID and name, and its files.
public struct AvatarListing: Codable, Equatable, Sendable {
    public let version: String
    public let id: String
    public let name: String
    public let files: [AvatarListingFile]

    /// Reads a listing, refusing one whose values are not of the contract's shape. The paths become paths under the
    /// copy, so one that could leave it is refused here.
    public static func decode(_ data: Data) throws -> AvatarListing {
        guard let listing = try? JSONDecoder().decode(AvatarListing.self, from: data),
              isHex(listing.version, count: 32), isID(listing.id), isName(listing.name),
              listing.files.allSatisfy({ AvatarManifest.isInside($0.path) && $0.bytes >= 0 && isHex($0.sha256, count: 64) })
        else { throw AvatarReceiveError.invalidListing }
        return listing
    }

    private static func isHex(_ text: String, count: Int) -> Bool {
        text.utf8.count == count && text.utf8.allSatisfy { (48...57).contains($0) || (97...102).contains($0) }
    }

    /// A lower-case letter, then lower-case letters, digits and `-`, 32 in all at most.
    private static func isID(_ text: String) -> Bool {
        let bytes = Array(text.utf8)
        guard let first = bytes.first, (97...122).contains(first), bytes.count <= 32 else { return false }
        return bytes.allSatisfy { (97...122).contains($0) || (48...57).contains($0) || $0 == 45 }
    }

    /// 1 to 32 characters, with no line breaks or other control characters.
    private static func isName(_ text: String) -> Bool {
        (1...32).contains(text.count) && !text.unicodeScalars.contains { CharacterSet.controlCharacters.contains($0) }
    }
}

/// Where the avatar is handed out. Neither needs a login: her looks and her name are no secret (ADR 0057).
public enum AvatarAPI {
    public static func listingRequest(server: ServerAddress) -> URLRequest {
        var request = URLRequest(url: server.url(path: "/v1/avatar"))
        request.httpMethod = "GET"
        // The listing is what says whether the copy is still the one to have; an old answer would say it wrongly.
        request.cachePolicy = .reloadIgnoringLocalCacheData
        return request
    }

    /// A file of one version. The version is in the URL, so files of two versions never mix.
    public static func fileRequest(server: ServerAddress, version: String, path: String) -> URLRequest {
        let escaped = path.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed) ?? path
        var request = URLRequest(url: server.url(path: "/v1/avatar/\(version)/\(escaped)"))
        request.httpMethod = "GET"
        return request
    }
}

/// The avatar as the app has it: what it looks like, its ID and name, and the version it came as.
public struct ReceivedAvatar: Equatable, Sendable {
    public let art: AvatarArt
    public let id: String
    public let name: String
    public let version: String

    public init(art: AvatarArt, id: String, name: String, version: String) {
        self.art = art
        self.id = id
        self.name = name
        self.version = version
    }
}

/// The copy of the server's avatar kept on this device, so that the app starts with it without asking the server.
///
/// There is one copy, in `current` under the directory, and it is only ever replaced whole: a new version is fetched
/// into a directory of its own, every file checked against the listing and the whole loaded as an avatar, and only
/// then does it take the place of the copy. Anything that goes wrong on the way leaves the copy as it was.
public struct AvatarCopy: Sendable {
    public let directory: URL

    public init(directory: URL) {
        self.directory = directory
    }

    private var current: URL { directory.appendingPathComponent("current", isDirectory: true) }
    /// What the copy is, beside its files. The server hands out no file of this name.
    private static let recordName = ".received.json"

    private struct Record: Codable {
        let version: String
        let id: String
        let name: String
    }

    /// The copy, or nil when there is none or it cannot be read.
    public func load() -> ReceivedAvatar? {
        guard let data = try? Data(contentsOf: current.appendingPathComponent(Self.recordName)),
              let record = try? JSONDecoder().decode(Record.self, from: data),
              let asset = try? AvatarLoader.load(directory: current)
        else { return nil }
        return ReceivedAvatar(art: .sprite(asset), id: record.id, name: record.name, version: record.version)
    }

    /// Fetches every file of the listing, checks each against its length and SHA-256, and puts the whole in place of
    /// the copy. `fetch` gives the bytes of one file.
    public func replace(
        with listing: AvatarListing, fetch: (AvatarListingFile) async throws -> Data
    ) async throws -> ReceivedAvatar {
        let files = FileManager.default
        try files.createDirectory(at: directory, withIntermediateDirectories: true)
        let incoming = directory.appendingPathComponent("incoming-\(UUID().uuidString)", isDirectory: true)
        defer { try? files.removeItem(at: incoming) }
        try files.createDirectory(at: incoming, withIntermediateDirectories: true)

        for file in listing.files {
            let data = try await fetch(file)
            try Self.check(data, against: file)
            let url = incoming.appendingPathComponent(file.path)
            try files.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
            try data.write(to: url)
        }
        let record = Record(version: listing.version, id: listing.id, name: listing.name)
        try JSONEncoder().encode(record).write(to: incoming.appendingPathComponent(Self.recordName))
        guard (try? AvatarLoader.load(directory: incoming)) != nil else { throw AvatarReceiveError.unreadable }

        if files.fileExists(atPath: current.path) {
            _ = try files.replaceItemAt(current, withItemAt: incoming)
        } else {
            try files.moveItem(at: incoming, to: current)
        }
        guard let received = load() else { throw AvatarReceiveError.unreadable }
        return received
    }

    /// Throws away the copy.
    public func forget() {
        try? FileManager.default.removeItem(at: current)
    }

    static func check(_ data: Data, against file: AvatarListingFile) throws {
        guard data.count == file.bytes else { throw AvatarReceiveError.wrongSize(file.path) }
        let digest = SHA256.hash(data: data).map { String(format: "%02x", $0) }.joined()
        guard digest == file.sha256 else { throw AvatarReceiveError.wrongDigest(file.path) }
    }
}
