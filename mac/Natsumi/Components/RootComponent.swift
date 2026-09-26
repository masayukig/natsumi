import AppKit
import NatsumiCore
import SwiftUI

/// The root of the tree, and the only thing outside it may hold.
///
/// It owns the mediator, runs the effects the mediator asks for, and lays the panels out. Events from the owner
/// arrive from the components below; events from the world outside (the socket, the login, the Keychain, the
/// avatar) are raised here. Both go into the same mediator, and what comes back is drawn and done.
///
/// The character and her two cards are drawn on the stage: one transparent panel the size of her screen, in which
/// they are views placed at the frames the layout gives them (ADR 0016). The conversation window and the settings
/// are windows of their own. The root decides how each drawing pass is shown — at once, as a card opening, or as a
/// run — and the stage's view animates it. The one window frame animated here is the conversation window's, when
/// its history unfolds or folds (ADR 0021).
@MainActor
final class RootComponent: Component {
    private var mediator = UIMediator()
    private let menuBar: MenuBarModel
    private let account = AccountStore(secrets: KeychainSecretStore(), defaults: .standard)
    private let overlaySettings = OverlaySettings(defaults: .standard)
    private let loginFlow = GitHubLoginFlow()
    private let hotKey = GlobalHotKey()

    private var character: CharacterComponent!
    private let balloon = BalloonComponent()
    private let notices = NoticeBundleComponent()
    private let conversation = ConversationComponent()
    private let settings = SettingsComponent()
    private let viewer = ImageViewerComponent()
    private let windows = PanelDelegate()

    typealias Stage = StageView<CharacterStageView, BalloonView, NoticeBundleView>
    /// The stage and its drawing. The stage covers the screen the character is on and never moves otherwise.
    private let stage = OverlayPanel.make()
    private var stageHosting: StageHostingView<Stage>!
    private var stageScreen: NSScreen?

    /// Where she stands, in screen coordinates. This is the one place it is kept: the mediator is told of every
    /// change, and the stage draws her here.
    private var characterFrame = CGRect.zero
    /// A run the mediator asked for, while it is under way: the stage animates her from `from` to `to`, and this
    /// is how far along she is when something interrupts it.
    private var run: (from: CGPoint, to: CGPoint, start: Date, duration: TimeInterval)?
    /// Which run is the current one. A run that was stopped part way must not report itself finished.
    private var runToken = 0
    /// Where she was taken hold of, while the owner is carrying her.
    private var dragOrigin: CGPoint?
    /// How the next drawing pass is shown, when something other than the usual rule has decided it.
    private var forcedTransition: StageTransition?
    /// The frame the conversation window was last asked to take, and whether it is on its way there. What the
    /// owner does to the window is told to the mediator; what the root does to it is not told back while it is
    /// happening.
    private var requestedConversationFrame: CGRect?
    private var conversationAnimating = false

    private var socket: WebSocketClient?
    private var socketID: UUID?
    private var reconnectTask: Task<Void, Never>?

    /// The pointer. The stage covers the screen, so where it takes the mouse is decided here: only over the
    /// character and her cards, and everywhere else the click goes through to whatever is underneath. The same
    /// watching serves stepping out of the pointer's way; the mediator hears only "the pointer settled by her" and
    /// "it has gone".
    private var pointerMonitor: Any?
    /// Where the stage takes the mouse, in screen coordinates: what is drawn there now, and for the length of a
    /// transition, where it was drawn before.
    private var solidRects: [CGRect] = []
    private var staleRects: [CGRect] = []
    private var staleTask: Task<Void, Never>?
    private var pointerAnchor: CGRect?
    private var pointerIsNear = false
    private var lastPointerSample = Date.distantPast
    private var pointerTask: Task<Void, Never>?

    private var pending: [UIEvent] = []
    private var draining = false
    private var placement = ColumnPlacement()
    /// What the column was last laid out from, and what came of it. A pass that changes none of this reuses the
    /// layout instead of measuring the cards again; a new line of thinking is the one thing that changes nothing
    /// here, because the thought bubble holds one line at its own width whatever it says (ADR 0017).
    private var laidOut: (inputs: LayoutInputs, layout: OverlayLayout, placement: ColumnPlacement)?
    private var appliedProps: RootProps?
    private var appliedStage: StageProps?
    /// The cards' frames on the screen, as last laid out, for telling a pointer on a card from one on its way past.
    private var cardRects: [CGRect] = []

