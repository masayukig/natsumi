import CoreGraphics
import Foundation
import ImageIO

/// One animation: a row of the atlas and how many of its cells are frames.
public struct AvatarAnimation: Codable, Equatable, Sendable {
    public let row: Int
    public let frames: Int

    public init(row: Int, frames: Int) {
        self.row = row
        self.frames = frames
    }
}

public enum AvatarLoadError: Error, Equatable {
    /// Neither `avatar.json` nor `pet.json` is in the directory.
    case missingManifest
    case invalidManifest
    case missingImage
    case imageTooSmall
    /// An animation outside the atlas, or an expression mapped to an animation that does not exist.
    case invalidAnimation(String)
}

/// How to read an avatar directory: a Codex pet (`pet.json` and its spritesheet), optionally refined by `avatar.json`
/// with the atlas, the animations and the table from server expressions to animations.
public struct AvatarManifest: Equatable, Sendable {
    public var spritesheet: String
    public var columns: Int
    public var rows: Int
    public var cellWidth: Int
    public var cellHeight: Int
    public var framesPerSecond: Double
    public var animations: [String: AvatarAnimation]
    public var expressions: [Expression: String]
    /// A face for each feeling, by path inside the avatar's directory: what the history shows beside her lines.
    public var icons: [Expression: String] = [:]

    /// The layout of a Codex pet spritesheet and the default expression table.
    public static let codexPet = AvatarManifest(
        spritesheet: "spritesheet.webp", columns: 8, rows: 9, cellWidth: 192, cellHeight: 208, framesPerSecond: 6,
        animations: [
            "idle": AvatarAnimation(row: 0, frames: 6),
            "running-right": AvatarAnimation(row: 1, frames: 8),
            "running-left": AvatarAnimation(row: 2, frames: 8),
            "waving": AvatarAnimation(row: 3, frames: 4),
            "jumping": AvatarAnimation(row: 4, frames: 5),
            "failed": AvatarAnimation(row: 5, frames: 8),
            "waiting": AvatarAnimation(row: 6, frames: 6),
            "running": AvatarAnimation(row: 7, frames: 6),
            "review": AvatarAnimation(row: 8, frames: 6),
        ],
        expressions: [
            .neutral: "idle", .thinking: "review", .happy: "waving", .laughing: "jumping",
            .surprised: "jumping", .worried: "waiting", .sad: "failed", .sleepy: "idle",
        ])

    /// Reads `pet.json` and `avatar.json` (either may be missing, not both) over the Codex pet defaults.
    /// Animations given in `avatar.json` replace the default ones together with the default table.
    public static func make(pet: Data?, avatar: Data?) throws -> AvatarManifest {
        guard pet != nil || avatar != nil else { throw AvatarLoadError.missingManifest }
        var manifest = codexPet
        let decoder = JSONDecoder()
        if let pet {
            guard let file = try? decoder.decode(PetFile.self, from: pet) else { throw AvatarLoadError.invalidManifest }
            if let path = file.spritesheetPath { manifest.spritesheet = path }
        }
        if let avatar {
            guard let file = try? decoder.decode(AvatarFile.self, from: avatar) else { throw AvatarLoadError.invalidManifest }
            if let spritesheet = file.spritesheet { manifest.spritesheet = spritesheet }
            if let atlas = file.atlas {
                manifest.columns = atlas.columns ?? manifest.columns
                manifest.rows = atlas.rows ?? manifest.rows
                manifest.cellWidth = atlas.cellWidth ?? manifest.cellWidth
                manifest.cellHeight = atlas.cellHeight ?? manifest.cellHeight
            }
            if let framesPerSecond = file.framesPerSecond { manifest.framesPerSecond = framesPerSecond }
            if let animations = file.animations {
                manifest.animations = animations
                manifest.expressions = [:]
            }
            for (name, animation) in file.expressions ?? [:] {
                if let expression = Expression(rawValue: name) { manifest.expressions[expression] = animation }
            }
            for (name, path) in file.icons ?? [:] {
                guard Self.isInside(path) else { throw AvatarLoadError.invalidManifest }
                if let expression = Expression(rawValue: name) { manifest.icons[expression] = path }
            }
        }
        try manifest.validate()
        return manifest
    }

    /// The animation shown for an expression: its own, else neutral's, else `idle`, else the top row.
    public func animationName(for expression: Expression) -> String {
        for candidate in [expressions[expression], expressions[.neutral], "idle"] {
            if let candidate, animations[candidate] != nil { return candidate }
        }
        return animations.min { $0.value.row < $1.value.row }?.key ?? "idle"
    }

    /// The animation for a face that is also moving. Running is drawn with the art for the way she is going, else
    /// with running art that has no side to it; an avatar with none at all keeps its face's own animation and only
    /// changes place. A missing animation is never an error here: owners bring their own avatars.
    public func animationName(for expression: Expression, motion: CharacterMotion) -> String {
        guard case .running(let direction) = motion else { return animationName(for: expression) }
        for candidate in [direction == .left ? "running-left" : "running-right", "running"] {
            if animations[candidate] != nil { return candidate }
        }
        return animationName(for: expression)
    }

