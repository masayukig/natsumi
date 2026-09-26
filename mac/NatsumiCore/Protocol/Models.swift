import CoreGraphics
import Foundation

/// The avatar expressions the server chooses from (client-contract `avatar.expression`).
public enum Expression: String, CaseIterable, Codable, Sendable {
    case neutral, happy, laughing, surprised, thinking, worried, sad, sleepy
}

/// How far the server got with an owner message.
public enum EventState: String, Codable, Sendable {
    case queued, processing, replied
    case noReply = "no-reply"
    case failed

    /// Still waiting for natsumi to handle it.
    public var isPending: Bool { self == .queued || self == .processing }
}

/// A message as the owner sees it: an owner message, a reply, or a notice.
public struct ShownMessage: Codable, Equatable, Identifiable, Sendable {
    public enum Role: String, Codable, Sendable { case owner, natsumi }
    public enum Kind: String, Codable, Sendable { case message, reply, notice }

    public let messageId: String
    public let role: Role
    public let kind: Kind
    public let text: String
    public let createdAt: String
    /// `createdAt`, read once when the message arrives: the history is derived again whenever the rows in sight
    /// change. nil when the server's timestamp cannot be read.
    public let date: Date?
    /// The event of an owner message.
    public let eventId: String?
    /// The event a reply answers.
    public let replyTo: String?
    /// The events a notice is about.
    public let about: [String]?
    /// The feeling natsumi put into one of her lines (ADR 0026). nil on the owner's messages, on her lines from
    /// before the server kept it, and when the value is not one this app knows: all of them read as not known.
    public let expression: Expression?
    /// The pictures natsumi attached to a reply, in the order she put them (ADR 0045). Empty on every other line.
    public let images: [ShownImage]

    public init(
        messageId: String, role: Role, kind: Kind, text: String, createdAt: String,
        eventId: String? = nil, replyTo: String? = nil, about: [String]? = nil, expression: Expression? = nil,
        images: [ShownImage] = []
    ) {
        self.messageId = messageId
        self.role = role
        self.kind = kind
        self.text = text
        self.createdAt = createdAt
        self.date = parseTimestamp(createdAt)
        self.eventId = eventId
        self.replyTo = replyTo
        self.about = about
        self.expression = expression
        self.images = images
    }

    private enum CodingKeys: String, CodingKey {
        case messageId, role, kind, text, createdAt, eventId, replyTo, about, expression, images
    }

    public init(from decoder: Decoder) throws {
        let values = try decoder.container(keyedBy: CodingKeys.self)
        self.init(
            messageId: try values.decode(String.self, forKey: .messageId), role: try values.decode(Role.self, forKey: .role),
            kind: try values.decode(Kind.self, forKey: .kind), text: try values.decode(String.self, forKey: .text),
            createdAt: try values.decode(String.self, forKey: .createdAt),
            eventId: try values.decodeIfPresent(String.self, forKey: .eventId),
            replyTo: try values.decodeIfPresent(String.self, forKey: .replyTo),
            about: try values.decodeIfPresent([String].self, forKey: .about),
            // Read as a string first: a feeling added on the server later must not lose the line.
            expression: (try? values.decodeIfPresent(String.self, forKey: .expression)).flatMap { $0 }
                .flatMap(Expression.init(rawValue:)),
            // A picture this app cannot read is left out; the line and the other pictures are not.
            images: (try? values.decodeIfPresent(Lossy<ShownImage>.self, forKey: .images))?.elements ?? [])
    }

    public func encode(to encoder: Encoder) throws {
        var values = encoder.container(keyedBy: CodingKeys.self)
        try values.encode(messageId, forKey: .messageId)
        try values.encode(role, forKey: .role)
        try values.encode(kind, forKey: .kind)
        try values.encode(text, forKey: .text)
        try values.encode(createdAt, forKey: .createdAt)
        try values.encodeIfPresent(eventId, forKey: .eventId)
        try values.encodeIfPresent(replyTo, forKey: .replyTo)
        try values.encodeIfPresent(about, forKey: .about)
        try values.encodeIfPresent(expression, forKey: .expression)
        if !images.isEmpty { try values.encode(images, forKey: .images) }
    }

