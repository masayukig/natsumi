import Foundation

/// What the avatar book asks the root to do.
public enum AvatarAction: Equatable, Sendable {
    /// `GET /v1/avatar` of this server.
    case fetchListing(origin: String)
    /// Fetch every file of this listing and put them in place of the copy.
    case receive(origin: String, AvatarListing)
}

/// The avatar the app shows and when to fetch it again (ADR 0057, client-contract「アバター」), for both clients.
///
/// The app has no avatar of its own: it shows the copy of the server's. The copy is compared with the server's
/// listing when the server is set, and afterwards whenever the sync tells a version other than the copy's; the
/// version only changes when the server restarts, so there is nothing to watch for while connected. One fetch is on
/// its way at a time, and a failed one leaves the copy as it was.
public struct AvatarBook: Equatable, Sendable {
    /// What the app is called while it has no avatar: the product's name, not any avatar's.
    public static let fallbackName = "Natsumi"

    /// The copy the app shows; nil until one has been received.
    public private(set) var received: ReceivedAvatar?
    /// The copy on this device has been looked for.
    public private(set) var isLoaded = false
    /// The last fetch did not bring the avatar.
    public private(set) var failed = false
    /// The server a fetch is on its way from.
    private var fetching: String?

    public init() {}

    public var art: AvatarArt { received?.art ?? .placeholder }
    public var name: String { received?.name ?? Self.fallbackName }

    /// The copy found at launch, or none.
    public mutating func loaded(_ copy: ReceivedAvatar?) {
        isLoaded = true
        if let copy { received = copy }
    }

    /// The server is set: see whether its avatar is the copy.
    public mutating func check(origin: String?) -> [AvatarAction] {
        guard let origin, fetching == nil else { return [] }
        fetching = origin
        return [.fetchListing(origin: origin)]
    }

    /// The sync told the version the server hands out.
    public mutating func seen(version: String, origin: String?) -> [AvatarAction] {
        guard version != received?.version else { return [] }
        return check(origin: origin)
    }

    /// The listing came, or could not be had. One of a server that is no longer the one set is not used: the one
    /// that is set is asked instead.
    public mutating func listed(_ listing: AvatarListing?, from origin: String, current: String?) -> [AvatarAction] {
        guard origin == current else {
            fetching = nil
            return check(origin: current)
        }
        guard let listing else {
            fetching = nil
            failed = true
            return []
        }
        guard listing.version != received?.version else {
            fetching = nil
            failed = false
            return []
        }
        return [.receive(origin: origin, listing)]
    }

    /// The files came and replaced the copy, or did not, and the copy is as it was.
    public mutating func delivered(_ avatar: ReceivedAvatar?) {
        fetching = nil
        failed = avatar == nil
        if let avatar { received = avatar }
    }
}
