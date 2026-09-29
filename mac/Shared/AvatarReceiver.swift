import Foundation
import NatsumiCore

/// Fetches the server's avatar for the root (ADR 0057): the listing, and the files of a listing into the copy kept on
/// this device. Neither needs the session, so both work before the login. What to fetch and when is the mediator's.
enum AvatarReceiver {
    /// The copy of the avatar on this device.
    static let copy = AvatarCopy(directory: FileManager.default
        .urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
        .appendingPathComponent("natsumi/avatar-copy", isDirectory: true))

    /// `GET /v1/avatar`, or nil when the server could not be reached or did not answer with a listing.
    static func listing(origin: String) async -> AvatarListing? {
        guard let server = try? ServerAddress(origin),
              let (data, response) = try? await URLSession.shared.data(for: AvatarAPI.listingRequest(server: server)),
              (response as? HTTPURLResponse)?.statusCode == 200
        else { return nil }
        return try? AvatarListing.decode(data)
    }

    /// Fetches every file of the listing into the copy. nil when any of it failed: the copy is then as it was.
    static func receive(_ listing: AvatarListing, origin: String) async -> ReceivedAvatar? {
        guard let server = try? ServerAddress(origin) else { return nil }
        return try? await copy.replace(with: listing) { file in
            let request = AvatarAPI.fileRequest(server: server, version: listing.version, path: file.path)
            let (data, response) = try await URLSession.shared.data(for: request)
            // A version that is no longer the server's is 404: the next sync tells the new one.
            guard (response as? HTTPURLResponse)?.statusCode == 200 else { throw URLError(.badServerResponse) }
            return data
        }
    }
}