    public var id: String { messageId }
    public var isNotice: Bool { kind == .notice }
}

/// A picture as the server lists it, on a reply or on an approval (client-contract「会話の画像」). The picture itself
/// is fetched by its ID; the same ID never changes.
public struct ShownImage: Codable, Equatable, Sendable {
    public let imageId: String
    public let mimeType: String
    public let bytes: Int
    /// Its size in pixels, when the server could read it. Both are there, or neither.
    public let width: Int?
    public let height: Int?

    public init(imageId: String, mimeType: String, bytes: Int, width: Int? = nil, height: Int? = nil) {
        self.imageId = imageId
        self.mimeType = mimeType
        self.bytes = bytes
        let known = (width ?? 0) > 0 && (height ?? 0) > 0
        self.width = known ? width : nil
        self.height = known ? height : nil
    }

    private enum CodingKeys: String, CodingKey { case imageId, mimeType, bytes, width, height }

    public init(from decoder: Decoder) throws {
        let values = try decoder.container(keyedBy: CodingKeys.self)
        self.init(
            imageId: try values.decode(String.self, forKey: .imageId), mimeType: try values.decode(String.self, forKey: .mimeType),
            bytes: try values.decode(Int.self, forKey: .bytes),
            width: try? values.decodeIfPresent(Int.self, forKey: .width),
            height: try? values.decodeIfPresent(Int.self, forKey: .height))
    }

    /// Width over height, when the size is known.
    public var aspectRatio: CGFloat? {
        guard let width, let height else { return nil }
        return CGFloat(width) / CGFloat(height)
    }
}

public struct PendingEvent: Codable, Equatable, Sendable {
    public let eventId: String
    public let messageId: String
    public let state: EventState

    public init(eventId: String, messageId: String, state: EventState) {
        self.eventId = eventId
        self.messageId = messageId
        self.state = state
    }
}

/// What the owner has read and checked, as the server keeps it for every device (client-contract「既読と知らせの確認」).
public struct ReadState: Equatable, Sendable {
    /// Replies up to this message are read; nil when nothing is.
    public var readThroughMessageId: String?
    /// Unread replies, counting ones older than the snapshot's messages.
    public var unreadReplyCount: Int
    /// Notices not checked yet, oldest first, including ones older than the snapshot's messages.
    public var unacknowledgedNotificationIds: [String]

    public init(readThroughMessageId: String? = nil, unreadReplyCount: Int = 0, unacknowledgedNotificationIds: [String] = []) {
        self.readThroughMessageId = readThroughMessageId
        self.unreadReplyCount = unreadReplyCount
        self.unacknowledgedNotificationIds = unacknowledgedNotificationIds
    }
}

public struct Snapshot: Equatable, Sendable {
    public let deviceId: String
    public let messages: [ShownMessage]
    public let pendingEvents: [PendingEvent]
    public let expression: Expression
    public let readState: ReadState
    /// Slack posts waiting for the owner, oldest first.
    public let pendingApprovals: [Approval]
    /// The model routes; nil from a server that does not say them.
    public let modelRoutes: ModelRoutes?

    public init(
        deviceId: String, messages: [ShownMessage], pendingEvents: [PendingEvent], expression: Expression,
        readState: ReadState = ReadState(), pendingApprovals: [Approval] = [], modelRoutes: ModelRoutes? = nil
    ) {
        self.deviceId = deviceId
        self.messages = messages
        self.pendingEvents = pendingEvents
        self.expression = expression
        self.readState = readState
        self.pendingApprovals = pendingApprovals
        self.modelRoutes = modelRoutes
    }
}

public struct EventCompletion: Codable, Equatable, Sendable {
    public let eventId: String
    public let messageId: String
    public let status: EventState
    public let reason: String?

