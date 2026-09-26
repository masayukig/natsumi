import CoreGraphics
import Foundation

/// The state machine the whole UI is arbitrated by: `(State, Event) -> (State, [Effect])`.
///
/// It knows nothing of AppKit, SwiftUI, the network, the preferences or the Keychain. Every event, whether the
/// owner raised it in a component or an adapter reported it from outside, is settled here, and everything that has
/// to happen out in the world leaves as an effect for the root to run. The connection is not its concern: it hands
/// that to `SessionMachine` and passes the machine's effects on as its own.
public struct UIMediator {
    public private(set) var state: UIState
    private let makeRequestId: () -> String

    public init(makeRequestId: @escaping () -> String = { UUID().uuidString }) {
        self.makeRequestId = makeRequestId
        self.state = UIState(session: SessionMachine(deviceId: nil, makeRequestId: makeRequestId))
    }

    /// Whether the last event may have changed what the props are derived from. A row coming into or going out of
    /// sight changes only which rows are in sight, which nothing is drawn from, unless it reads a reply. While the
    /// history is scrolled that happens many times a second, and the root need not derive the props again for it.
    public private(set) var mayHaveChangedProps = true

    public mutating func handle(_ event: UIEvent) -> [UIEffect] {
        let conversation = state.conversation
        let wasConnected = state.status == .connected
        let effects = decide(event)
        // Coming back to the server is the time to try again for the pictures that could not be had.
        if state.status == .connected, !wasConnected { state.images.retryUnavailable() }
        settle()
        let all = effects + readSeenReplies() + fetchShownImages()
        if case .historyRowVisibilityChanged = event {
            mayHaveChangedProps = state.conversation != conversation
        } else {
            mayHaveChangedProps = true
        }
        return all
    }

    // MARK: - Deciding