    private static let avatarDirectoryKey = "avatarDirectory"
    private static let characterOriginKey = "natsumi.characterOrigin"
    /// Where an earlier version saved her window's frame.
    private static let legacyCharacterFrameKey = "NSWindow Frame natsumi.character"

    init(menuBar: MenuBarModel) {
        self.menuBar = menuBar
        super.init(name: "root")
        character = CharacterComponent(
            carried: { [weak self] phase in self?.carried(phase) },
            menu: { [weak self] in self?.contextMenu() })
        for child in [character as Component, balloon, notices, conversation, settings, viewer] { adopt(child) }

        stageHosting = StageHostingView(rootView: Stage(
            props: StageProps(
                size: .zero, character: UIProps.root(mediator.state, placement: placement, time: .current).character,
                characterFrame: .zero, balloon: nil, balloonFrame: nil, notices: nil, noticesFrame: nil,
                transition: .immediate),
            character: character.view(UIProps.root(mediator.state, placement: placement, time: .current).character),
            balloon: nil, notices: nil))
        stageHosting.onPointer = { [weak self] in self?.pointerMoved() }
        stage.contentView = stageHosting
        // Until the pointer is over something drawn on it, the stage is not there for the mouse.
        stage.ignoresMouseEvents = true

        menuBar.send = sink
        // The shortcut belongs to no panel: it is the world outside telling the root, like the socket does.
        hotKey.onPress = { [weak self] in self?.deliver(.hotKeyPressed) }
        conversation.panel.delegate = windows
        settings.panel.delegate = windows
        viewer.panel.delegate = windows
        windows.willClose = { [weak self] window in
            guard let self else { return }
            if window === self.conversation.panel { self.conversation.dispatch(.conversationCloseRequested) }
            if window === self.settings.panel { self.settings.dispatch(.settingsCloseRequested) }
            if window === self.viewer.panel { self.viewer.dispatch(.imageViewerCloseRequested) }
        }
        windows.didChangeKey = { [weak self] window, isKey in
            guard let self else { return }
            if window === self.conversation.panel { self.conversation.dispatch(.conversationKeyChanged(isKey)) }
            // Keys pressed elsewhere never reach the recorder, so leaving the settings stops recording.
            if window === self.settings.panel, !isKey { self.settings.dispatch(.hotKeyRecordingCancelled) }
        }
        windows.didMoveOrResize = { [weak self] window in
            guard let self, window === self.conversation.panel, !self.conversationAnimating else { return }
            self.reportConversationFrame()
        }
        NotificationCenter.default.addObserver(
            forName: NSApplication.didChangeScreenParametersNotification, object: nil, queue: .main
        ) { [weak self] _ in
            MainActor.assumeIsolated {
                guard let self else { return }
                self.placeStage()
                self.character.dispatch(.screenConfigurationChanged(visible: self.visibleFrame))
            }
        }
        // The socket may have died while the Mac slept, with no close ever arriving; the mediator starts it over.
        NSWorkspace.shared.notificationCenter.addObserver(
            forName: NSWorkspace.didWakeNotification, object: nil, queue: .main
        ) { [weak self] _ in
            MainActor.assumeIsolated { self?.deliver(.systemWoke) }
        }
    }

    /// Everything the tree is touched from outside with.
    override func handle(_ event: UIEvent) -> Bool {
        deliver(event)
        return true
    }

    func launch() {
        let size = overlaySettings.characterScale.artSize
        if let origin = savedCharacterOrigin() {
            characterFrame = CGRect(origin: origin, size: size)
        } else {
            let visible = NSScreen.main?.visibleFrame ?? .zero
            characterFrame = CGRect(x: visible.maxX - 160, y: visible.minY + 40, width: size.width, height: size.height)
        }
        placeStage()
        stage.orderFrontRegardless()
        watchPointer()
        deliver(.launched(LaunchInfo(
            characterScale: overlaySettings.characterScale, columnWidth: overlaySettings.columnWidth,
            conversationWindow: overlaySettings.conversationWindow, hotKey: overlaySettings.hotKey,
            serverOrigin: account.serverAddress?.origin.absoluteString, avatarDirectory: avatarDirectory,
            defaultAvatarDirectory: Self.defaultAvatarDirectory.path)))
        deliver(.characterFrameChanged(characterFrame, visible: visibleFrame))
    }