    public init(eventId: String, messageId: String, status: EventState, reason: String?) {
        self.eventId = eventId
        self.messageId = messageId
        self.status = status
        self.reason = reason
    }
}

/// `command.accepted`: a recorded `conversation.send`, a `session.sync` that replayed what was missed, the read
/// position after `conversation.read`, the notice `notification.ack` checked, the state `approval.decide` left an
/// approval in, the routes `model.list` asked for, or the route `model.use` chose.
public struct CommandAccepted: Decodable, Equatable, Sendable {
    public let messageId: String?
    public let eventId: String?
    public let state: EventState?
    public let deviceId: String?
    public let mode: String?
    public let readThroughMessageId: String?
    public let unreadReplyCount: Int?
    public let notificationId: String?
    public let approvalId: String?
    public let revision: Int?
    /// `state` on an answer to `approval.decide`, which shares the field with the conversation's.
    public let approvalOutcome: ApprovalOutcome?
    /// The whole of the routes, on an answer to `model.list`.
    public let modelRoutes: ModelRoutes?
    /// `chosen` on an answer to `model.use`. Its `current` is not kept: `model.routes` says when she moves, and may
    /// come before this answer.
    public let chosenRoute: String?

    public init(
        messageId: String? = nil, eventId: String? = nil, state: EventState? = nil, deviceId: String? = nil, mode: String? = nil,
        readThroughMessageId: String? = nil, unreadReplyCount: Int? = nil, notificationId: String? = nil,
        approvalId: String? = nil, revision: Int? = nil, approvalOutcome: ApprovalOutcome? = nil,
        modelRoutes: ModelRoutes? = nil, chosenRoute: String? = nil
    ) {
        self.messageId = messageId
        self.eventId = eventId
        self.state = state
        self.deviceId = deviceId
        self.mode = mode
        self.readThroughMessageId = readThroughMessageId
        self.unreadReplyCount = unreadReplyCount
        self.notificationId = notificationId
        self.approvalId = approvalId
        self.revision = revision
        self.approvalOutcome = approvalOutcome
        self.modelRoutes = modelRoutes
        self.chosenRoute = chosenRoute
    }

    private enum CodingKeys: String, CodingKey {
        case messageId, eventId, state, deviceId, mode, readThroughMessageId, unreadReplyCount, notificationId, approvalId, revision
        case chosen
    }

    public init(from decoder: Decoder) throws {
        let values = try decoder.container(keyedBy: CodingKeys.self)
        let state = try values.decodeIfPresent(String.self, forKey: .state)
        self.init(
            messageId: try values.decodeIfPresent(String.self, forKey: .messageId),
            eventId: try values.decodeIfPresent(String.self, forKey: .eventId),
            state: state.flatMap(EventState.init(rawValue:)), deviceId: try values.decodeIfPresent(String.self, forKey: .deviceId),
            mode: try values.decodeIfPresent(String.self, forKey: .mode),
            readThroughMessageId: try values.decodeIfPresent(String.self, forKey: .readThroughMessageId),
            unreadReplyCount: try values.decodeIfPresent(Int.self, forKey: .unreadReplyCount),
            notificationId: try values.decodeIfPresent(String.self, forKey: .notificationId),
            approvalId: try values.decodeIfPresent(String.self, forKey: .approvalId),
            revision: try values.decodeIfPresent(Int.self, forKey: .revision),
            approvalOutcome: state.flatMap(ApprovalOutcome.init(rawValue:)),
            modelRoutes: try? ModelRoutes(from: decoder),
            chosenRoute: try? values.decodeIfPresent(String.self, forKey: .chosen))
    }
}

/// Where an event sits in the server's numbering: process epoch, device stream and sequence.
public struct StreamPosition: Codable, Equatable, Sendable {
    public let epoch: String
    public let streamId: String
    public let seq: Int

    public init(epoch: String, streamId: String, seq: Int) {
        self.epoch = epoch
        self.streamId = streamId
        self.seq = seq
    }
}
