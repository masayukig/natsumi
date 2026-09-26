import NatsumiCore
import SwiftUI
import UserNotifications

/// The root of the iPhone's tree, and the only thing outside it may hold (ADR 0028).
///
/// It owns the mediator, runs the effects the mediator asks for, and hands the screens their drawing parameters
/// through `ScreenModel`. Events from the owner arrive from the components below; events from the world outside
/// (the socket, the login, the Keychain, the avatar, the app coming and going) are raised here. Both go into the
/// same mediator.
@MainActor
final class PhoneRootComponent: PhoneComponent {
    let model = ScreenModel()
    private var mediator = PhoneMediator()
    private let account = AccountStore(secrets: KeychainSecretStore(), defaults: .standard)
    private let loginFlow = GitHubLoginFlow()

    private let login = LoginComponent()
    private let main = MainComponent()
    private let history = HistoryComponent()
    private let settings = SettingsComponent()
    private let approvals = ApprovalsComponent()
    private let approval = ApprovalComponent()
    private let viewer = ImageViewerComponent()

    private var pending: [PhoneEvent] = []
    private var draining = false
    private var socket: WebSocketClient?
    private var socketID: UUID?
    private var reconnectTask: Task<Void, Never>?
    /// The last tidying of the notifications, which a silent push waits for before iOS suspends the app again.
    private var tidyTask: Task<Void, Never>?
    private let pushKeys = PushKeyStore(accessGroup: PushKeyStore.sharedGroup())

    init() {
        super.init(name: "root")
        adopt(login)
        adopt(main)
        adopt(history)
        adopt(settings)
        adopt(approvals)
        adopt(approval)
        adopt(viewer)
        model.sinks = ScreenSinks(
            login: login.sink, main: main.sink, status: main.status.sink, header: main.header.sink,
            notices: main.notices.sink, balloon: main.balloon.sink, input: main.input.sink,
            failures: main.failures.sink, historyRows: history.rows.sink, historyInput: history.input.sink,
            historyOutgoing: history.outgoing.sink, settings: settings.buttons.sink, settingsRoutes: settings.routes.sink, approvalsEntry: main.approvals.sink,
            approvalRows: approvals.rows.sink, approval: approval.sink, approvalPlacement: approval.placement.sink,
            approvalActions: approval.actions.sink, approvalEditor: approval.editor.sink,
            historyImages: history.images.sink, approvalImages: approval.images.sink, viewer: viewer.sink)
    }

    /// Everything the tree is touched from outside with.
    override func handle(_ event: PhoneEvent) -> Bool {
        deliver(event)
        return true
    }

    func launch() {
        deliver(.launched(serverOrigin: account.serverAddress?.origin.absoluteString))
    }

    /// The app came to the front or went behind others. Inactive (the app switcher, a sheet) changes nothing.
    func scenePhaseChanged(_ phase: ScenePhase) {
        switch phase {
        case .active: deliver(.becameActive)
        case .background: deliver(.enteredBackground)
        default: break
        }
    }

    // MARK: - Notifications (ADR 0029)

    /// iOS gave a device token. With this iPhone's key it becomes the registration the server is sent.
    func deviceTokenReceived(_ token: Data) {
        guard let key = try? pushKeys.loadOrCreate() else { return }
        #if targetEnvironment(simulator)
        // The simulator has no profile; its tokens are the development APNs'.
        let environment = PushEnvironment.sandbox
        #else
        let profile = Bundle.main.url(forResource: "embedded", withExtension: "mobileprovision").flatMap { try? Data(contentsOf: $0) }
        let environment = PushEnvironment(provisioningProfile: profile)
        #endif
        deliver(.pushRegistrationReady(PushRegistration(deviceToken: token, publicKey: key.publicKey, environment: environment)))
    }

    /// A silent push arrived. It is done with once the notifications are tidied.
    func remoteNotificationReceived(_ userInfo: [AnyHashable: Any]) async -> Bool {
        if let push = BackgroundPush(userInfo: userInfo) {
            deliver(.backgroundPushReceived(push))
        } else if let push = ApprovalResolvedPush(userInfo: userInfo) {
            deliver(.approvalResolvedPushReceived(push))
        } else {
            return false
        }
        await tidyTask?.value
        return true
    }