    /// The place she starts in: where she was last left, or where an earlier version left her.
    private func savedCharacterOrigin() -> CGPoint? {
        let defaults = UserDefaults.standard
        if let saved = defaults.array(forKey: Self.characterOriginKey) as? [Double], saved.count == 2 {
            return CGPoint(x: saved[0], y: saved[1])
        }
        return defaults.string(forKey: Self.legacyCharacterFrameKey).flatMap(CharacterPlace.legacyOrigin)
    }

    private func saveCharacterPlace() {
        UserDefaults.standard.set([characterFrame.origin.x, characterFrame.origin.y], forKey: Self.characterOriginKey)
    }

    // MARK: - One event at a time

    /// Events are settled one by one. An effect may raise another event, so they queue up rather than nest; the
    /// stage is drawn once at the end, and only then do the effects that need a panel on the screen run. Drawing
    /// may itself have something to report (her frame changed with her scale), which goes round once more.
    private func deliver(_ event: UIEvent) {
        pending.append(event)
        guard !draining else { return }
        draining = true
        defer { draining = false }
        repeat {
            var afterDrawing: [UIEffect] = []
            var mayHaveChangedProps = false
            while !pending.isEmpty {
                for effect in mediator.handle(pending.removeFirst()) {
                    switch effect {
                    case .focusInput, .showSettings: afterDrawing.append(effect)
                    default: perform(effect)
                    }
                }
                mayHaveChangedProps = mayHaveChangedProps || mediator.mayHaveChangedProps
            }
            // A row of the history coming into or going out of sight, many times a second while it is scrolled,
            // leaves the props as they are unless it reads a reply; deriving them for it is what made scrolling stutter.
            if mayHaveChangedProps { refresh() }
            for effect in afterDrawing { perform(effect) }
        } while !pending.isEmpty
    }

    // MARK: - Drawing and layout

    /// Derives the drawing parameters, lays the column out with the most of the stacks that fits, and hands the
    /// stage and every window its own parameters.
    private func refresh() {
        let state = mediator.state
        let scaleChanged = fitCharacter(state)
        let stageMoved = placeStage()
        placement.width = state.columnWidth
        // Measuring is what settles these, so they are not in play while it happens.
        placement.balloonHeight = nil
        placement.noticesHeight = nil
        var props = UIProps.root(state, placement: placement, time: .current)
        let inputs = LayoutInputs(props: props.withoutThinkingLine, character: characterFrame, visible: visibleFrame)
        let layout: OverlayLayout
        if let cached = laidOut, cached.inputs == inputs {
            layout = cached.layout
            placement = cached.placement
        } else {
            layout = OverlayLayout.fit(
                visible: visibleFrame, character: characterFrame,
                spacing: OverlayLayout.spacing(for: state.characterScale), steps: UIProps.budgetSteps(state)
            ) { budget in
                placement.budget = budget
                let stacked = UIProps.root(state, placement: placement, time: .current)
                // Each card is measured at its own width: an opened card is wider than the rest of the column.
                return (
                    notices: stacked.notices.map { fittingSize(of: notices.probe($0), width: $0.width) },
                    balloon: stacked.balloon.map { fittingSize(of: balloon.probe($0), width: $0.width) })
            }
            placement.budget = layout.budget
            placement.tail = layout.tail
            placement.tailX = layout.tailX
            placement.balloonHeight = layout.balloon?.height
            placement.noticesHeight = layout.notices?.height
            laidOut = (inputs, layout, placement)
        }
        props = UIProps.root(state, placement: placement, time: .current)

        // How this pass is shown. The owner's hand, a new scale, a moved stage and the first drawing are not to be
        // seen happening; a run is seen over its own time; everything else is a card opening or the column settling.
        let transition: StageTransition
        if let forced = forcedTransition {
            transition = forced
        } else if dragOrigin != nil || scaleChanged || stageMoved || appliedStage == nil {
            transition = .immediate
        } else if let run {
            transition = .run(max(run.duration - Date().timeIntervalSince(run.start), 0.05))
        } else {
            transition = .card
        }
        forcedTransition = nil

        let wasUnfolded = appliedProps?.conversation?.history != nil
        render(props, layout: layout, transition: transition)
        cardRects = [layout.balloon, layout.notices].compactMap { $0 }
        placeConversation(props.conversation, unfolding: (props.conversation?.history != nil) != wasUnfolded)
    }