    private mutating func decide(_ event: UIEvent) -> [UIEffect] {
        switch event {
        // MARK: The app and the world outside
        case .launched(let info):
            state.characterScale = info.characterScale
            state.columnWidth = info.columnWidth
            state.conversationWindow = info.conversationWindow
            state.hotKey = info.hotKey
            state.serverOrigin = info.serverOrigin
            state.avatarDirectory = info.avatarDirectory
            state.defaultAvatarDirectory = info.defaultAvatarDirectory
            return [.loadAvatar(directory: info.avatarDirectory)] + (info.hotKey.map { [.registerHotKey($0)] } ?? [])
                + resume()

        case .sessionResumed(let hasSession, let deviceId):
            state.hasSession = hasSession
            guard state.serverOrigin != nil else {
                state.status = .needsServer
                return []
            }
            guard hasSession else {
                state.status = .needsLogin
                return []
            }
            state.session = SessionMachine(deviceId: deviceId, makeRequestId: makeRequestId)
            return apply(state.session.start())

        case .credentialsMissing:
            _ = state.session.stop()
            state.hasSession = false
            state.status = .needsLogin
            return [.disconnect]

        case .avatarLoaded(let art, let description):
            state.avatar = art
            state.avatarDescription = description
            return []

        case .loginFinished(.succeeded):
            state.lastError = nil
            return resume()

        case .loginFinished(.cancelled):
            state.status = .needsLogin
            return []

        case .loginFinished(.failed(let message)):
            state.lastError = message
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

        case .systemWoke:
            // Whatever happened to the socket while the Mac slept, a new one catches up from where the stream was.
            return apply(state.session.reconnectNow())

        // MARK: The character and the panels
        case .characterClicked:
            return state.isConversationOpen ? closeConversation() : openConversation()

        case .talkRequested:
            return openConversation()

        case .hotKeyPressed:
            // Unlike her click, it never takes the window away: it brings it out and to the front, ready to type in,
            // from whatever app the owner is in.
            return state.isConversationOpen ? [.focusInput] : openConversation()

        case .hotKeyRegistrationFailed(let key):
            state.hotKeyMessage = "\(key.displayName) はほかのアプリが使っているため登録できませんでした"
            return []

        case .hotKeyRecordingRequested:
            state.isRecordingHotKey = true
            state.hotKeyMessage = nil
            return [.registerHotKey(nil)]

        case .hotKeyRecorded(let key):
            guard state.isRecordingHotKey else { return [] }
            guard key.isUsable else {
                state.hotKeyMessage = "⌘・⌃・⌥ のどれかと組み合わせてください"
                return []
            }
            return setHotKey(key)

        case .hotKeyRecordingCancelled:
            return stopRecordingHotKey()

        case .hotKeyCleared:
            return setHotKey(nil)

        case .hotKeyResetRequested:
            return setHotKey(.default)

        case .conversationCloseRequested:
            return closeConversation()

        case .historyOpenRequested, .historyLinkClicked:
            // The history is asked for by name: the window opens if it is not there, and unfolds if it is folded.
            let opened = openConversation()
            guard !state.conversationWindow.showsHistory else { return opened }
            return opened + toggleHistory()

        case .historyToggleRequested:
            guard state.isConversationOpen else { return [] }
            return toggleHistory()

        case .conversationFrameChanged(let frame, let visible):
            state.conversationVisible = visible
            let left = state.conversationWindow.left(at: frame)
            guard left != state.conversationWindow else { return [] }
            state.conversationWindow = left
            return [.saveConversationWindow(left)]

        case .conversationKeyChanged(let isKey):
            state.isConversationKey = isKey
            return []

        case .historyRowVisibilityChanged(let id, let isVisible):
            guard state.isConversationOpen, state.conversationWindow.showsHistory else { return [] }
            if isVisible {
                state.visibleHistoryIds.insert(id)
            } else {
                state.visibleHistoryIds.remove(id)
            }
            return []

        case .characterFrameChanged(let frame, let visible):
            let before = state.characterFrame
            state.characterFrame = frame
            state.visibleFrame = visible
            // A run of her own moves her frame step by step; where the pointer is watched settles when she arrives.
            guard state.isDragging else { return state.isMoving ? [] : watchPointer() }
            // The owner is carrying her: she runs the way she is being carried.
            state.facing = CharacterRun.facing(from: before.origin, to: frame.origin, keeping: state.facing)
            state.motion = .running(state.facing)
            return []

        case .characterDragBegan:
            guard !state.isDragging else { return [] }
            state.isDragging = true
            // The owner's hand wins over anything she was doing: wherever she was running to no longer matters, and
            // standing out of the pointer's way is over, because she is being put somewhere on purpose.
            state.isMoving = false
            state.dodgeHome = nil
            state.motion = .running(state.facing)
            return [.stopCharacterMove] + watchPointer()

        case .characterDragEnded:
            guard state.isDragging else { return [] }
            state.isDragging = false
            state.motion = .still
            // Wherever the owner let go of her is her place now.
            state.dodgeHome = nil
            return [.saveCharacterPlace] + watchPointer()

        case .characterMoveFinished:
            state.isMoving = false
            // A run the owner took over from ends without a word: she is in their hand now, still running.
            guard !state.isDragging else { return [] }
            state.motion = .still
            // Stepping aside is only for as long as the pointer is there, so it does not become her place.
            return (state.isSteppedAside ? [] : [.saveCharacterPlace]) + watchPointer()

        case .screenConfigurationChanged(let visible):
            state.visibleFrame = visible
            state.dodgeHome = nil
            let frame = OverlayLayout.clamp(state.characterFrame, into: visible)
            guard frame.origin != state.characterFrame.origin else { return watchPointer() }
            return run(to: frame.origin)

        case .pointerCameNear(let pointer):
            guard !state.isDragging, !state.isMoving, state.dodgeHome == nil else { return [] }
            guard let origin = PointerDodge.target(
                character: state.characterFrame, pointer: pointer, visible: state.visibleFrame)
            else { return [] }
            state.dodgeHome = state.characterFrame.origin
            return run(to: origin) + watchPointer()

        case .pointerWentAway:
            guard let home = state.dodgeHome else { return [] }
            state.dodgeHome = nil
            return run(to: home)

        case .badgeClicked:
            guard UIProps.noticeStack(state.conversation) != nil else { return [] }
            state.noticesHidden.toggle()
            return []

        case .settingsOpenRequested:
            state.isSettingsOpen = true
            // The routes come with the sync and every change after it; opening the settings looks at them afresh.
            return [.showSettings] + apply(state.session.listRoutes())

        case .modelRouteChosen(let name):
            return apply(state.session.chooseRoute(name))

        case .settingsCloseRequested:
            state.isSettingsOpen = false
            return stopRecordingHotKey() + [.hideSettings]

        case .quitRequested:
            return [.terminate]

        // MARK: The conversation
        case .inputSubmitted(let text):
            guard !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { return [] }
            return apply(state.session.send(text: text))

        case .outgoingDismissed(let requestId):
            state.session.dismiss(requestId: requestId)
            return []

        case .linkClicked(let url):
            // Following a link is not reading: the balloon and the notices stay as they are, and only the browser
            // opens. The views are given http and https links only; anything else is refused here too (ADR 0038).
            return TextLinks.canOpen(url) ? [.openLink(url)] : []

        case .imageClicked(let id):
            // Like a link, looking at a picture reads nothing. Only a picture that came can be opened.
            guard case .loaded = state.images[id] else { return [] }
            state.viewedImage = id
            return []

        case .imageViewerCloseRequested:
            state.viewedImage = nil
            return []

        case .imageFetched(let id, let fetch):
            state.images.receive(id, fetch)
            return []

        case .balloonTextClicked:
            // Opening a reply reads nothing: only the × tells the server anything.
            guard let last = UIProps.unreadReply(state.conversation) else { return [] }
            open(.reply(last.messageId))
            return []

        case .balloonCloseClicked:
            // On her last reply the × reads everything up to it, and a read reply is not shown (ADR 0022), even
            // while she is still thinking under it (ADR 0025). On the thought bubble there is nothing to read, so the
            // × only hides it, for the whole of the handling it belongs to (ADR 0017).
            if let last = UIProps.shownReply(state.conversation, readingHistory: state.isReadingHistory) {
                return apply(state.session.readReplies(through: last.messageId))
            }
            if UIProps.indicator(state.conversation) != nil { state.isIndicatorDismissed = true }
            return []

        case .readAllRepliesRequested:
            return apply(state.session.confirmAllReplies())

        case .noticeTextClicked:
            guard let stack = UIProps.noticeStack(state.conversation) else { return [] }
            switch stack.front {
            case .notice(let message):
                open(.notice(message.messageId))
                return []
            case .older(let ids):
                // The card has no text to open, so a click on it still checks the notices it stands for.
                return apply(state.session.acknowledge(ids))
            }

        case .noticeCloseClicked:
            guard let ids = UIProps.noticeStack(state.conversation)?.frontIds else { return [] }
            return apply(state.session.acknowledge(ids))

        case .acknowledgeAllNoticesRequested:
            return apply(state.session.acknowledgeAllNotices())

        // MARK: Login, logout and the server
        case .loginRequested:
            guard state.serverOrigin != nil else {
                state.status = .needsServer
                return []
            }
            state.status = .loggingIn
            return [.startLogin]

        case .logoutRequested:
            _ = state.session.stop()
            state.session = SessionMachine(deviceId: nil, makeRequestId: makeRequestId)
            state.hasSession = false
            forgetImages()
            state.status = state.serverOrigin == nil ? .needsServer : .needsLogin
            return [.disconnect, .logout]

        case .reconnectRequested:
            return resume()

        case .serverSubmitted(let text):
            do {
                let address = try ServerAddress(text)
                state.settingsMessage = "保存しました"
                guard address.origin.absoluteString != state.serverOrigin else { return [] }
                state.serverOrigin = address.origin.absoluteString
                state.session = SessionMachine(deviceId: nil, makeRequestId: makeRequestId)
                forgetImages()
                return [.saveServerAddress(address)] + resume()
            } catch ServerAddressError.insecure {
                state.settingsMessage = "http は localhost などのループバックだけで使えます。https の URL を入れてください"
            } catch {
                state.settingsMessage = "https://ホスト名[:ポート] の形で入れてください"
            }
            return []

        // MARK: The size of things and the avatar
        case .characterScaleChanged(let scale):
            guard scale != state.characterScale else { return [] }
            state.characterScale = scale
            return [.saveCharacterScale(scale)]

        case .avatarDirectorySubmitted(let path):
            let trimmed = path.trimmingCharacters(in: .whitespacesAndNewlines)
            let saved: String? = trimmed.isEmpty || trimmed == state.defaultAvatarDirectory ? nil : trimmed
            state.avatarDirectory = saved ?? state.defaultAvatarDirectory
            return [.saveAvatarDirectory(saved), .loadAvatar(directory: state.avatarDirectory)]

        case .avatarDirectoryResetRequested:
            state.avatarDirectory = state.defaultAvatarDirectory
            return [.saveAvatarDirectory(nil), .loadAvatar(directory: state.avatarDirectory)]
        }
    }

