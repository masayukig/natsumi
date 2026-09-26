import Foundation

/// A message the owner sent that the server has not recorded yet.
public struct OutgoingMessage: Equatable, Identifiable, Sendable {
    public enum Status: Equatable, Sendable {
        case sending
        case rejected(String)
        case unavailable(String)
    }

    public let requestId: String
    public let text: String
    public var status: Status

    public init(requestId: String, text: String, status: Status) {
        self.requestId = requestId
        self.text = text
        self.status = status
    }

    public var id: String { requestId }
}

/// Something the owner read or checked on this device that the server has not answered yet. It shows at once and is
/// dropped when the server accepts it (its answer is then the state) or refuses it (the server's state stands).
public struct ReadChange: Equatable, Sendable {
    public enum Kind: Equatable, Sendable {
        case read(throughMessageId: String)
        case acknowledge(notificationId: String)
    }

    public let requestId: String
    public let kind: Kind

    public init(requestId: String, kind: Kind) {
        self.requestId = requestId
        self.kind = kind
    }

    var command: ClientCommand {
        switch kind {
        case .read(let id): .conversationRead(throughMessageId: id)
        case .acknowledge(let id): .notificationAck(notificationId: id)
        }
    }
}

/// What the conversation window shows, built only from server events and the owner's own unsent messages.
public struct ConversationState: Equatable, Sendable {
    public private(set) var messages: [ShownMessage] = []
    /// Owner messages natsumi has not finished with, by event ID.
    public private(set) var pendingEvents: [String: EventState] = [:]
    public private(set) var expression: Expression = .neutral
    /// The line natsumi is writing now, while she is handling something (ADR 0017). It is not part of the
    /// conversation: nothing keeps it, no snapshot carries it, and the end of the handling clears it.
    public private(set) var thinkingLine: String?
    public private(set) var outbox: [OutgoingMessage] = []
    /// What the server says the owner has read and checked.
    public private(set) var readState = ReadState()
    /// Reads and checks on this device the server has not answered, oldest first.
    public private(set) var localReadChanges: [ReadChange] = []

    public init() {}

    /// natsumi has owner messages still to handle. The face is not used: the model can leave the thinking face after
    /// it has finished, and the server only puts back a face it set itself.
    public var isThinking: Bool { !pendingEvents.isEmpty }

    /// Messages to send (again) once the connection is synced. The server answers a resent requestId with the same result.
    public var unsent: [OutgoingMessage] { outbox.filter { $0.status == .sending } }

    // MARK: - Read state

    /// natsumi's newest reply, read or not: what the balloon says (ADR 0022).
    public var lastReply: ShownMessage? {
        messages.last { $0.kind == .reply }
    }

    /// Whether `message` came while natsumi is handling what the owner said: after the oldest owner message still
    /// waiting for her (ADR 0025). Nothing did when she is not handling anything, or when that message is older than
    /// `messages` and there is nothing to compare with.
    public func isFromCurrentHandling(_ message: ShownMessage) -> Bool {
        guard let start = messages.firstIndex(where: { $0.eventId.map { pendingEvents[$0] != nil } ?? false }),
            let index = messages.lastIndex(where: { $0.messageId == message.messageId })
        else { return false }
        return index > start
    }

    /// Unread replies in `messages`, oldest first.
    public var unreadReplies: [ShownMessage] {
        messages[(readIndex + 1)...].filter { $0.kind == .reply }
    }

    /// All unread replies. When the read position is older than `messages`, the server's count includes replies
    /// before them.
    public var unreadReplyCount: Int {
        let listed = unreadReplies.count
        guard readIndex < 0 else { return listed }
        return max(readState.unreadReplyCount, listed)
    }

    /// Notices not checked yet, oldest first; some may be older than `messages`.
    public var unacknowledgedNotificationIds: [String] {
        let checking = Set(localReadChanges.compactMap { if case .acknowledge(let id) = $0.kind { id } else { nil } })
        return readState.unacknowledgedNotificationIds.filter { !checking.contains($0) }
    }

    /// An unread reply or a notice not checked yet.
    public func isUnread(_ message: ShownMessage) -> Bool {
        switch message.kind {
        case .reply: (messages.firstIndex { $0.messageId == message.messageId } ?? -1) > readIndex
        case .notice: unacknowledgedNotificationIds.contains(message.messageId)
        case .message: false
        }
    }

    /// `isUnread` for each of `messages`, in order. The read position and the notices are worked out once, not once
    /// a row: the history is derived again whenever the rows in sight change.
    public var unreadFlags: [Bool] {
        let readIndex = readIndex
        let notices = Set(unacknowledgedNotificationIds)
        return messages.enumerated().map { index, message in
            switch message.kind {
            case .reply: index > readIndex
            case .notice: notices.contains(message.messageId)
            case .message: false
            }
        }
    }