    /// Hands the stage and every window their drawing parameters, when they are not the ones they already have.
    private func render(_ props: RootProps, layout: OverlayLayout, transition: StageTransition) {
        let stageProps = StageProps.make(
            root: props, character: characterFrame, layout: layout, stage: stage.frame, transition: transition)
        if stageProps != appliedStage {
            let before = appliedStage
            appliedStage = stageProps
            stageHosting.rootView = Stage(
                props: stageProps, character: character.view(props.character),
                balloon: props.balloon.map(balloon.view), notices: props.notices.map(notices.view))
            takeMouse(
                over: [characterFrame] + [layout.balloon, layout.notices].compactMap { $0 },
                leaving: before.map { [$0.characterFrame, $0.balloonFrame, $0.noticesFrame].compactMap { $0 } } ?? [],
                stageFrame: stage.frame, transition: transition)
        }
        guard props != appliedProps else { return }
        appliedProps = props
        conversation.render(props.conversation)
        settings.render(props.settings)
        viewer.render(props.viewer, visible: visibleFrame)
        menuBar.props = props.menu
    }

    /// Where the stage takes the mouse from now on: over what is drawn, and, while a transition is under way, over
    /// where it was drawn (a run is covered by the box round both ends of it, which the way between lies in).
    private func takeMouse(
        over rects: [CGRect], leaving before: [CGRect], stageFrame: CGRect, transition: StageTransition
    ) {
        solidRects = rects
        staleTask?.cancel()
        let duration: TimeInterval
        switch transition {
        case .immediate: duration = 0
        case .card: duration = CardAnimation.duration
        case .run(let time): duration = time
        }
        guard duration > 0, !before.isEmpty else {
            staleRects = []
            return
        }
        // `before` is in the stage's coordinates; back to the screen's.
        let previous = before.map {
            CGRect(x: stageFrame.minX + $0.minX, y: stageFrame.maxY - $0.maxY, width: $0.width, height: $0.height)
        }
        staleRects = previous
        if case .run = transition, let first = previous.first {
            staleRects[0] = first.union(characterFrame)
        }
        staleTask = Task { [weak self] in
            try? await Task.sleep(for: .seconds(duration))
            guard !Task.isCancelled else { return }
            self?.staleRects = []
        }
    }

    /// The stage covers the screen she is on. It moves only when she is carried to another screen or the screens
    /// change; nothing drawn on it moves with it, because everything is placed in screen coordinates and put back
    /// at once.
    @discardableResult
    private func placeStage() -> Bool {
        let center = CGPoint(x: characterFrame.midX, y: characterFrame.midY)
        guard let screen = NSScreen.screens.first(where: { $0.frame.contains(center) }) ?? stageScreen ?? NSScreen.main
        else { return false }
        stageScreen = screen
        guard stage.frame != screen.frame else { return false }
        stage.setFrame(screen.frame, display: true)
        return true
    }

    private var visibleFrame: CGRect {
        stageScreen?.visibleFrame ?? characterFrame
    }

    /// Sizes the character to the scale. Only a new size moves her (keeping her feet in place); showing or hiding
    /// panels never does. Returns whether she changed.
    private func fitCharacter(_ state: UIState) -> Bool {
        let frame = OverlayLayout.characterFrame(characterFrame, art: state.characterScale.artSize, visible: visibleFrame)
        guard frame != characterFrame else { return false }
        characterFrame = frame
        if !state.isSteppedAside { saveCharacterPlace() }
        pending.append(.characterFrameChanged(frame, visible: visibleFrame))
        return true
    }

