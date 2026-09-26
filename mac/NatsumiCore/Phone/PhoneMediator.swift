import Foundation

/// The state machine the iPhone's UI is arbitrated by: `(State, Event) -> (State, [Effect])` (ADR 0028).
///
/// Like the Mac's `UIMediator`, it does no I/O: what has to happen out in the world leaves as an effect for the root
/// to run. The connection is `SessionMachine`'s, and what is read and shown follows the Mac's rules (ADR 0022,
/// ADR 0025), so both clients agree on what the owner has seen.
public struct PhoneMediator {
    public private(set) var state: PhoneState
    private let makeRequestId: () -> String

    public init(makeRequestId: @escaping () -> String = { UUID().uuidString }) {
        self.makeRequestId = makeRequestId
        self.state = PhoneState(session: SessionMachine(deviceId: nil, makeRequestId: makeRequestId))
    }

    public mutating func handle(_ event: PhoneEvent) -> [PhoneEffect] {
        let wasConnected = state.status == .connected
        let effects = decide(event) + readWhatIsSeen()
        // Coming back to the server is the time to try again for the pictures that could not be had.
        if state.status == .connected, !wasConnected { state.images.retryUnavailable() }
        return effects + fetchShownImages() + tidyNotifications()
    }

    private mutating func decide(_ event: PhoneEvent) -> [PhoneEffect] {
        switch event {
        // MARK: The app and the world outside
        case .launched(let serverOrigin):
            state.serverOrigin = serverOrigin
            return [.loadAvatar] + resume()

        case .sessionResumed(let hasSession, let deviceId):
            // A session is for a server; without one there is nothing to use it with, and only the login to show.
            state.hasSession = hasSession && state.serverOrigin != nil
            guard state.serverOrigin != nil else {
                state.status = .needsServer
                return []
            }
            guard hasSession else {
                state.status = .needsLogin
                return []
            }
            state.session = SessionMachine(deviceId: deviceId, makeRequestId: makeRequestId)
            if let registration = state.pushRegistration { _ = state.session.registerPush(registration) }
            return [.registerForNotifications] + apply(state.session.start())

        case .credentialsMissing:
            _ = state.session.stop()
            state.hasSession = false
            state.status = .needsLogin
            return [.disconnect]

        case .avatarLoaded(let art):
            state.avatar = art
            return []

        case .loginFinished(.succeeded):
            state.loginMessage = nil
            return resume()

        case .loginFinished(.cancelled):
            state.status = .needsLogin
            return []

        case .loginFinished(.failed(let message)):
            state.loginMessage = message
            state.status = .needsLogin
            return []

        case .socketOpened:
            return apply(state.session.connected())

        case .socketReceived(let data):
            return apply(state.session.received(data))

        case .socketClosed(let reason):
            return apply(state.session.closed(reason))

        case .reconnectTimerFired:
            return apply(state.session.reconnectTimerFired())

        case .becameActive:
            // The same machine goes on, so the sync resumes from where the stream was and nothing unsent is lost.
            guard state.hasSession else { return [] }
            switch state.session.phase {
            case .idle, .replaced, .stopped, .unavailable:
                return [.disconnect] + apply(state.session.start())
            case .waitingToReconnect:
                // The wait was for a network that failed; the owner is here now, so it is tried at once.
                return [.disconnect] + apply(state.session.reconnectTimerFired())
            case .connecting, .syncing, .ready, .loginRequired:
                return []
            }

        case .enteredBackground:
            guard state.hasSession else { return [] }
            return apply(state.session.stop())

        case .pushRegistrationReady(let registration):
            state.pushRegistration = registration
            return apply(state.session.registerPush(registration))

        case .backgroundPushReceived(let push):
            return [.tidyNotifications(.background(push))]

        case .approvalResolvedPushReceived(let push):
            return [.tidyNotifications(.approvalResolved(push))]

        case .approvalNotificationOpened(let id):
            // From wherever the owner was: back from it goes to the list of approvals.
            guard state.hasSession else { return [] }
            openApproval(id)
            return []

        // MARK: Login
        case .loginSubmitted(let text):
            guard state.status != .loggingIn else { return [] }
            let address: ServerAddress
            do {
                address = try ServerAddress(text)
            } catch ServerAddressError.insecure {
                state.loginMessage = "http は localhost などのループバックだけで使えます。https の URL を入れてください"
                return []
            } catch {
                state.loginMessage = "https://ホスト名[:ポート] の形で入れてください"
                return []
            }
            state.loginMessage = nil
            state.status = .loggingIn
            // The next session starts on the main screen, whatever was open when the last one ended.
            closePage()
            guard address.origin.absoluteString != state.serverOrigin else { return [.startLogin] }
            state.serverOrigin = address.origin.absoluteString
            state.session = SessionMachine(deviceId: nil, makeRequestId: makeRequestId)
            forgetImages()
            return [.saveServerAddress(address), .startLogin]

        // MARK: The main screen
        case .reconnectRequested:
            return resume()

        case .balloonCloseTapped:
            // The × reads everything up to her last reply, as on the Mac (ADR 0022).
            guard let last = UIProps.shownReply(state.conversation, readingHistory: false) else { return [] }
            return apply(state.session.readReplies(through: last.messageId))

        case .inputFocusChanged(let isComposing):
            state.isComposing = isComposing
            return []

        case .inputSubmitted(let text):
            guard !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { return [] }
            return apply(state.session.send(text: text))

        case .outgoingDismissed(let requestId):
            state.session.dismiss(requestId: requestId)
            return []

        case .approvalsOpenRequested:
            guard state.hasSession else { return [] }
            closePage()
            state.page = .approvals
            state.isComposing = false
            return []

        // MARK: The history and the settings
        case .historyOpenRequested:
            guard state.hasSession, state.page != .history else { return [] }
            state.page = .history
            state.isComposing = false
            state.visibleHistoryIds = []
            // Notices older than the history have no row to be seen in; opening the history is as far as the owner
            // can go to see them, so it checks them (ADR 0028).
            let listed = Set(state.conversation.messages.map(\.messageId))
            return apply(state.session.acknowledge(
                state.conversation.unacknowledgedNotificationIds.filter { !listed.contains($0) }))

        case .settingsOpenRequested:
            guard state.hasSession else { return [] }
            state.page = .settings
            state.isComposing = false
            state.visibleHistoryIds = []
            // The routes come with the sync and every change after it; opening the settings looks at them afresh.
            return apply(state.session.listRoutes())

        case .modelRouteChosen(let name):
            guard state.hasSession else { return [] }
            return apply(state.session.chooseRoute(name))

        case .pageClosed:
            closePage()
            return []

        case .linkTapped(let url):
            // As on the Mac: the browser opens and nothing is read (ADR 0038).
            return TextLinks.canOpen(url) ? [.openLink(url)] : []

        case .imageTapped(let id):
            // Only a picture that came can be opened; looking at it reads nothing.
            guard case .loaded = state.images[id] else { return [] }
            state.viewedImage = id
            return []

        case .imageViewerClosed:
            state.viewedImage = nil
            return []

        case .imageFetched(let id, let fetch):
            state.images.receive(id, fetch)
            return []

        case .historyRowVisibilityChanged(let id, let isVisible):
            guard state.isReadingHistory else { return [] }
            if isVisible {
                state.visibleHistoryIds.insert(id)
            } else {
                state.visibleHistoryIds.remove(id)
            }
            return []

        // MARK: The approvals
        case .approvalOpenRequested(let id):
            guard state.hasSession else { return [] }
            openApproval(id)
            return []

        case .approvalClosed:
            guard case .approval = state.page else { return [] }
            closePage()
            state.page = .approvals
            return []

        case .approvalPlacementChosen(let placement):
            guard case .approval = state.page else { return [] }
            state.approvalPlacement = placement
            return []

        case .approvalEditRequested:
            guard case .approval = state.page else { return [] }
            state.isEditingApproval = true
            return []

        case .approvalEditCancelled:
            state.isEditingApproval = false
            return []

        case .approvalApproved(let id):
            return decide(id, .approve(placement: chosenPlacement(id)))

        case .approvalRejected(let id):
            return decide(id, .reject)

        case .approvalEditSubmitted(let id, let text):
            guard !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { return [] }
            let effects = decide(id, .edit(text: text, placement: chosenPlacement(id)))
            if !effects.isEmpty || state.approvals.decisions[id] != nil { state.isEditingApproval = false }
            return effects

        case .logoutRequested:
            _ = state.session.stop()
            state.session = SessionMachine(deviceId: nil, makeRequestId: makeRequestId)
            state.hasSession = false
            state.status = state.serverOrigin == nil ? .needsServer : .needsLogin
            closePage()
            forgetImages()
            return [.disconnect, .logout]
        }
    }