    // MARK: - The pieces the decisions are made of

    /// Sends her running to a place, facing the way she goes.
    private mutating func run(to origin: CGPoint) -> [UIEffect] {
        state.facing = CharacterRun.facing(from: state.characterFrame.origin, to: origin, keeping: state.facing)
        state.motion = .running(state.facing)
        state.isMoving = true
        return [.moveCharacter(to: origin)]
    }

    /// Asks for the pointer to be watched around the place she would come back to, and not at all while the owner
    /// is holding her. Watching where she comes back to, rather than where she stands, is what keeps her from
    /// setting off again the moment she lands.
    private mutating func watchPointer() -> [UIEffect] {
        var rect: CGRect?
        if !state.isDragging, !state.characterFrame.isEmpty {
            rect = CGRect(origin: state.dodgeHome ?? state.characterFrame.origin, size: state.characterFrame.size)
        }
        guard rect != state.watchedPointerRect else { return [] }
        state.watchedPointerRect = rect
        return [.watchPointer(near: rect)]
    }

    /// Opens a card to its whole text, or folds it when it is the one already open. Only one is open at a time.
    private mutating func open(_ card: ExpandedCard) {
        state.expanded = state.expanded == card ? nil : card
    }

    /// Takes a new shortcut, or none, in place of the one there was.
    private mutating func setHotKey(_ key: HotKey?) -> [UIEffect] {
        state.isRecordingHotKey = false
        state.hotKeyMessage = nil
        state.hotKey = key
        return [.saveHotKey(key), .registerHotKey(key)]
    }