    /// The owner carrying her. Her event has already been raised by her component; this is the moving.
    private func carried(_ phase: CharacterDrag) {
        switch phase {
        case .began:
            // Any run she was in was stopped by the event; she is taken hold of where she is now.
            dragOrigin = characterFrame.origin
        case .moved(let offset):
            guard let dragOrigin else { return }
            characterFrame.origin = CGPoint(x: dragOrigin.x + offset.width, y: dragOrigin.y + offset.height)
            placeStage()
            deliver(.characterFrameChanged(characterFrame, visible: visibleFrame))
        case .ended:
            dragOrigin = nil
        }
    }

    /// Runs her to a place the mediator chose. The stage animates her there over the run's time, and the column
    /// goes with her over the same time.
    private func runCharacter(to origin: CGPoint) {
        let from = characterFrame.origin
        guard origin != from else {
            deliver(.characterMoveFinished)
            return
        }
        let duration = CharacterRun.duration(from: from, to: origin)
        runToken += 1
        let token = runToken
        run = (from, origin, Date(), duration)
        characterFrame.origin = origin
        Task { [weak self] in
            try? await Task.sleep(for: .seconds(duration))
            guard let self, self.runToken == token else { return }
            self.run = nil
            self.deliver(.characterFrameChanged(self.characterFrame, visible: self.visibleFrame))
            self.deliver(.characterMoveFinished)
        }
    }

    /// Stops a run part way and leaves her exactly where it got to: where the stage has drawn her at this moment,
    /// worked out from the same curve it animates with. The next drawing pass shows her there at once.
    private func stopRunningCharacter() {
        guard let run else { return }
        runToken += 1
        self.run = nil
        characterFrame.origin = CharacterRun.place(
            from: run.from, to: run.to, duration: run.duration, elapsed: Date().timeIntervalSince(run.start))
        forcedTransition = .immediate
    }

    /// The conversation window is not on the stage and not a child window: a titled window kept on the screen by
    /// AppKit would otherwise pull the stage along with it. Its frame is the mediator's; the owner's moving and
    /// resizing come back to the mediator as events. Unfolding and folding the history are the one place a window's
    /// frame is animated (ADR 0021): the window is alone, and nothing beside it has to keep up.
    private func placeConversation(_ props: ConversationProps?, unfolding: Bool) {
        let panel = conversation.panel
        guard let props else {
            if panel.isVisible { panel.orderOut(nil) }
            requestedConversationFrame = nil
            return
        }
        if props.frame != requestedConversationFrame, props.frame != panel.frame {
            requestedConversationFrame = props.frame
            if unfolding, panel.isVisible {
                conversationAnimating = true
                NSAnimationContext.runAnimationGroup { context in
                    context.duration = CardAnimation.duration
                    context.timingFunction = CAMediaTimingFunction(name: .easeInEaseOut)
                    panel.animator().setFrame(props.frame, display: true)
                } completionHandler: { [weak self] in
                    MainActor.assumeIsolated {
                        guard let self else { return }
                        self.conversationAnimating = false
                        // The screen may have given it less than was asked for.
                        self.reportConversationFrame()
                    }
                }
            } else {
                panel.setFrame(props.frame, display: true)
            }
        }
        if !panel.isVisible { panel.orderFront(nil) }
    }

    /// Where the conversation window is and which screen it is on, for the mediator to remember.
    private func reportConversationFrame() {
        let panel = conversation.panel
        guard panel.isVisible else { return }
        deliver(.conversationFrameChanged(panel.frame, visible: panel.screen?.visibleFrame ?? visibleFrame))
    }

    private func fittingSize<V: View>(of view: V, width: CGFloat) -> CGSize {
        let size = NSHostingController(rootView: view).sizeThatFits(in: CGSize(width: width, height: 10_000))
        return CGSize(width: ceil(size.width), height: ceil(size.height))
    }

