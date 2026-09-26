import Foundation

public let protocolVersion = 1

public enum EnvelopeError: Error, Equatable {
    case malformed
    case unsupportedVersion
}

/// The server events this client understands.
public enum ServerEvent: Equatable, Sendable {
    case snapshot(Snapshot)
    case message(ShownMessage)
    case expression(Expression)
    case eventCompleted(EventCompletion)
    /// `conversation.thinking`: the line natsumi is writing right now. An empty line says the thinking is over.
    /// It is of the moment: it takes no number on the stream and is in no snapshot (ADR 0017).
    case thinking(line: String)
    /// `conversation.read`: some device moved the read position.
    case readMoved(readThroughMessageId: String, unreadReplyCount: Int)
    /// `notification.acked`: some device checked a notice for the first time.
    case notificationAcked(notificationId: String)
    /// `session.renewed`: the server moved the session's expiry while connected (ADR 0030). Like the line of
    /// thinking, it takes no number on the stream.
    case sessionRenewed(expiresAt: Date)
    /// `approval.pending`: a Slack post is waiting for the owner.
    case approvalPending(Approval)
    /// `approval.resolved`: an approval was closed, and what came of it.
    case approvalResolved(ApprovalResolution)
    /// `model.routes`: which route natsumi uses, which the owner chose, or which can be used changed (ADR 0046).
    case modelRoutes(ModelRoutes)
    case accepted(CommandAccepted)
    case rejected(code: String)
    case unavailable(code: String, deviceId: String?)
}

/// One message from the server. `event` is nil for types (or values) this client does not know, which are ignored
/// while their position still counts.
public struct ServerEnvelope: Equatable, Sendable {
    public let position: StreamPosition
    public let requestId: String?
    public let event: ServerEvent?
    /// The session's expiry on an answer to `session.sync` (the snapshot, the resume's `command.accepted`, or
    /// `service.unavailable`), or nil when the server did not say (ADR 0030).
    public let sessionExpiresAt: Date?

    public init(position: StreamPosition, requestId: String?, event: ServerEvent?, sessionExpiresAt: Date? = nil) {
        self.position = position
        self.requestId = requestId
        self.event = event
        self.sessionExpiresAt = sessionExpiresAt
    }

    public static func decode(_ data: Data) throws -> ServerEnvelope {
        let decoder = JSONDecoder()
        guard let head = try? decoder.decode(Head.self, from: data), let version = head.v else { throw EnvelopeError.malformed }
        guard version == protocolVersion else { throw EnvelopeError.unsupportedVersion }
        guard let epoch = head.epoch, let streamId = head.streamId, let seq = head.seq, let type = head.type else {
            throw EnvelopeError.malformed
        }
        func payload<P: Decodable>(_: P.Type) -> P? { try? decoder.decode(Body<P>.self, from: data).payload }

        let event: ServerEvent? = switch type {
        case "session.snapshot":
            payload(SnapshotPayload.self).map {
                .snapshot(Snapshot(
                    deviceId: $0.deviceId, messages: $0.messages, pendingEvents: $0.pendingEvents, expression: $0.avatar.expression,
                    readState: ReadState(
                        readThroughMessageId: $0.readThroughMessageId, unreadReplyCount: $0.unreadReplyCount ?? 0,
                        unacknowledgedNotificationIds: $0.unacknowledgedNotificationIds ?? []),
                    pendingApprovals: $0.pendingApprovals?.elements ?? [], modelRoutes: $0.modelRoutes?.value))
            }
        case "conversation.message": payload(ShownMessage.self).map { .message($0) }
        case "avatar.expression": payload(ExpressionPayload.self).map { .expression($0.expression) }
        case "conversation.event.completed": payload(EventCompletion.self).map { .eventCompleted($0) }
        case "conversation.thinking": payload(ThinkingPayload.self).map { .thinking(line: $0.line) }
        case "conversation.read":
            payload(ReadPayload.self).map { .readMoved(readThroughMessageId: $0.readThroughMessageId, unreadReplyCount: $0.unreadReplyCount) }
        case "notification.acked": payload(AckedPayload.self).map { .notificationAcked(notificationId: $0.notificationId) }
        case "session.renewed": payload(RenewedPayload.self).flatMap { parseTimestamp($0.expiresAt) }.map { .sessionRenewed(expiresAt: $0) }
        case "approval.pending": payload(Approval.self).map { .approvalPending($0) }
        case "approval.resolved": payload(ApprovalResolution.self).map { .approvalResolved($0) }
        case "model.routes": payload(ModelRoutes.self).map { .modelRoutes($0) }
        case "command.accepted": payload(CommandAccepted.self).map { .accepted($0) }
        case "command.rejected": payload(CodePayload.self).map { .rejected(code: $0.code) }
        case "service.unavailable": payload(CodePayload.self).map { .unavailable(code: $0.code, deviceId: $0.deviceId) }
        default: nil
        }
        let expiresAt: Date? = switch type {
        case "session.snapshot", "command.accepted", "service.unavailable":
            payload(ExpiryPayload.self)?.sessionExpiresAt.flatMap(parseTimestamp)
        default: nil
        }
        return ServerEnvelope(
            position: StreamPosition(epoch: epoch, streamId: streamId, seq: seq), requestId: head.requestId, event: event,
            sessionExpiresAt: expiresAt)
    }

