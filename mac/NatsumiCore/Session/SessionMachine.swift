import Foundation

/// Why a WebSocket connection ended.
public enum CloseReason: Equatable, Sendable {
    /// The server closed the socket with this code.
    case code(Int)
    /// The upgrade was refused with this HTTP status.
    case httpStatus(Int)
    /// The network failed without a close code.
    case network
}

/// What the owner of a `SessionMachine` must do.
public enum SessionEffect: Equatable, Sendable {
    case connect
    case disconnect
    case send(ClientEnvelope)
    case saveDeviceId(String)
    case requireLogin
    case scheduleReconnect(after: TimeInterval)
    /// Keep the saved session until this time, if that is later than what is saved (ADR 0030).
    case extendSession(until: Date)
}

public enum SessionPhase: Equatable, Sendable {
    case idle
    case connecting
    case syncing
    case ready
    case waitingToReconnect
    case unavailable(String)
    case loginRequired
    /// A newer connection of this device took over (close code 4001).
    case replaced
    case stopped
}

/// The connection to the server as a state machine without I/O: device registration, sync and resync, sending with
/// request IDs, and reconnecting. The caller performs the effects and feeds back what happened.
public struct SessionMachine {
    public private(set) var phase: SessionPhase = .idle
    public private(set) var deviceId: String?
    public private(set) var conversation = ConversationState()
    /// The Slack posts waiting for the owner, and the owner's decisions on them.
    public private(set) var approvals = ApprovalBook()
    /// The model routes, and the owner's choice of one on its way (ADR 0046).
    public private(set) var modelRoutes = ModelRouteBook()

    /// Where this iPhone wants its notifications, sent after every sync (ADR 0029). The Mac has none.
    private var pushRegistration: PushRegistration?
    private var tracker = StreamTracker()
    private var syncRequestId: String?
    private var failures = 0
    private let makeRequestId: () -> String

    static let maxReconnectDelay: TimeInterval = 30

    public init(deviceId: String?, makeRequestId: @escaping () -> String = { UUID().uuidString }) {
        self.deviceId = deviceId
        self.makeRequestId = makeRequestId
    }

    public mutating func start() -> [SessionEffect] {
        phase = .connecting
        return [.connect]
    }

    public mutating func stop() -> [SessionEffect] {
        phase = .idle
        syncRequestId = nil
        return [.disconnect]
    }

    public mutating func connected() -> [SessionEffect] {
        guard phase == .connecting else { return [] }
        phase = .syncing
        return [sync(resume: tracker.position)]
    }

    public mutating func send(text: String) -> [SessionEffect] {
        let requestId = makeRequestId()
        conversation.enqueue(text: text, requestId: requestId)
        guard phase == .ready, let deviceId else { return [] }
        return [.send(ClientEnvelope(requestId: requestId, deviceId: deviceId, command: .conversationSend(text: text)))]
    }

    public mutating func dismiss(requestId: String) {
        conversation.dismiss(requestId: requestId)
    }

    /// Reads replies up to one the owner has seen. Nothing is sent unless it moves the position forward.
    public mutating func readReplies(through messageId: String) -> [SessionEffect] {
        read(through: messageId)
    }

    /// Reads every unread reply at once.
    public mutating func confirmAllReplies() -> [SessionEffect] {
        guard let last = conversation.unreadReplies.last else { return [] }
        return read(through: last.messageId)
    }

    /// Checks every notice not checked yet, from the menu.
    public mutating func acknowledgeAllNotices() -> [SessionEffect] {
        acknowledge(conversation.unacknowledgedNotificationIds)
    }

    /// Checks notices, one command each. The view changes before the server answers.
    public mutating func acknowledge(_ notificationIds: [String]) -> [SessionEffect] {
        var effects: [SessionEffect] = []
        for id in notificationIds {
            let requestId = makeRequestId()
            if let change = conversation.markAcknowledged(id, requestId: requestId) { effects += sendNow(change) }
        }
        return effects
    }