    /// The menu on a right click (or control-click) on the character. It belongs to her, so its events are raised
    /// there.
    private func contextMenu() -> NSMenu {
        let props = menuBar.props
        let menu = NSMenu()
        menu.addItem(item("話しかける", .talkRequested))
        menu.addItem(item("履歴を開く", .historyOpenRequested))
        menu.addItem(.separator())
        let readAll = item("返事をすべて既読にする", .readAllRepliesRequested)
        readAll.isEnabled = props.canReadAllReplies
        menu.addItem(readAll)
        let checkAll = item("知らせをすべて確認する", .acknowledgeAllNoticesRequested)
        checkAll.isEnabled = props.canAcknowledgeAllNotices
        menu.addItem(checkAll)
        menu.addItem(.separator())
        menu.addItem(routesItem(props.modelRoutes))
        menu.addItem(.separator())
        if props.showsLogin { menu.addItem(item("GitHub でログイン", .loginRequested)) }
        menu.addItem(item("設定…", .settingsOpenRequested))
        let logout = item("ログアウト", .logoutRequested)
        logout.isEnabled = props.canLogout
        menu.addItem(logout)
        menu.addItem(.separator())
        menu.addItem(item("終了", .quitRequested))
        menu.autoenablesItems = false
        return menu
    }

    /// The model routes as a submenu, the same as the menu bar's (ADR 0046).
    private func routesItem(_ routes: ModelRoutesProps) -> NSMenuItem {
        let parent = NSMenuItem(title: routes.menuTitle, action: nil, keyEquivalent: "")
        let submenu = NSMenu()
        for row in routes.rows {
            let choose = item(([row.name] + row.tags).joined(separator: " · "), .modelRouteChosen(row.name))
            choose.state = row.isChosen ? .on : .off
            choose.isEnabled = row.isEnabled
            submenu.addItem(choose)
        }
        for line in [routes.pending, routes.message].compactMap({ $0 }) {
            let note = NSMenuItem(title: line, action: nil, keyEquivalent: "")
            note.isEnabled = false
            submenu.addItem(note)
        }
        submenu.autoenablesItems = false
        parent.submenu = submenu
        return parent
    }

    private func item(_ title: String, _ event: UIEvent) -> ActionMenuItem {
        ActionMenuItem(title) { [weak self] in self?.character.dispatch(event) }
    }

    // MARK: - Doing what the mediator asked for

    private func perform(_ effect: UIEffect) {
        switch effect {
        case .connect:
            connect()
        case .disconnect:
            reconnectTask?.cancel()
            reconnectTask = nil
            closeSocket()
        case .sendToServer(let envelope):
            if let data = try? envelope.encoded(), let text = String(data: data, encoding: .utf8) { socket?.send(text) }
        case .saveDeviceId(let id):
            account.deviceId = id
        case .extendSession(let expiresAt):
            account.extendSession(until: expiresAt)
        case .clearSession:
            account.clearSession()
        case .scheduleReconnect(let delay):
            reconnectTask = Task { [weak self] in
                try? await Task.sleep(for: .seconds(delay))
                guard !Task.isCancelled else { return }
                self?.deliver(.reconnectTimerFired)
            }
        case .resumeSession:
            deliver(.sessionResumed(hasSession: account.session() != nil, deviceId: account.deviceId))
        case .startLogin:
            startLogin()
        case .logout:
            logout()
        case .saveServerAddress(let address):
            account.serverAddress = address
        case .saveCharacterScale(let scale):
            overlaySettings.characterScale = scale
        case .saveConversationWindow(let window):
            overlaySettings.conversationWindow = window
        case .saveHotKey(let key):
            overlaySettings.hotKey = key
        case .registerHotKey(let key):
            if !hotKey.register(key), let key { deliver(.hotKeyRegistrationFailed(key)) }
        case .saveAvatarDirectory(let path):
            if let path {
                UserDefaults.standard.set(path, forKey: Self.avatarDirectoryKey)
            } else {
                UserDefaults.standard.removeObject(forKey: Self.avatarDirectoryKey)
            }
        case .loadAvatar(let directory):
            loadAvatar(directory)
        case .focusInput:
            conversation.focus()
        case .moveCharacter(let origin):
            runCharacter(to: origin)
        case .stopCharacterMove:
            stopRunningCharacter()
        case .saveCharacterPlace:
            saveCharacterPlace()
        case .watchPointer(let anchor):
            watchPointer(near: anchor)
        case .showSettings:
            showSettings()
        case .hideSettings:
            settings.panel.orderOut(nil)
        case .openLink(let url):
            NSWorkspace.shared.open(url)
        case .fetchImage(let id):
            fetchImage(id)
        case .terminate:
            NSApp.terminate(nil)
        }
    }