    /// Where reading has got to in `messages`, counting this device's reads not answered yet; -1 before all of them.
    /// A position not in `messages` is older than them.
    private var readIndex: Int {
        var positions = localReadChanges.compactMap { if case .read(let id) = $0.kind { id } else { nil } }
        if let server = readState.readThroughMessageId { positions.append(server) }
        return positions.compactMap { id in messages.lastIndex { $0.messageId == id } }.max() ?? -1
    }

    /// Reads replies up to `messageId` before the server answers. Nothing changes unless it moves the position forward.
    @discardableResult
    public mutating func markRead(through messageId: String, requestId: String) -> ReadChange? {
        guard let index = messages.firstIndex(where: { $0.messageId == messageId }), index > readIndex else { return nil }
        let change = ReadChange(requestId: requestId, kind: .read(throughMessageId: messageId))
        localReadChanges.append(change)
        return change
    }

    /// Checks a notice before the server answers. Nothing changes unless it is still unchecked.
    @discardableResult
    public mutating func markAcknowledged(_ notificationId: String, requestId: String) -> ReadChange? {
        guard unacknowledgedNotificationIds.contains(notificationId) else { return nil }
        let change = ReadChange(requestId: requestId, kind: .acknowledge(notificationId: notificationId))
        localReadChanges.append(change)
        return change
    }

    // MARK: - Sending

    public mutating func enqueue(text: String, requestId: String) {
        outbox.append(OutgoingMessage(requestId: requestId, text: text, status: .sending))
    }

    public mutating func dismiss(requestId: String) {
        outbox.removeAll { $0.requestId == requestId }
    }

    public mutating func apply(_ event: ServerEvent, requestId: String? = nil) {
        switch event {
        case .snapshot(let snapshot):
            messages = snapshot.messages
            pendingEvents = Dictionary(
                snapshot.pendingEvents.filter { $0.state.isPending }.map { ($0.eventId, $0.state) },
                uniquingKeysWith: { _, latest in latest })
            expression = snapshot.expression
            readState = snapshot.readState
            // A snapshot is the whole of what the server keeps, and the line is not in it.
            thinkingLine = nil
        case .message(let message):
            guard !messages.contains(where: { $0.messageId == message.messageId }) else { return }
            messages.append(message)
            switch message.kind {
            case .message:
                if let eventId = message.eventId, pendingEvents[eventId] == nil { pendingEvents[eventId] = .queued }
            case .reply:
                readState.unreadReplyCount += 1
            case .notice:
                if !readState.unacknowledgedNotificationIds.contains(message.messageId) {
                    readState.unacknowledgedNotificationIds.append(message.messageId)
                }
            }
        case .expression(let expression):
            self.expression = expression
        case .thinking(let line):
            // The empty line is the server saying the thinking is over.
            thinkingLine = line.isEmpty ? nil : line
        case .eventCompleted(let completion):
            pendingEvents[completion.eventId] = nil
            // She may still be on another message; the line goes only when there is nothing left to handle.
            if pendingEvents.isEmpty { thinkingLine = nil }
        case .readMoved(let through, let count):
            readState.readThroughMessageId = through
            readState.unreadReplyCount = count
        case .notificationAcked(let id):
            readState.unacknowledgedNotificationIds.removeAll { $0 == id }
        case .sessionRenewed, .approvalPending, .approvalResolved, .modelRoutes:
            // The session's, the approvals' and the routes', not the conversation's.
            break
        case .accepted(let accepted):
            if let index = changeIndex(requestId) {
                localReadChanges.remove(at: index)
                if let through = accepted.readThroughMessageId {
                    readState.readThroughMessageId = through
                    readState.unreadReplyCount = accepted.unreadReplyCount ?? readState.unreadReplyCount
                }
                if let id = accepted.notificationId { readState.unacknowledgedNotificationIds.removeAll { $0 == id } }
                return
            }
            guard let index = outboxIndex(requestId) else { return }
            outbox.remove(at: index)
            if let eventId = accepted.eventId, let state = accepted.state {
                if state.isPending {
                    pendingEvents[eventId] = pendingEvents[eventId] ?? state
                } else {
                    pendingEvents[eventId] = nil
                }
            }
        case .rejected(let code):
            if let index = changeIndex(requestId) {
                localReadChanges.remove(at: index)
            } else if let index = outboxIndex(requestId) {
                outbox[index].status = .rejected(code)
            }
        case .unavailable(let code, _):
            if let index = changeIndex(requestId) {
                localReadChanges.remove(at: index)
            } else if let index = outboxIndex(requestId) {
                outbox[index].status = .unavailable(code)
            }
        }
    }

    private func outboxIndex(_ requestId: String?) -> Int? {
        guard let requestId else { return nil }
        return outbox.firstIndex { $0.requestId == requestId }
    }

    private func changeIndex(_ requestId: String?) -> Int? {
        guard let requestId else { return nil }
        return localReadChanges.firstIndex { $0.requestId == requestId }
    }
}