    /// Gives up waiting for a new shortcut and puts the one there was back.
    private mutating func stopRecordingHotKey() -> [UIEffect] {
        guard state.isRecordingHotKey else { return [] }
        state.isRecordingHotKey = false
        state.hotKeyMessage = nil
        return state.hotKey.map { [.registerHotKey($0)] } ?? []
    }

    /// Drops the connection and asks whether there is still a session to come back with.
    private mutating func resume() -> [UIEffect] {
        _ = state.session.stop()
        guard state.serverOrigin != nil else {
            state.status = .needsServer
            return [.disconnect]
        }
        return [.disconnect, .resumeSession]
    }

    /// Opens the conversation window in the state it was left in. The first time, it opens right under her; after
    /// that it comes back to where it was, and she goes on as if it were any other window (ADR 0021).
    private mutating func openConversation() -> [UIEffect] {
        guard !state.isConversationOpen else { return [] }
        state.isConversationOpen = true
        guard state.conversationWindow.origin == nil else { return [.focusInput] }
        state.conversationWindow.origin = ConversationPlacement.first(
            under: state.characterFrame, size: state.conversationWindow.size,
            spacing: OverlayLayout.spacing(for: state.characterScale), visible: state.visibleFrame
        ).origin
        return [.focusInput, .saveConversationWindow(state.conversationWindow)]
    }