    /// Records the owner's decision on an approval and sends it now when synced; otherwise it waits for the sync
    /// like an unsent message. A second decision while the first is on its way sends nothing.
    public mutating func decideApproval(_ approvalId: String, _ decision: ApprovalDecision) -> [SessionEffect] {
        guard let sent = approvals.decide(approvalId, decision, requestId: makeRequestId()) else { return [] }
        guard phase == .ready, let deviceId else { return [] }
        return [.send(ClientEnvelope(requestId: sent.requestId, deviceId: deviceId, command: sent.command))]
    }

    /// Records the owner's choice of a model route and sends it now when synced; otherwise it waits for the sync like
    /// an unsent message. A second choice while the first is on its way sends nothing.
    public mutating func chooseRoute(_ name: String) -> [SessionEffect] {
        guard let choice = modelRoutes.choose(name, requestId: makeRequestId()) else { return [] }
        guard phase == .ready, let deviceId else { return [] }
        return [.send(ClientEnvelope(requestId: choice.requestId, deviceId: deviceId, command: .modelUse(route: choice.route)))]
    }

    /// Asks the server for the routes as they are now. Only when synced: the sync brings them anyway.
    public mutating func listRoutes() -> [SessionEffect] {
        guard phase == .ready, let deviceId else { return [] }
        return [.send(ClientEnvelope(requestId: makeRequestId(), deviceId: deviceId, command: .modelList))]
    }

    /// Keeps the registration and sends it now when synced. Every later sync sends it again, since the token can
    /// change and the server may have dropped it.
    public mutating func registerPush(_ registration: PushRegistration) -> [SessionEffect] {
        pushRegistration = registration
        guard phase == .ready, let deviceId else { return [] }
        return [.send(ClientEnvelope(requestId: makeRequestId(), deviceId: deviceId, command: .pushRegister(registration)))]
    }

    private mutating func read(through messageId: String) -> [SessionEffect] {
        let requestId = makeRequestId()
        guard let change = conversation.markRead(through: messageId, requestId: requestId) else { return [] }
        return sendNow(change)
    }

    /// A read or check goes out now when synced; otherwise it waits for the sync like an unsent message.
    private func sendNow(_ change: ReadChange) -> [SessionEffect] {
        guard phase == .ready, let deviceId else { return [] }
        return [.send(ClientEnvelope(requestId: change.requestId, deviceId: deviceId, command: change.command))]
    }

    public mutating func received(_ data: Data) -> [SessionEffect] {
        switch phase {
        case .syncing, .ready, .unavailable: break
        default: return []
        }
        guard let envelope = try? ServerEnvelope.decode(data) else { return [] }
        let isSyncAnswer = envelope.requestId != nil && envelope.requestId == syncRequestId

        switch tracker.accept(envelope) {
        case .ignore:
            return []
        case .resync:
            // One sync at a time; events after the gap are dropped until its snapshot arrives.
            guard syncRequestId == nil else { return [] }
            phase = .syncing
            return [sync(resume: nil)]
        case .apply:
            break
        }
        guard let event = envelope.event else { return [] }
        if case .sessionRenewed(let expiresAt) = event { return [.extendSession(until: expiresAt)] }

        guard isSyncAnswer else {
            conversation.apply(event, requestId: envelope.requestId)
            approvals.apply(event, requestId: envelope.requestId)
            modelRoutes.apply(event, requestId: envelope.requestId)
            return []
        }
        var effects: [SessionEffect] = envelope.sessionExpiresAt.map { [.extendSession(until: $0)] } ?? []
        switch event {
        case .snapshot(let snapshot):
            syncRequestId = nil
            conversation.apply(event)
            approvals.apply(event)
            modelRoutes.apply(event)
            effects += adopt(snapshot.deviceId)
            effects += becomeReady()
        case .accepted(let accepted) where accepted.mode == "resume":
            syncRequestId = nil
            if let id = accepted.deviceId { effects += adopt(id) }
            effects += becomeReady()
        case .unavailable(let code, let id):
            syncRequestId = nil
            if let id { effects += adopt(id) }
            phase = .unavailable(code)
        case .rejected:
            syncRequestId = nil
            phase = .stopped
            effects.append(.disconnect)
        default:
            conversation.apply(event, requestId: envelope.requestId)
            approvals.apply(event, requestId: envelope.requestId)
            modelRoutes.apply(event, requestId: envelope.requestId)
        }
        return effects
    }

