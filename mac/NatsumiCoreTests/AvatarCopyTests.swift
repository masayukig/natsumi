import CryptoKit
import Foundation
import Testing
@testable import NatsumiCore

extension Fixture {
    /// A made-up avatar as the server hands it out (client-contract「アバター」): a sheet of 4 × 3 cells of 4 × 5
    /// pixels, three animations and one face.
    static func avatarFiles(id: String = "hana", name: String = "ハナ") -> [String: Data] {
        let avatar = """
        {
          "id": "\(id)", "name": "\(name)", "spritesheet": "spritesheet.png",
          "atlas": { "columns": 4, "rows": 3, "cellWidth": 4, "cellHeight": 5 },
          "animations": { "idle": { "row": 0, "frames": 2 }, "waving": { "row": 1, "frames": 3 }, "failed": { "row": 2, "frames": 4 } },
          "expressions": { "neutral": "idle", "happy": "waving", "sad": "failed" },
          "icons": { "happy": "icons/happy.png" }
        }
        """
        return [
            "avatar.json": Data(avatar.utf8),
            "pet.json": Data(#"{"id":"\#(id)","displayName":"\#(name)","spritesheetPath":"spritesheet.png"}"#.utf8),
            "spritesheet.png": png(width: 16, height: 15),
            "icons/happy.png": png(width: 8, height: 8),
        ]
    }

    static func sha256(_ data: Data) -> String {
        SHA256.hash(data: data).map { String(format: "%02x", $0) }.joined()
    }

    /// The listing of `GET /v1/avatar` for these files, as JSON.
    static func avatarListingJSON(
        version: String = "0123456789abcdef0123456789abcdef", id: String = "hana", name: String = "ハナ",
        files: [String: Data] = avatarFiles()
    ) -> Data {
        json([
            "version": version, "id": id, "name": name,
            "files": files.keys.sorted().map { ["path": $0, "bytes": files[$0]!.count, "sha256": sha256(files[$0]!)] },
        ])
    }

    static func avatarListing(
        version: String = "0123456789abcdef0123456789abcdef", id: String = "hana", name: String = "ハナ",
        files: [String: Data] = avatarFiles()
    ) -> AvatarListing {
        try! AvatarListing.decode(avatarListingJSON(version: version, id: id, name: name, files: files))
    }
}

/// A place for a copy of its own, removed afterwards.
private struct CopyPlace {
    let directory = FileManager.default.temporaryDirectory.appendingPathComponent("natsumi-copy-\(UUID().uuidString)")
    var copy: AvatarCopy { AvatarCopy(directory: directory) }
    func remove() { try? FileManager.default.removeItem(at: directory) }

    /// What is left in the place besides the copy itself: nothing, once a replacement is over.
    func leftovers() -> [String] {
        ((try? FileManager.default.contentsOfDirectory(atPath: directory.path)) ?? []).filter { $0 != "current" }
    }
}

private struct Unreachable: Error {}

@Suite("アバターの受け取りと手元の控え")
struct AvatarCopyTests {
    private static let version1 = "0123456789abcdef0123456789abcdef"
    private static let version2 = "fedcba9876543210fedcba9876543210"

    @Test("一覧から版・ID・表示名と、ファイルごとの path・bytes・sha256 を読む")
    func readsTheListing() throws {
        let files = Fixture.avatarFiles()
        let listing = try AvatarListing.decode(Fixture.avatarListingJSON(files: files))
        #expect(listing.version == Self.version1)
        #expect(listing.id == "hana")
        #expect(listing.name == "ハナ")
        #expect(listing.files.map(\.path) == ["avatar.json", "icons/happy.png", "pet.json", "spritesheet.png"])
        #expect(listing.files[0].bytes == files["avatar.json"]!.count)
        #expect(listing.files[0].sha256 == Fixture.sha256(files["avatar.json"]!))
    }

    @Test("形の合わない一覧は読まない", arguments: [
        ["version": "0123"],
        ["version": "0123456789ABCDEF0123456789ABCDEF"],
        ["id": "Hana"],
        ["id": "1hana"],
        ["id": String(repeating: "a", count: 33)],
        ["name": ""],
        ["name": String(repeating: "あ", count: 33)],
        ["name": "ハ\nナ"],
        ["path": "../avatar.json"],
        ["path": "/avatar.json"],
        ["path": "icons//happy.png"],
        ["path": ""],
        ["bytes": "-1"],
        ["sha256": "xyz"],
    ])
    func refusesAMalformedListing(change: [String: String]) {
        var object = try! JSONSerialization.jsonObject(with: Fixture.avatarListingJSON()) as! [String: Any]
        var files = object["files"] as! [[String: Any]]
        for (key, value) in change {
            switch key {
            case "path", "sha256": files[0][key] = value
            case "bytes": files[0][key] = Int(value)!
            default: object[key] = value
            }
        }
        object["files"] = files
        #expect(throws: AvatarReceiveError.invalidListing) { try AvatarListing.decode(Fixture.json(object)) }
    }

    @Test("一覧もファイルも、ログインのいらない GET。ファイルは版と path を URL に入れる")
    func requests() throws {
        let server = try ServerAddress("https://natsumi.example.net")
        let listing = AvatarAPI.listingRequest(server: server)
        #expect(listing.url?.absoluteString == "https://natsumi.example.net/v1/avatar")
        #expect(listing.httpMethod == "GET")
        #expect(listing.value(forHTTPHeaderField: "Authorization") == nil)
        let file = AvatarAPI.fileRequest(server: server, version: Self.version1, path: "icons/happy.png")
        #expect(file.url?.absoluteString == "https://natsumi.example.net/v1/avatar/\(Self.version1)/icons/happy.png")
        #expect(file.value(forHTTPHeaderField: "Authorization") == nil)
    }