    private func closeSocket() {
        socket?.close()
        socket = nil
        socketID = nil
    }

    private func connect() {
        closeSocket()
        guard let server = account.serverAddress, let grant = account.session() else {
            deliver(.credentialsMissing)
            return
        }
        let id = UUID()
        socketID = id
        socket = WebSocketClient(request: AuthAPI.webSocketRequest(server: server, token: grant.token)) { [weak self] event in
            // Events of a socket that was already replaced are dropped.
            guard let self, self.socketID == id else { return }
            switch event {
            case .opened:
                self.deliver(.socketOpened)
            case .message(let data):
                self.deliver(.socketReceived(data))
            case .closed(let reason):
                self.socket = nil
                self.socketID = nil
                self.deliver(.socketClosed(reason))
            }
        }
    }

    /// Fetches a picture with the session and hands what came of it back. Without a session there is nothing to
    /// fetch it with, for now.
    private func fetchImage(_ id: String) {
        guard let server = account.serverAddress, let token = account.session()?.token else {
            deliver(.imageFetched(imageId: id, .unavailable))
            return
        }
        let request = ImageAPI.request(server: server, token: token, imageId: id)
        Task { [weak self] in
            let fetch = await ImageFetcher.fetch(request, imageId: id)
            self?.deliver(.imageFetched(imageId: id, fetch))
        }
    }

    private func startLogin() {
        guard let server = account.serverAddress else { return }
        Task { [weak self] in
            guard let self else { return }
            do {
                let grant = try await self.loginFlow.run(server: server)
                try self.account.saveSession(grant)
                self.deliver(.loginFinished(.succeeded))
            } catch LoginError.cancelled {
                self.deliver(.loginFinished(.cancelled))
            } catch {
                self.deliver(.loginFinished(.failed(GitHubLoginFlow.describe(error))))
            }
        }
    }

    private func logout() {
        let token = account.session()?.token
        let server = account.serverAddress
        account.clearSession()
        guard let token, let server else { return }
        Task {
            _ = try? await URLSession.shared.data(for: AuthAPI.logoutRequest(server: server, token: token))
        }
    }

    // MARK: - The pointer

    /// Watches the pointer for as long as the app runs. A global monitor sees it everywhere but inside this app's
    /// own windows, and the stage is one of those whenever it is taking the mouse; the stage's own tracking area
    /// sees it there. Between them every move is seen once.
    private func watchPointer() {
        guard pointerMonitor == nil else { return }
        pointerMonitor = NSEvent.addGlobalMonitorForEvents(matching: [.mouseMoved]) { [weak self] _ in
            MainActor.assumeIsolated { self?.pointerMoved() }
        }
    }

    /// Where the pointer is watched around for stepping aside: usually where the character stands, and, while she
    /// is standing out of its way, the place she will come back to. nil while she is not to step aside at all.
    private func watchPointer(near anchor: CGRect?) {
        pointerAnchor = anchor
        pointerTask?.cancel()
        pointerTask = nil
        pointerIsNear = false
    }

    private func pointerMoved() {
        let pointer = NSEvent.mouseLocation
        // Whether the stage takes the mouse is settled on every move: a click has to land right after the pointer
        // arrives over her.
        let overSomething = (solidRects + staleRects).contains { $0.contains(pointer) }
        if stage.ignoresMouseEvents == overSomething { stage.ignoresMouseEvents = !overSomething }

        // Stepping aside is looked at less often; mouse moves arrive far faster than it needs.
        guard let anchor = pointerAnchor else { return }
        let now = Date()
        guard now.timeIntervalSince(lastPointerSample) >= PointerDodge.sampleInterval else { return }
        lastPointerSample = now
        let scale = mediator.state.characterScale.textScale
        // The cards are there to be clicked: a pointer on one of them is not on its way past her.
        let onAPanel = cardRects.contains { $0.contains(pointer) }
        if !pointerIsNear, !onAPanel, PointerDodge.isNear(pointer, of: anchor, textScale: scale) {
            pointerIsNear = true
            waitThen(PointerDodge.linger) { [weak self] in
                guard let self, let anchor = self.pointerAnchor else { return }
                let now = NSEvent.mouseLocation
                guard PointerDodge.isNear(now, of: anchor, textScale: scale) else { return }
                self.deliver(.pointerCameNear(at: now))
            }
        } else if pointerIsNear, PointerDodge.isAway(pointer, of: anchor, textScale: scale) {
            pointerIsNear = false
            waitThen(PointerDodge.settle) { [weak self] in
                guard let self, let anchor = self.pointerAnchor,
                      PointerDodge.isAway(NSEvent.mouseLocation, of: anchor, textScale: scale)
                else { return }
                self.deliver(.pointerWentAway)
            }
        }
    }