    /// A relative path that stays inside the avatar's directory.
    static func isInside(_ path: String) -> Bool {
        let parts = path.split(separator: "/", omittingEmptySubsequences: false)
        return !path.isEmpty && !path.hasPrefix("/") && !parts.contains { $0.isEmpty || $0 == "." || $0 == ".." }
    }

    private func validate() throws {
        let name = spritesheet
        guard !name.isEmpty, !name.contains("/"), !name.hasPrefix("."),
              columns > 0, rows > 0, cellWidth > 0, cellHeight > 0, framesPerSecond > 0, !animations.isEmpty
        else { throw AvatarLoadError.invalidManifest }
        for (name, animation) in animations.sorted(by: { $0.key < $1.key }) {
            guard (0..<rows).contains(animation.row), (1...columns).contains(animation.frames) else {
                throw AvatarLoadError.invalidAnimation(name)
            }
        }
        for expression in Expression.allCases {
            if let name = expressions[expression], animations[name] == nil { throw AvatarLoadError.invalidAnimation(name) }
        }
    }

    private struct PetFile: Decodable {
        let spritesheetPath: String?
    }

    private struct AvatarFile: Decodable {
        struct Atlas: Decodable {
            let columns: Int?
            let rows: Int?
            let cellWidth: Int?
            let cellHeight: Int?
        }

        let spritesheet: String?
        let atlas: Atlas?
        let framesPerSecond: Double?
        let animations: [String: AvatarAnimation]?
        let expressions: [String: String]?
        let icons: [String: String]?
    }
}

/// A loaded avatar with its frames cut from the spritesheet.
public struct AvatarAsset: Equatable, @unchecked Sendable {
    public let manifest: AvatarManifest
    public let directory: URL
    private let frames: [String: [CGImage]]
    private let icons: [Expression: CGImage]

    init(manifest: AvatarManifest, directory: URL, sheet: CGImage, icons: [Expression: CGImage] = [:]) {
        self.manifest = manifest
        self.directory = directory
        self.icons = icons
        var frames: [String: [CGImage]] = [:]
        for (name, animation) in manifest.animations {
            frames[name] = (0..<animation.frames).compactMap { column in
                sheet.cropping(to: CGRect(
                    x: column * manifest.cellWidth, y: animation.row * manifest.cellHeight,
                    width: manifest.cellWidth, height: manifest.cellHeight))
            }
        }
        self.frames = frames
    }

    /// The face for a feeling, or nil when the avatar has none for it.
    public func icon(for expression: Expression) -> CGImage? {
        icons[expression]
    }

    public func frames(for expression: Expression, motion: CharacterMotion = .still) -> [CGImage] {
        frames[manifest.animationName(for: expression, motion: motion)] ?? []
    }

    /// The frame to show `elapsed` seconds into the animation, looping.
    public func frame(for expression: Expression, motion: CharacterMotion = .still, elapsed: TimeInterval) -> CGImage {
        let frames = frames(for: expression, motion: motion)
        let index = Int((max(0, elapsed) * manifest.framesPerSecond + 1e-9).rounded(.down)) % frames.count
        return frames[index]
    }

    public static func == (lhs: AvatarAsset, rhs: AvatarAsset) -> Bool {
        lhs.manifest == rhs.manifest && lhs.directory == rhs.directory
    }
}

/// What the character window draws.
public enum AvatarArt: Equatable, Sendable {
    case sprite(AvatarAsset)
    /// There is no avatar yet; a symbol stands in for each expression.
    case placeholder
}

public enum AvatarLoader {
    public static func load(directory: URL) throws -> AvatarAsset {
        let pet = try? Data(contentsOf: directory.appendingPathComponent("pet.json"))
        let avatar = try? Data(contentsOf: directory.appendingPathComponent("avatar.json"))
        let manifest = try AvatarManifest.make(pet: pet, avatar: avatar)
        let url = directory.appendingPathComponent(manifest.spritesheet)
        guard let source = CGImageSourceCreateWithURL(url as CFURL, nil),
              let sheet = CGImageSourceCreateImageAtIndex(source, 0, nil)
        else { throw AvatarLoadError.missingImage }
        guard sheet.width >= manifest.columns * manifest.cellWidth, sheet.height >= manifest.rows * manifest.cellHeight else {
            throw AvatarLoadError.imageTooSmall
        }
        // A face that cannot be read is left out, not an error: the character itself still works without it.
        var icons: [Expression: CGImage] = [:]
        for (expression, path) in manifest.icons {
            if let source = CGImageSourceCreateWithURL(directory.appendingPathComponent(path) as CFURL, nil),
               let image = CGImageSourceCreateImageAtIndex(source, 0, nil) {
                icons[expression] = image
            }
        }
        return AvatarAsset(manifest: manifest, directory: directory, sheet: sheet, icons: icons)
    }
}

/// Stand-in art for when no avatar loads.
public enum PlaceholderArt {
    public static func symbol(for expression: Expression) -> String {
        switch expression {
        case .neutral: "🙂"
        case .happy: "😊"
        case .laughing: "😆"
        case .surprised: "😮"
        case .thinking: "🤔"
        case .worried: "😟"
        case .sad: "😢"
        case .sleepy: "😴"
        }
    }
}