    @Test("控えが無ければ何も読めない")
    func noCopy() {
        let place = CopyPlace()
        defer { place.remove() }
        #expect(place.copy.load() == nil)
    }

    @Test("全ファイルを取り、確かめてから控えに置く。控えは次の起動でも同じ版・ID・名前で読める")
    func replaces() async throws {
        let place = CopyPlace()
        defer { place.remove() }
        let files = Fixture.avatarFiles()
        let received = try await place.copy.replace(with: Fixture.avatarListing(files: files)) { files[$0.path]! }
        #expect(received.version == Self.version1)
        #expect(received.id == "hana")
        #expect(received.name == "ハナ")
        guard case .sprite(let asset) = received.art else { Issue.record("no sprite"); return }
        #expect(asset.frames(for: .happy).count == 3)
        #expect(asset.icon(for: .happy)?.width == 8)

        let again = try #require(place.copy.load())
        #expect(again == received)
        #expect(place.leftovers().isEmpty)
    }

    @Test("新しい版を受け取ったら、前の控えを丸ごと置き換える")
    func replacesTheWholeCopy() async throws {
        let place = CopyPlace()
        defer { place.remove() }
        let first = Fixture.avatarFiles()
        _ = try await place.copy.replace(with: Fixture.avatarListing(files: first)) { first[$0.path]! }
        var second = Fixture.avatarFiles(id: "sora", name: "ソラ")
        second["icons/happy.png"] = nil
        let listing = Fixture.avatarListing(version: Self.version2, id: "sora", name: "ソラ", files: second)
        _ = try await place.copy.replace(with: listing) { second[$0.path]! }

        let copy = try #require(place.copy.load())
        #expect(copy.version == Self.version2)
        #expect(copy.name == "ソラ")
        guard case .sprite(let asset) = copy.art else { Issue.record("no sprite"); return }
        // The face of the version before is not left behind.
        #expect(asset.icon(for: .happy) == nil)
        #expect(place.leftovers().isEmpty)
    }

    @Test("大きさが一覧と違えば置き換えず、前の控えを使い続ける")
    func wrongSize() async throws {
        let place = CopyPlace()
        defer { place.remove() }
        let files = Fixture.avatarFiles()
        let before = try await place.copy.replace(with: Fixture.avatarListing(files: files)) { files[$0.path]! }

        let listing = Fixture.avatarListing(version: Self.version2, files: files)
        await #expect(throws: AvatarReceiveError.wrongSize("pet.json")) {
            try await place.copy.replace(with: listing) { $0.path == "pet.json" ? files["pet.json"]! + Data([0x20]) : files[$0.path]! }
        }
        #expect(place.copy.load() == before)
        #expect(place.leftovers().isEmpty)
    }

    @Test("sha256 が一覧と違えば置き換えず、前の控えを使い続ける")
    func wrongDigest() async throws {
        let place = CopyPlace()
        defer { place.remove() }
        let files = Fixture.avatarFiles()
        let before = try await place.copy.replace(with: Fixture.avatarListing(files: files)) { files[$0.path]! }

        let listing = Fixture.avatarListing(version: Self.version2, files: files)
        await #expect(throws: AvatarReceiveError.wrongDigest("pet.json")) {
            try await place.copy.replace(with: listing) { file in
                // Same length, other bytes.
                file.path == "pet.json" ? Data(String(repeating: " ", count: file.bytes).utf8) : files[file.path]!
            }
        }
        #expect(place.copy.load() == before)
    }

    @Test("途中で取れなくなったら、前の控えを使い続け、途中まで取ったものを残さない")
    func failsHalfway() async throws {
        let place = CopyPlace()
        defer { place.remove() }
        let files = Fixture.avatarFiles()
        let before = try await place.copy.replace(with: Fixture.avatarListing(files: files)) { files[$0.path]! }

        let listing = Fixture.avatarListing(version: Self.version2, files: files)
        await #expect(throws: Unreachable.self) {
            try await place.copy.replace(with: listing) { file in
                guard file.path != "spritesheet.png" else { throw Unreachable() }
                return files[file.path]!
            }
        }
        #expect(place.copy.load() == before)
        #expect(place.leftovers().isEmpty)
    }

    @Test("確かめられても、アバターとして読めない組なら置き換えない")
    func unreadable() async throws {
        let place = CopyPlace()
        defer { place.remove() }
        let files = Fixture.avatarFiles()
        let before = try await place.copy.replace(with: Fixture.avatarListing(files: files)) { files[$0.path]! }

        var broken = files
        broken["spritesheet.png"] = Data("not a picture".utf8)
        let listing = Fixture.avatarListing(version: Self.version2, files: broken)
        await #expect(throws: AvatarReceiveError.unreadable) {
            try await place.copy.replace(with: listing) { broken[$0.path]! }
        }
        #expect(place.copy.load() == before)
        #expect(place.leftovers().isEmpty)
    }

    @Test("サーバーに組み込まれたアバター（なつみ・名無し）は、配られる形のまま読める")
    func builtInAvatars() throws {
        let assets = URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent()
            .deletingLastPathComponent().appendingPathComponent("assets/avatars")
        for id in ["natsumi", "nanashi"] {
            let avatar = try AvatarLoader.load(directory: assets.appendingPathComponent(id))
            for expression in Expression.allCases {
                #expect(!avatar.frames(for: expression).isEmpty)
                #expect(avatar.icon(for: expression) != nil)
            }
        }
    }
}