    /// The one wait the pointer has going at a time: a new one replaces the one before, so a pointer that passes by
    /// never sets her off.
    private func waitThen(_ delay: TimeInterval, _ body: @escaping @MainActor () -> Void) {
        pointerTask?.cancel()
        pointerTask = Task { [weak self] in
            try? await Task.sleep(for: .seconds(delay))
            guard !Task.isCancelled, self != nil else { return }
            body()
        }
    }

    /// The settings open in the same layer, centered on the character's screen.
    private func showSettings() {
        let visible = visibleFrame
        let size = settings.panel.frame.size
        settings.panel.setFrameOrigin(NSPoint(x: visible.midX - size.width / 2, y: visible.midY - size.height / 2))
        settings.panel.makeKeyAndOrderFront(nil)
    }

    // MARK: - The avatar and the settings on this Mac

    private var avatarDirectory: String {
        UserDefaults.standard.string(forKey: Self.avatarDirectoryKey) ?? Self.defaultAvatarDirectory.path
    }

    static var defaultAvatarDirectory: URL {
        FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
            .appendingPathComponent("natsumi/avatar", isDirectory: true)
    }

    /// The owner's own avatar directory wins over the bundled one; the placeholder is the last resort.
    private func loadAvatar(_ directory: String) {
        let external = URL(fileURLWithPath: (directory as NSString).expandingTildeInPath, isDirectory: true)
        let bundled = Bundle.main.resourceURL?.appendingPathComponent("Avatars/natsumi", isDirectory: true)
        let art = AvatarLoader.resolve(candidates: [external] + (bundled.map { [$0] } ?? []))
        let description = switch art {
        case .sprite(let asset) where asset.directory.path.hasPrefix(Bundle.main.bundlePath):
            "同梱のアバターを使っています"
        case .sprite(let asset):
            "\(asset.directory.path) のアバターを使っています"
        case .placeholder:
            "アバターを読み込めないため、仮の絵を使っています"
        }
        deliver(.avatarLoaded(art, description: description))
    }
}

/// Everything the column is laid out from. What is equal here lays out the same way, so the work is not repeated.
struct LayoutInputs: Equatable {
    var props: RootProps
    var character: CGRect
    var visible: CGRect
}

/// The window callbacks the root needs. `Component` is not an `NSObject`, so the windows report here.
@MainActor
final class PanelDelegate: NSObject, NSWindowDelegate {
    var willClose: (NSWindow) -> Void = { _ in }
    var didMoveOrResize: (NSWindow) -> Void = { _ in }
    var didChangeKey: (NSWindow, Bool) -> Void = { _, _ in }

    func windowShouldClose(_ sender: NSWindow) -> Bool {
        willClose(sender)
        return false
    }

    func windowDidMove(_ notification: Notification) {
        if let window = notification.object as? NSWindow { didMoveOrResize(window) }
    }

    func windowDidResize(_ notification: Notification) {
        if let window = notification.object as? NSWindow { didMoveOrResize(window) }
    }

    func windowDidBecomeKey(_ notification: Notification) {
        if let window = notification.object as? NSWindow { didChangeKey(window, true) }
    }

    func windowDidResignKey(_ notification: Notification) {
        if let window = notification.object as? NSWindow { didChangeKey(window, false) }
    }
}

private extension MessageTime {
    /// The clock and the owner's calendar, read by Root when it draws. The core only takes them as given.
    static var current: MessageTime { MessageTime(now: Date(), calendar: .current) }
}