    private mutating func closePage() {
        state.page = nil
        state.visibleHistoryIds = []
        state.isEditingApproval = false
        state.approvalPlacement = nil
    }

    private mutating func openApproval(_ id: String) {
        closePage()
        state.page = .approval(id)
        state.isComposing = false
    }

    /// The place the owner chose, when it differs from where the post would go. A post to the channel itself has no
    /// line to put a thread under, so it has no choice (the server ignores one).
    private func chosenPlacement(_ id: String) -> ApprovalPlacement? {
        guard state.page == .approval(id), let chosen = state.approvalPlacement,
              let target = state.approvals.approval(id)?.target, target.replyTo != nil, chosen != target.placement
        else { return nil }
        return chosen
    }

    private mutating func decide(_ id: String, _ decision: ApprovalDecision) -> [PhoneEffect] {
        guard state.hasSession else { return [] }
        return apply(state.session.decideApproval(id, decision))
    }

    /// Reads the replies and checks the notices the owner has seen in the history (ADR 0022, ADR 0028). Asked after
    /// every event, since any of them can bring these together — a row coming into sight, or a line arriving under
    /// the owner's eyes.
    private mutating func readWhatIsSeen() -> [PhoneEffect] {
        guard state.isReadingHistory else { return [] }
        var effects: [PhoneEffect] = []
        if let id = HistoryReading.target(state.conversation, visible: state.visibleHistoryIds) {
            effects += apply(state.session.readReplies(through: id))
        }
        let seen = state.conversation.unacknowledgedNotificationIds.filter { state.visibleHistoryIds.contains($0) }
        if !seen.isEmpty { effects += apply(state.session.acknowledge(seen)) }
        return effects
    }