    private mutating func closeConversation() -> [UIEffect] {
        guard state.isConversationOpen else { return [] }
        state.isConversationOpen = false
        state.visibleHistoryIds = []
        return []
    }

    /// Unfolds the history above the input field, or folds it away, about the middle of where the window is. The
    /// visible area is the one of the screen the window was last seen on.
    private mutating func toggleHistory() -> [UIEffect] {
        state.conversationWindow = state.conversationWindow.togglingHistory(
            within: state.conversationVisible ?? state.visibleFrame)
        // The rows come back into sight one by one when it unfolds again.
        state.visibleHistoryIds = []
        return [.saveConversationWindow(state.conversationWindow)]
    }

    /// Reads the replies the owner has seen in the conversation window: its history is unfolded, the window is the
    /// key one, and the rows are in sight (ADR 0022). Asked after every event, since any of them can bring these
    /// together — the window becoming key, a row coming into sight, a reply arriving under the owner's eyes.
    private mutating func readSeenReplies() -> [UIEffect] {
        guard state.isReadingHistory, let id = HistoryReading.target(state.conversation, visible: state.visibleHistoryIds)
        else { return [] }
        return apply(state.session.readReplies(through: id))
    }

    /// Asks for the pictures the owner has in front of them and that are not here yet: those of the reply in the
    /// balloon, and those of the rows of the history in sight (ADR 0045). Asked after every event, like the reading.
    private mutating func fetchShownImages() -> [UIEffect] {
        guard state.hasSession else { return [] }
        let conversation = state.conversation
        var ids = UIProps.shownReply(conversation, readingHistory: state.isReadingHistory)?.images.map(\.imageId) ?? []
        if state.isConversationOpen, state.conversationWindow.showsHistory, !state.visibleHistoryIds.isEmpty {
            ids += conversation.messages.filter { state.visibleHistoryIds.contains($0.messageId) }
                .flatMap { $0.images.map(\.imageId) }
        }
        return state.images.request(ids).map { .fetchImage(imageId: $0) }
    }

    /// The owner logged out, or the session is gone: the pictures go with it (client-contract「会話の画像」).
    private mutating func forgetImages() {
        state.images = ImageShelf()
        state.viewedImage = nil
    }

    /// Passes the session machine's effects on as the mediator's own, and reads the connection's state off it.
    private mutating func apply(_ effects: [SessionEffect]) -> [UIEffect] {
        var out: [UIEffect] = []
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

    /// What the conversation now says about the bubble the owner closed and the bundle the badge hid.
    private mutating func settle() {
        // One handling is one thing she is saying: the bubble stays closed until she has nothing left to handle.
        if UIProps.indicator(state.conversation) == nil { state.isIndicatorDismissed = false }

        // A card that is no longer at the front folds by itself; what is open is always what is shown.
        switch state.expanded {
        case .reply(let id):
            if UIProps.unreadReply(state.conversation)?.messageId != id { state.expanded = nil }
        case .notice(let id):
            if case .notice(let front) = UIProps.noticeStack(state.conversation)?.front, front.messageId == id {
            } else {
                state.expanded = nil
            }
        case nil:
            break
        }

        // The large picture goes when the picture does.
        if state.viewedImage != nil, UIProps.viewer(state) == nil { state.viewedImage = nil }

        let ids = state.conversation.unacknowledgedNotificationIds
        if ids.contains(where: { !state.seenNoticeIds.contains($0) }) { state.noticesHidden = false }
        state.seenNoticeIds.formUnion(ids)
        if UIProps.noticeStack(state.conversation) == nil { state.noticesHidden = false }
    }
}