    /// The owner tapped the alert of an approval.
    func approvalNotificationOpened(_ approvalId: String) {
        deliver(.approvalNotificationOpened(approvalId: approvalId))
    }

    private func registerForNotifications() {
        Task {
            _ = try? await UNUserNotificationCenter.current().requestAuthorization(options: [.alert, .badge, .sound])
            // A token is asked for even when alerts were refused: the badge and the tidying still use it.
            UIApplication.shared.registerForRemoteNotifications()
        }
    }

    private func tidy(_ tidy: PushTidy) {
        let previous = tidyTask
        tidyTask = Task {
            await previous?.value
            let center = UNUserNotificationCenter.current()
            let gone = await center.deliveredNotifications().filter { tidy.removes(userInfo: $0.request.content.userInfo) }
            center.removeDeliveredNotifications(withIdentifiers: gone.map(\.request.identifier))
            try? await center.setBadgeCount(tidy.badge)
        }
    }

    // MARK: - One event at a time

    /// Events are settled one by one. An effect may raise another event, so they queue up rather than nest, and the
    /// screen is drawn once at the end.
    private func deliver(_ event: PhoneEvent) {
        pending.append(event)
        guard !draining else { return }
        draining = true
        defer { draining = false }
        while !pending.isEmpty {
            for effect in mediator.handle(pending.removeFirst()) { perform(effect) }
        }
        refresh()
    }

    /// Derives the drawing parameters and hands them over only when they changed.
    private func refresh() {
        let props = PhoneProps.root(mediator.state, time: MessageTime(now: Date(), calendar: .current))
        if props != model.props { model.props = props }
    }

    // MARK: - Doing what the mediator asked for

    private func perform(_ effect: PhoneEffect) {
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
        case .saveServerAddress(let address):
            account.serverAddress = address
        case .logout:
            logout()
        case .registerForNotifications:
            registerForNotifications()
        case .tidyNotifications(let value):
            tidy(value)
        case .openLink(let url):
            UIApplication.shared.open(url)
        case .fetchImage(let id):
            fetchImage(id)
        case .loadAvatar:
            let bundled = Bundle.main.resourceURL?.appendingPathComponent("Avatars/natsumi", isDirectory: true)
            deliver(.avatarLoaded(AvatarLoader.resolve(candidates: bundled.map { [$0] } ?? [])))
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

    private func logout() {
        let token = account.session()?.token
        let server = account.serverAddress
        account.clearSession()
        guard let token, let server else { return }
        Task {
            _ = try? await URLSession.shared.data(for: AuthAPI.logoutRequest(server: server, token: token))
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
}

/// The ports the screens raise events through, one for each component that has something to raise.
struct ScreenSinks {
    var login: PhoneEventSink = .ignored
    var main: PhoneEventSink = .ignored
    var status: PhoneEventSink = .ignored
    var header: PhoneEventSink = .ignored
    var notices: PhoneEventSink = .ignored
    var balloon: PhoneEventSink = .ignored
    var input: PhoneEventSink = .ignored
    var failures: PhoneEventSink = .ignored
    var historyRows: PhoneEventSink = .ignored
    var historyInput: PhoneEventSink = .ignored
    var historyOutgoing: PhoneEventSink = .ignored
    var settings: PhoneEventSink = .ignored
    var settingsRoutes: PhoneEventSink = .ignored
    var approvalsEntry: PhoneEventSink = .ignored
    var approvalRows: PhoneEventSink = .ignored
    var approval: PhoneEventSink = .ignored
    var approvalPlacement: PhoneEventSink = .ignored
    var approvalActions: PhoneEventSink = .ignored
    var approvalEditor: PhoneEventSink = .ignored
    var historyImages: PhoneEventSink = .ignored
    var approvalImages: PhoneEventSink = .ignored
    var viewer: PhoneEventSink = .ignored
}

/// SwiftUI's window group cannot be handed a value the way a hosting view can, so it reads the props it was last
/// given here. This is a box for handing them over, not state.
@MainActor
@Observable
final class ScreenModel {
    var props = PhoneRootProps(screen: .login(PhoneLoginProps(
        greeting: "", serverOrigin: "", message: nil, isLoggingIn: false, buttonTitle: "GitHub でログイン",
        face: .happy, avatar: .placeholder)))
    @ObservationIgnored var sinks = ScreenSinks()
}