    /// Lets go of the pictures of approvals that closed, and asks for the pictures the owner has in front of them:
    /// those of the rows of the history in sight, and those of the approval that is open while it waits (ADR 0045).
    private mutating func fetchShownImages() -> [PhoneEffect] {
        let pending = state.approvals.pending
        state.images.keepApprovalImages(Set(pending.flatMap { $0.images.map(\.imageId) }))
        if state.viewedImage != nil, PhoneProps.viewer(state) == nil { state.viewedImage = nil }
        guard state.hasSession else { return [] }
        var ids: [String] = []
        var approvalIds: [String] = []
        switch state.page {
        case .history where !state.visibleHistoryIds.isEmpty:
            ids = state.conversation.messages.filter { state.visibleHistoryIds.contains($0.messageId) }
                .flatMap { $0.images.map(\.imageId) }
        case .approval(let id):
            approvalIds = pending.first { $0.approvalId == id }?.images.map(\.imageId) ?? []
        default:
            break
        }
        return (state.images.request(ids) + state.images.request(approvalIds, forApproval: true))
            .map { .fetchImage(imageId: $0) }
    }

    /// The owner logged out, or the session is gone: the pictures go with it (client-contract「会話の画像」).
    private mutating func forgetImages() {
        state.images = ImageShelf()
        state.viewedImage = nil
    }

    /// Keeps the badge and the delivered notifications in step with what the owner has read and checked, whenever
    /// that changes while synced (ADR 0029).
    private mutating func tidyNotifications() -> [PhoneEffect] {
        guard state.session.phase == .ready else {
            state.lastTidy = nil
            return []
        }
        let tidy = PushTidy.synced(state.conversation, approvals: state.approvals)
        guard tidy != state.lastTidy else { return [] }
        state.lastTidy = tidy
        return [.tidyNotifications(tidy)]
    }

    /// Drops the connection and asks whether there is still a session to come back with.
    private mutating func resume() -> [PhoneEffect] {
        _ = state.session.stop()
        guard state.serverOrigin != nil else {
            state.status = .needsServer
            return [.disconnect]
        }
        return [.disconnect, .resumeSession]
    }

    /// Passes the session machine's effects on as the mediator's own, and reads the connection's state off it.
    private mutating func apply(_ effects: [SessionEffect]) -> [PhoneEffect] {
        var out: [PhoneEffect] = []
        for effect in effects {
            switch effect {
            case .connect: out.append(.connect)
            case .disconnect: out.append(.disconnect)
            case .send(let envelope): out.append(.sendToServer(envelope))
            case .saveDeviceId(let id): out.append(.saveDeviceId(id))
            case .extendSession(let expiresAt): out.append(.extendSession(until: expiresAt))
            case .requireLogin:
                state.hasSession = false
                forgetImages()
                out += [.disconnect, .clearSession]
            case .scheduleReconnect(let delay):
                out += [.disconnect, .scheduleReconnect(after: delay)]
            }
        }
        switch state.session.phase {
        case .idle: break
        case .connecting, .syncing: state.status = .connecting
        case .ready: state.status = .connected
        case .waitingToReconnect: state.status = .reconnecting
        case .unavailable(let code): state.status = .unavailable(code)
        case .loginRequired: state.status = .needsLogin
        case .replaced: state.status = .replaced
        case .stopped: state.status = .stopped
        }
        return out
    }
}