    private struct Head: Decodable {
        let v: Int?
        let epoch: String?
        let streamId: String?
        let seq: Int?
        let type: String?
        let requestId: String?
    }

    private struct Body<Payload: Decodable>: Decodable { let payload: Payload }

    private struct SnapshotPayload: Decodable {
        let deviceId: String
        let messages: [ShownMessage]
        let pendingEvents: [PendingEvent]
        let avatar: ExpressionPayload
        let readThroughMessageId: String?
        let unreadReplyCount: Int?
        let unacknowledgedNotificationIds: [String]?
        let pendingApprovals: Lossy<Approval>?
        let modelRoutes: Lenient<ModelRoutes>?
    }

    /// A field that is left out when it cannot be read, rather than losing the whole payload with it.
    private struct Lenient<Value: Decodable>: Decodable {
        let value: Value?

        init(from decoder: Decoder) throws {
            value = try? Value(from: decoder)
        }
    }

    private struct ExpressionPayload: Decodable { let expression: Expression }

    private struct ReadPayload: Decodable {
        let readThroughMessageId: String
        let unreadReplyCount: Int
    }

    private struct AckedPayload: Decodable { let notificationId: String }

    private struct ThinkingPayload: Decodable { let line: String }

    private struct RenewedPayload: Decodable { let expiresAt: String }

    private struct ExpiryPayload: Decodable { let sessionExpiresAt: String? }

    private struct CodePayload: Decodable {
        let code: String
        let deviceId: String?
    }
}

public enum ClientCommand: Equatable, Sendable {
    case sessionSync(resume: StreamPosition?)
    case conversationSend(text: String)
    case conversationRead(throughMessageId: String)
    case notificationAck(notificationId: String)
    /// Where to send this iPhone's notifications, and the key to seal them to (ADR 0029).
    case pushRegister(PushRegistration)
    /// The owner's answer to an approval, for the revision they saw.
    case approvalDecide(approvalId: String, revision: Int, decision: ApprovalDecision)
    /// Asks for the model routes as they are now.
    case modelList
    /// The owner's choice of a model route, followed from her next turn (ADR 0046).
    case modelUse(route: String)
}

/// One command to the server.
public struct ClientEnvelope: Equatable, Sendable {
    public let requestId: String
    public let deviceId: String?
    public let command: ClientCommand

    public init(requestId: String, deviceId: String?, command: ClientCommand) {
        self.requestId = requestId
        self.deviceId = deviceId
        self.command = command
    }

    public func encoded() throws -> Data {
        var object: [String: Any] = ["v": protocolVersion, "requestId": requestId]
        if let deviceId { object["deviceId"] = deviceId }
        switch command {
        case .sessionSync(let resume):
            object["type"] = "session.sync"
            if let resume {
                object["payload"] = ["resume": ["epoch": resume.epoch, "streamId": resume.streamId, "seq": resume.seq]]
            } else {
                object["payload"] = ["resume": NSNull()]
            }
        case .conversationSend(let text):
            object["type"] = "conversation.send"
            object["payload"] = ["text": text]
        case .conversationRead(let throughMessageId):
            object["type"] = "conversation.read"
            object["payload"] = ["throughMessageId": throughMessageId]
        case .notificationAck(let notificationId):
            object["type"] = "notification.ack"
            object["payload"] = ["notificationId": notificationId]
        case .pushRegister(let registration):
            object["type"] = "push.register"
            object["payload"] = [
                "token": registration.token, "publicKey": registration.publicKey, "environment": registration.environment.rawValue,
            ]
        case .approvalDecide(let approvalId, let revision, let decision):
            object["type"] = "approval.decide"
            var payload: [String: Any] = ["approvalId": approvalId, "revision": revision]
            switch decision {
            case .approve(let placement):
                payload["decision"] = "approve"
                if let placement { payload["placement"] = placement.rawValue }
            case .edit(let text, let placement):
                payload["decision"] = "edit"
                payload["text"] = text
                if let placement { payload["placement"] = placement.rawValue }
            case .reject:
                payload["decision"] = "reject"
            }
            object["payload"] = payload
        case .modelList:
            object["type"] = "model.list"
            object["payload"] = [String: Any]()
        case .modelUse(let route):
            object["type"] = "model.use"
            object["payload"] = ["route": route]
        }
        return try JSONSerialization.data(withJSONObject: object, options: [.sortedKeys])
    }
}
