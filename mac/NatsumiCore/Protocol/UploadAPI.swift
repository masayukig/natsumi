import Foundation

/// How large one file may be and how many go with one message, as `session.snapshot`'s `uploads` says
/// (client-contract「ファイルの添付」).
public struct UploadLimits: Equatable, Sendable {
    public let maxFileBytes: Int
    public let maxFiles: Int

    public init(maxFileBytes: Int, maxFiles: Int) {
        self.maxFileBytes = maxFileBytes
        self.maxFiles = maxFiles
    }
}

/// A file the owner uploaded: as the server answered the upload, and as an owner message's `attachments` lists it
/// (ADR 0071). Its content is fetched by its ID once a message has it.
public struct ShownAttachment: Codable, Equatable, Sendable {
    public let uploadId: String
    /// The name as the server put it right.
    public let name: String
    public let bytes: Int
    /// Only on a PNG, JPEG or WebP.
    public let mimeType: String?
    /// Its size in pixels, when the server could read it. Both are there, or neither.
    public let width: Int?
    public let height: Int?

    public init(uploadId: String, name: String, bytes: Int, mimeType: String? = nil, width: Int? = nil, height: Int? = nil) {
        self.uploadId = uploadId
        self.name = name
        self.bytes = bytes
        self.mimeType = mimeType
        let known = (width ?? 0) > 0 && (height ?? 0) > 0
        self.width = known ? width : nil
        self.height = known ? height : nil
    }

    private enum CodingKeys: String, CodingKey { case uploadId, name, bytes, mimeType, width, height }

    public init(from decoder: Decoder) throws {
        let values = try decoder.container(keyedBy: CodingKeys.self)
        self.init(
            uploadId: try values.decode(String.self, forKey: .uploadId), name: try values.decode(String.self, forKey: .name),
            bytes: try values.decode(Int.self, forKey: .bytes),
            mimeType: try? values.decodeIfPresent(String.self, forKey: .mimeType),
            width: try? values.decodeIfPresent(Int.self, forKey: .width),
            height: try? values.decodeIfPresent(Int.self, forKey: .height))
    }

    /// The server could tell it is a picture.
    public var isImage: Bool { mimeType != nil }

    /// The picture, in the form the strips draw: its upload ID stands for the picture's ID. nil for other files.
    public var image: ShownImage? {
        mimeType.map { ShownImage(imageId: uploadId, mimeType: $0, bytes: bytes, width: width, height: height) }
    }
}

/// Why a file did not go up.
public enum UploadFailure: Equatable, Sendable {
    /// Past the server's limit for one file (413).
    case tooLarge
    /// The session is gone (401).
    case unauthorized
    /// Anything else: no connection, or an answer that cannot be read.
    case failed
}

/// What came of uploading one file.
public enum UploadResult: Equatable, Sendable {
    case uploaded(ShownAttachment)
    case failed(UploadFailure)
}

/// `POST /v1/uploads?name=…` and `GET /v1/uploads/<uploadId>`, with the session's Bearer token
/// (client-contract「ファイルの添付」).
public enum UploadAPI {
    /// Everything but the unreserved characters is escaped, so that a name with `&`, `=` or `+` stays one value.
    private static let nameCharacters = CharacterSet(charactersIn:
        "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-._~")

    /// The upload of one file. The bytes are the body as they are; the root sends them with it.
    public static func request(server: ServerAddress, token: String, name: String) -> URLRequest {
        let escaped = name.addingPercentEncoding(withAllowedCharacters: nameCharacters) ?? ""
        var request = URLRequest(url: server.url(path: "/v1/uploads?name=\(escaped)"))
        request.httpMethod = "POST"
        request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        request.setValue("application/octet-stream", forHTTPHeaderField: "Content-Type")
        return request
    }

    /// Reads the answer to an upload.
    public static func result(status: Int, body: Data) -> UploadResult {
        switch status {
        case 200, 201:
            (try? JSONDecoder().decode(ShownAttachment.self, from: body)).map { .uploaded($0) } ?? .failed(.failed)
        case 401: .failed(.unauthorized)
        case 413: .failed(.tooLarge)
        default: .failed(.failed)
        }
    }

    /// The content of a file a message has. nil for an ID not of the contract's form, which is not put in the path.
    public static func contentRequest(server: ServerAddress, token: String, uploadId: String) -> URLRequest? {
        guard ImageAPI.isValid(uploadId) else { return nil }
        var request = URLRequest(url: server.url(path: "/v1/uploads/\(uploadId)"))
        request.httpMethod = "GET"
        request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        // The app keeps what it fetched itself, as with the pictures of a reply.
        request.cachePolicy = .reloadIgnoringLocalCacheData
        return request
    }
}
