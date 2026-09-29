import CoreGraphics
import Foundation
import ImageIO
import Testing
import UniformTypeIdentifiers
@testable import NatsumiCore

/// A made-up avatar: every cell of the sheet is a solid color whose red encodes the column and green the row.
private struct SampleAvatar {
    let directory: URL
    static let columns = 4, rows = 3, cellWidth = 4, cellHeight = 5

    init(avatarJSON: String? = Self.defaultJSON, petJSON: String? = nil, sheetColumns: Int = columns, sheetRows: Int = rows) throws {
        directory = FileManager.default.temporaryDirectory.appendingPathComponent("natsumi-avatar-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        try Self.writeSheet(columns: sheetColumns, rows: sheetRows, to: directory.appendingPathComponent("sheet.png"))
        if let avatarJSON { try Data(avatarJSON.utf8).write(to: directory.appendingPathComponent("avatar.json")) }
        if let petJSON { try Data(petJSON.utf8).write(to: directory.appendingPathComponent("pet.json")) }
    }

    /// A square icon of one color under `icons/`.
    func writeIcon(_ name: String, side: Int = 8) throws {
        let folder = directory.appendingPathComponent("icons")
        try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
        let context = CGContext(data: nil, width: side, height: side, bitsPerComponent: 8, bytesPerRow: 0,
            space: CGColorSpace(name: CGColorSpace.sRGB)!, bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue)!
        context.setFillColor(red: 1, green: 0, blue: 0, alpha: 1)
        context.fill(CGRect(x: 0, y: 0, width: side, height: side))
        let destination = CGImageDestinationCreateWithURL(
            folder.appendingPathComponent(name) as CFURL, UTType.png.identifier as CFString, 1, nil)!
        CGImageDestinationAddImage(destination, context.makeImage()!, nil)
        guard CGImageDestinationFinalize(destination) else { throw CocoaError(.fileWriteUnknown) }
    }

    static func json(icons: String) -> String {
        defaultJSON.replacingOccurrences(of: #""expressions": {"#, with: #""icons": \#(icons),\#n  "expressions": {"#)
    }

    func remove() { try? FileManager.default.removeItem(at: directory) }

    static let defaultJSON = """
    {
      "spritesheet": "sheet.png",
      "atlas": { "columns": 4, "rows": 3, "cellWidth": 4, "cellHeight": 5 },
      "framesPerSecond": 10,
      "animations": { "rest": { "row": 0, "frames": 2 }, "wave": { "row": 1, "frames": 3 }, "fall": { "row": 2, "frames": 4 } },
      "expressions": { "neutral": "rest", "happy": "wave", "sad": "fall" }
    }
    """

    static func writeSheet(columns: Int, rows: Int, to url: URL) throws {
        let width = columns * cellWidth, height = rows * cellHeight
        let context = CGContext(data: nil, width: width, height: height, bitsPerComponent: 8, bytesPerRow: 0,
            space: CGColorSpace(name: CGColorSpace.sRGB)!, bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue)!
        for row in 0..<rows {
            for column in 0..<columns {
                context.setFillColor(red: CGFloat(column * 60) / 255, green: CGFloat(row * 80) / 255, blue: 0.5, alpha: 1)
                // Core Graphics draws from the bottom; row 0 is the top of the image.
                context.fill(CGRect(x: column * cellWidth, y: height - (row + 1) * cellHeight, width: cellWidth, height: cellHeight))
            }
        }
        let destination = CGImageDestinationCreateWithURL(url as CFURL, UTType.png.identifier as CFString, 1, nil)!
        CGImageDestinationAddImage(destination, context.makeImage()!, nil)
        guard CGImageDestinationFinalize(destination) else { throw CocoaError(.fileWriteUnknown) }
    }
}

/// The red and green of the center pixel, which identify the column and row a frame was cut from.
private func cell(of image: CGImage) -> (column: Int, row: Int) {
    var pixel = [UInt8](repeating: 0, count: 4)
    let context = CGContext(data: &pixel, width: 1, height: 1, bitsPerComponent: 8, bytesPerRow: 4,
        space: CGColorSpace(name: CGColorSpace.sRGB)!, bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue)!
    context.draw(image, in: CGRect(x: -image.width / 2, y: -image.height / 2, width: image.width, height: image.height))
    return (Int((Double(pixel[0]) / 60).rounded()), Int((Double(pixel[1]) / 80).rounded()))
}

@Suite("アバター: atlas と表情の対応")
struct AvatarTests {
    @Test("avatar.json の atlas で、表情に対応する動作の行からフレームを切り出す")
    func framesFromAtlas() throws {
        let sample = try SampleAvatar()
        defer { sample.remove() }
        let avatar = try AvatarLoader.load(directory: sample.directory)
        let frames = avatar.frames(for: .happy)
        #expect(frames.count == 3)
        #expect(frames.allSatisfy { $0.width == SampleAvatar.cellWidth && $0.height == SampleAvatar.cellHeight })
        #expect(frames.map { cell(of: $0).column } == [0, 1, 2])
        #expect(frames.allSatisfy { cell(of: $0).row == 1 })
    }

    @Test("対応表にない表情は、neutral の動作で表示する")
    func unmappedExpression() throws {
        let sample = try SampleAvatar()
        defer { sample.remove() }
        let avatar = try AvatarLoader.load(directory: sample.directory)
        #expect(avatar.manifest.animationName(for: .sleepy) == "rest")
        #expect(avatar.frames(for: .thinking).count == 2)
    }

    @Test("経過時間から、動作のフレームを順に繰り返す")
    func frameTiming() throws {
        let sample = try SampleAvatar()
        defer { sample.remove() }
        let avatar = try AvatarLoader.load(directory: sample.directory)
        let columns = [0.0, 0.1, 0.2, 0.3, 0.45].map { cell(of: avatar.frame(for: .sad, elapsed: $0)).column }
        #expect(columns == [0, 1, 2, 3, 0])
    }

    @Test("avatar.json がなければ、pet.json の spritesheet と Codex のペットの既定の配置・対応表を使う")
    func codexPetDefaults() throws {
        let manifest = try AvatarManifest.make(pet: Data(#"{"id":"sample","spritesheetPath":"sample.webp"}"#.utf8), avatar: nil)
        #expect(manifest.spritesheet == "sample.webp")
        let layout: [Int] = [manifest.columns, manifest.cellWidth, manifest.cellHeight]
        #expect(layout == [8, 192, 208])
        #expect(manifest.animations["review"] == AvatarAnimation(row: 8, frames: 6))
        let table = Dictionary(uniqueKeysWithValues: Expression.allCases.map { ($0, manifest.animationName(for: $0)) })
        #expect(table == [.neutral: "idle", .thinking: "review", .happy: "waving", .laughing: "jumping",
                          .surprised: "jumping", .worried: "waiting", .sad: "failed", .sleepy: "idle"])
    }

    @Test("avatar.json の対応表は、既定の対応を表情ごとに上書きする")
    func overrideTable() throws {
        let manifest = try AvatarManifest.make(pet: nil, avatar: Data(#"{"expressions":{"sleepy":"waiting"}}"#.utf8))
        #expect(manifest.animationName(for: .sleepy) == "waiting")
        #expect(manifest.animationName(for: .happy) == "waving")
        #expect(manifest.spritesheet == "spritesheet.webp")
    }

    @Test("移動中の動作は、進む向きの走る絵で表情の動作を上書きする")
    func runningOverridesTheExpression() throws {
        let manifest = try AvatarManifest.make(pet: nil, avatar: Data("{}".utf8))
        #expect(manifest.animationName(for: .happy, motion: .still) == "waving")
        #expect(manifest.animationName(for: .happy, motion: .running(.right)) == "running-right")
        #expect(manifest.animationName(for: .happy, motion: .running(.left)) == "running-left")
    }

    @Test("向きの走る絵が無ければ向きのない走り、それも無ければ表情の動作のままにする")
    func runningFallsBack() throws {
        let sideless = try AvatarManifest.make(
            pet: nil,
            avatar: Data(#"{"animations":{"idle":{"row":0,"frames":2},"running":{"row":1,"frames":3}},"expressions":{"neutral":"idle"}}"#.utf8))
        #expect(sideless.animationName(for: .neutral, motion: .running(.left)) == "running")

        // A hand-made avatar with no running art at all keeps the face's own animation.
        let sample = try SampleAvatar()
        defer { sample.remove() }
        let avatar = try AvatarLoader.load(directory: sample.directory)
        #expect(avatar.manifest.animationName(for: .happy, motion: .running(.right)) == "wave")
        #expect(avatar.frames(for: .happy, motion: .running(.right)).count == 3)
    }

    @Test("定義のないディレクトリ、atlas より小さい画像、範囲外の行、未知の動作は読み込まない")
    func invalid() throws {
        let empty = FileManager.default.temporaryDirectory.appendingPathComponent("natsumi-empty-\(UUID().uuidString)")
        #expect(throws: AvatarLoadError.missingManifest) { try AvatarLoader.load(directory: empty) }

        let small = try SampleAvatar(sheetColumns: 3)
        defer { small.remove() }
        #expect(throws: AvatarLoadError.imageTooSmall) { try AvatarLoader.load(directory: small.directory) }

        let outOfRange = try SampleAvatar(avatarJSON: SampleAvatar.defaultJSON.replacingOccurrences(of: #""row": 2, "frames": 4"#, with: #""row": 3, "frames": 4"#))
        defer { outOfRange.remove() }
        #expect(throws: AvatarLoadError.invalidAnimation("fall")) { try AvatarLoader.load(directory: outOfRange.directory) }

        let unknown = try SampleAvatar(avatarJSON: SampleAvatar.defaultJSON.replacingOccurrences(of: #""sad": "fall""#, with: #""sad": "cry""#))
        defer { unknown.remove() }
        #expect(throws: AvatarLoadError.invalidAnimation("cry")) { try AvatarLoader.load(directory: unknown.directory) }
    }

    @Test("spritesheet はディレクトリの中のファイル名に限る")
    func sheetStaysInDirectory() throws {
        let sample = try SampleAvatar(avatarJSON: SampleAvatar.defaultJSON.replacingOccurrences(of: #""sheet.png""#, with: #""../sheet.png""#))
        defer { sample.remove() }
        #expect(throws: AvatarLoadError.invalidManifest) { try AvatarLoader.load(directory: sample.directory) }
    }

    @Test("仮の絵は 8 つの表情をそれぞれ別の記号で表す")
    func placeholder() {
        let symbols = Expression.allCases.map(PlaceholderArt.symbol(for:))
        #expect(Set(symbols).count == 8)
    }

    @Test("avatar.json の icons で、表情ごとの顔のアイコンを読む。無い表情と無いファイルは、アイコンなしになる")
    func icons() throws {
        let sample = try SampleAvatar(avatarJSON: SampleAvatar.json(icons: """
            { "happy": "icons/happy.png", "sad": "icons/sad.png", "angry": "icons/angry.png" }
            """))
        defer { sample.remove() }
        try sample.writeIcon("happy.png", side: 8)
        let avatar = try AvatarLoader.load(directory: sample.directory)
        #expect(avatar.icon(for: .happy)?.width == 8)
        // Listed, but the file is not there: owners bring their own avatars, so it is not an error.
        #expect(avatar.icon(for: .sad) == nil)
        #expect(avatar.icon(for: .neutral) == nil)
    }

    @Test("アイコンの場所はアバターのディレクトリの中に限る")
    func iconOutsideDirectory() throws {
        for path in ["../happy.png", "/tmp/happy.png", "icons/../../happy.png", ""] {
            let sample = try SampleAvatar(avatarJSON: SampleAvatar.json(icons: #"{ "happy": "\#(path)" }"#))
            defer { sample.remove() }
            #expect(throws: AvatarLoadError.invalidManifest) { try AvatarLoader.load(directory: sample.directory) }
        }
    }
}