    public mutating func closed(_ reason: CloseReason) -> [SessionEffect] {
        switch phase {
        case .idle, .loginRequired, .replaced, .stopped: return []
        default: break
        }
        syncRequestId = nil
        switch reason {
        case .code(1008), .httpStatus(401):
            phase = .loginRequired
            return [.requireLogin]
        case .code(4001):
            phase = .replaced
            return []
        case .code(1002), .code(1007):
            phase = .stopped
            return []
        default:
            let delay = min(Self.maxReconnectDelay, pow(2, Double(failures)))
            failures += 1
            phase = .waitingToReconnect
            return [.scheduleReconnect(after: delay)]
        }
    }

    /// Drops the connection and connects again at once, for when it may have died without a close: the Mac woke from
    /// sleep. The machine goes on, so the sync resumes from where the stream was and nothing unsent or read is lost.
    /// A session that ended, was taken over or stopped stays as it is.
    public mutating func reconnectNow() -> [SessionEffect] {
        switch phase {
        case .idle, .loginRequired, .replaced, .stopped: return []
        case .connecting, .syncing, .ready, .waitingToReconnect, .unavailable: break
        }
        syncRequestId = nil
        phase = .connecting
        return [.disconnect, .connect]
    }

    public mutating func reconnectTimerFired() -> [SessionEffect] {
        guard phase == .waitingToReconnect else { return [] }
        phase = .connecting
        return [.connect]
    }

    private mutating func sync(resume: StreamPosition?) -> SessionEffect {
        let requestId = makeRequestId()
        syncRequestId = requestId
        return .send(ClientEnvelope(requestId: requestId, deviceId: deviceId, command: .sessionSync(resume: resume)))
    }

    private mutating func adopt(_ id: String) -> [SessionEffect] {
        guard deviceId != id else { return [] }
        deviceId = id
        return [.saveDeviceId(id)]
    }

    private mutating func becomeReady() -> [SessionEffect] {
        phase = .ready
        failures = 0
        guard let deviceId else { return [] }
        let sends = conversation.unsent.map {
            SessionEffect.send(ClientEnvelope(requestId: $0.requestId, deviceId: deviceId, command: .conversationSend(text: $0.text)))
        }
        // Reads and checks are safe to send again: the position only moves forward and a check is recorded once.
        let changes = conversation.localReadChanges.map {
            SessionEffect.send(ClientEnvelope(requestId: $0.requestId, deviceId: deviceId, command: $0.command))
        }
        // A decision is idempotent too: the server answers one on a closed approval with the state it closed in.
        let decisions = approvals.unsent.map {
            SessionEffect.send(ClientEnvelope(requestId: $0.requestId, deviceId: deviceId, command: $0.command))
        }
        // Choosing is idempotent too: choosing the route already chosen is taken and changes nothing.
        let choice = modelRoutes.unsent.map {
            [SessionEffect.send(ClientEnvelope(requestId: $0.requestId, deviceId: deviceId, command: .modelUse(route: $0.route)))]
        } ?? []
        // Registering is idempotent on the server: the same device's registration is overwritten.
        let register = pushRegistration.map {
            [SessionEffect.send(ClientEnvelope(requestId: makeRequestId(), deviceId: deviceId, command: .pushRegister($0)))]
        } ?? []
        return sends + changes + decisions + choice + register
    }
}
