import CoreGraphics
import Foundation
import Testing
@testable import NatsumiCore

private let server = "https://natsumi.example.net"
private let version1 = "0123456789abcdef0123456789abcdef"
private let version2 = "fedcba9876543210fedcba9876543210"

/// A copy of a made-up avatar, without its art: what the mediators decide on is its version and its name.
private func copy(version: String = version1, name: String = "ハナ") -> ReceivedAvatar {
    ReceivedAvatar(art: .placeholder, id: "hana", name: name, version: version)
}

private func unavailable(seq: Int, requestId: String, avatarVersion: String) -> Data {
    Fixture.envelope("service.unavailable", seq: seq, requestId: requestId, payload: [
        "code": "pi-unavailable", "deviceId": "device-1", "avatarVersion": avatarVersion,
    ])
}

@Suite("アバターの版: snapshot と service.unavailable")
struct AvatarVersionTests {
    private func syncing() -> SessionMachine {
        var machine = SessionMachine(deviceId: nil) { "r1" }
        _ = machine.start()
        _ = machine.connected()
        return machine
    }

    @Test("snapshot と service.unavailable の avatarVersion を読む。無ければ nil")
    func decodes() {
        #expect(Fixture.decoded(Fixture.snapshot(seq: 1, avatarVersion: version1)).avatarVersion == version1)
        #expect(Fixture.decoded(unavailable(seq: 1, requestId: "r1", avatarVersion: version2)).avatarVersion == version2)
        #expect(Fixture.decoded(Fixture.snapshot(seq: 1)).avatarVersion == nil)
    }

    @Test("同期の答えの版を知らせる")
    func reportsTheVersionOfTheSync() {
        var snapshot = syncing()
        #expect(snapshot.received(Fixture.snapshot(seq: 1, requestId: "r1", avatarVersion: version1))
            .contains(.avatarVersion(version1)))
        var down = syncing()
        #expect(down.received(unavailable(seq: 1, requestId: "r1", avatarVersion: version2)).contains(.avatarVersion(version2)))
    }

    @Test("版を知らせない古いサーバーでは、何も知らせない")
    func oldServer() {
        var machine = syncing()
        let effects = machine.received(Fixture.snapshot(seq: 1, requestId: "r1"))
        #expect(!effects.contains { if case .avatarVersion = $0 { true } else { false } })
    }
}

@Suite("Mac: アバターを受け取って控え、控えが無ければ設定から始める")
struct MacAvatarFlowTests {
    private func mediator() -> UIMediator {
        var counter = 0
        return UIMediator {
            counter += 1
            return "r\(counter)"
        }
    }

    private func launch(_ mediator: inout UIMediator, server: String? = server) -> [UIEffect] {
        mediator.handle(.launched(LaunchInfo(characterScale: .default, serverOrigin: server)))
    }

    /// Launched with a copy of `version1` and a live session.
    private func started(copy saved: ReceivedAvatar? = copy()) -> UIMediator {
        var mediator = mediator()
        _ = launch(&mediator)
        _ = mediator.handle(.avatarLoaded(saved))
        _ = mediator.handle(.avatarListingFetched(origin: server, Fixture.avatarListing(version: saved?.version ?? version1)))
        _ = mediator.handle(.sessionResumed(hasSession: true, deviceId: nil))
        return mediator
    }

    private func props(_ mediator: UIMediator) -> RootProps {
        UIProps.root(mediator.state, placement: ColumnPlacement(), time: .example)
    }

    private func fetches(_ effects: [UIEffect]) -> [UIEffect] {
        effects.filter {
            switch $0 {
            case .fetchAvatarListing, .receiveAvatar: true
            default: false
            }
        }
    }

    @Test("起動したら控えを読み、サーバーがあればその一覧を取りに行く")
    func launchLoadsAndChecks() {
        var mediator = mediator()
        let effects = launch(&mediator)
        #expect(effects.first == .loadAvatar)
        #expect(fetches(effects) == [.fetchAvatarListing(origin: server)])
    }

    @Test("サーバーが無ければ、一覧は取りに行かない")
    func noServerNoListing() {
        var mediator = mediator()
        let effects = launch(&mediator, server: nil)
        #expect(effects.contains(.loadAvatar))
        #expect(fetches(effects).isEmpty)
    }

    @Test("控えが無ければ、キャラを出さずに設定を開く")
    func noCopyOpensTheSettings() {
        var mediator = mediator()
        _ = launch(&mediator, server: nil)
        let effects = mediator.handle(.avatarLoaded(nil))
        #expect(effects.contains(.showSettings))
        #expect(props(mediator).isSettingsOpen)
        #expect(!props(mediator).showsCharacter)
        #expect(props(mediator).settings.avatarDescription == "アバターはまだ受け取っていません。サーバーを設定すると受け取ります")
    }

    @Test("控えがあれば、それでキャラを出す。設定は開かない")
    func copyShowsTheCharacter() {
        var mediator = mediator()
        _ = launch(&mediator)
        let effects = mediator.handle(.avatarLoaded(copy()))
        #expect(!effects.contains(.showSettings))
        #expect(props(mediator).showsCharacter)
        #expect(!props(mediator).isSettingsOpen)
        #expect(props(mediator).settings.avatarDescription == "ハナのアバターをサーバーから受け取っています（版 01234567）")
    }

    @Test("一覧の版が控えと同じなら取らない。違えば全ファイルを取りに行く")
    func comparesTheVersion() {
        var same = mediator()
        _ = launch(&same)
        _ = same.handle(.avatarLoaded(copy()))
        #expect(fetches(same.handle(.avatarListingFetched(origin: server, Fixture.avatarListing(version: version1))))
            .isEmpty)

        var other = mediator()
        _ = launch(&other)
        _ = other.handle(.avatarLoaded(copy()))
        let listing = Fixture.avatarListing(version: version2)
        #expect(fetches(other.handle(.avatarListingFetched(origin: server, listing)))
            == [.receiveAvatar(origin: server, listing)])
    }

    @Test("受け取ったら差し替えて、キャラを出す")
    func receivedShowsTheCharacter() {
        var mediator = mediator()
        _ = launch(&mediator)
        _ = mediator.handle(.avatarLoaded(nil))
        let listing = Fixture.avatarListing(version: version2)
        _ = mediator.handle(.avatarListingFetched(origin: server, listing))
        #expect(!props(mediator).showsCharacter)
        _ = mediator.handle(.avatarReceived(copy(version: version2)))
        #expect(props(mediator).showsCharacter)
        #expect(mediator.state.avatars.received?.version == version2)
    }

    @Test("一覧が取れない・受け取れないときは、控えのまま。設定にそう出す")
    func failureKeepsTheCopy() {
        var mediator = mediator()
        _ = launch(&mediator)
        _ = mediator.handle(.avatarLoaded(copy()))
        _ = mediator.handle(.avatarListingFetched(origin: server, nil))
        #expect(mediator.state.avatars.received == copy())
        #expect(props(mediator).settings.avatarDescription
            == "ハナのアバターをサーバーから受け取っています（版 01234567）。新しい版を受け取れませんでした")

        var none = self.mediator()
        _ = launch(&none)
        _ = none.handle(.avatarLoaded(nil))
        _ = none.handle(.avatarListingFetched(origin: server, Fixture.avatarListing()))
        _ = none.handle(.avatarReceived(nil))
        #expect(!props(none).showsCharacter)
        #expect(props(none).settings.avatarDescription == "アバターを受け取れませんでした。サーバーを確かめてください")
    }

    @Test("サーバーを保存したら、ログインの前にそのサーバーの一覧を取る")
    func serverSubmittedChecksAtOnce() {
        var mediator = mediator()
        _ = launch(&mediator, server: nil)
        _ = mediator.handle(.avatarLoaded(nil))
        let effects = mediator.handle(.serverSubmitted("https://other.example.net"))
        #expect(fetches(effects) == [.fetchAvatarListing(origin: "https://other.example.net")])
    }

    @Test("snapshot の avatarVersion が控えと違うときだけ取り直す")
    func snapshotVersion() {
        var same = started()
        _ = same.handle(.socketOpened)
        #expect(fetches(same.handle(.socketReceived(Fixture.snapshot(seq: 1, requestId: "r1", avatarVersion: version1))))
            .isEmpty)

        var other = started()
        _ = other.handle(.socketOpened)
        #expect(fetches(other.handle(.socketReceived(Fixture.snapshot(seq: 1, requestId: "r1", avatarVersion: version2))))
            == [.fetchAvatarListing(origin: server)])
    }

    @Test("会話が使えないときの service.unavailable の avatarVersion でも取り直す")
    func unavailableVersion() {
        var mediator = started()
        _ = mediator.handle(.socketOpened)
        #expect(fetches(mediator.handle(.socketReceived(unavailable(seq: 1, requestId: "r1", avatarVersion: version2))))
            == [.fetchAvatarListing(origin: server)])
    }

    @Test("取りに行っている間は、重ねて取りに行かない")
    func oneAtATime() {
        var mediator = mediator()
        _ = launch(&mediator)
        _ = mediator.handle(.avatarLoaded(copy()))
        _ = mediator.handle(.sessionResumed(hasSession: true, deviceId: nil))
        _ = mediator.handle(.socketOpened)
        // The listing asked for at launch has not come back yet.
        #expect(fetches(mediator.handle(.socketReceived(Fixture.snapshot(seq: 1, requestId: "r1", avatarVersion: version2))))
            .isEmpty)
        let listing = Fixture.avatarListing(version: version2)
        #expect(fetches(mediator.handle(.avatarListingFetched(origin: server, listing))) == [.receiveAvatar(origin: server, listing)])
        #expect(fetches(mediator.handle(.reconnectRequested)).isEmpty)
    }

    @Test("取りに行っている間にサーバーが変わったら、前のサーバーの一覧は使わず、今のサーバーに取り直す")
    func serverChangedMeanwhile() {
        var mediator = mediator()
        _ = launch(&mediator)
        _ = mediator.handle(.avatarLoaded(nil))
        _ = mediator.handle(.serverSubmitted("https://other.example.net"))
        let effects = mediator.handle(.avatarListingFetched(origin: server, Fixture.avatarListing()))
        #expect(fetches(effects) == [.fetchAvatarListing(origin: "https://other.example.net")])
    }

    @Test("受け取った表示名を、メニューバー・会話のウインドウ・画像の窓・モデルの経路の文言に使う")
    func names() {
        var mediator = started()
        _ = mediator.handle(.characterClicked)
        _ = mediator.handle(.socketOpened)
        _ = mediator.handle(.socketReceived(Fixture.snapshot(
            seq: 1, requestId: "r1", deviceId: "device-1", modelRoutes: Fixture.modelRoutes(current: nil))))
        let root = props(mediator)
        #expect(root.menu.title == "ハナ")
        #expect(root.conversation?.title == "ハナ")
        #expect(root.settings.modelRoutes.summary.hasPrefix("ハナはいま話せません"))
    }

    @Test("控えが無いうちの名前は、アプリの名前")
    func fallbackName() {
        var mediator = mediator()
        _ = launch(&mediator, server: nil)
        _ = mediator.handle(.avatarLoaded(nil))
        #expect(props(mediator).menu.title == "Natsumi")
    }
}

@Suite("iPhone: アバターを受け取るまでは設定（ログイン）の画面")
struct PhoneAvatarFlowTests {
    private func mediator() -> PhoneMediator {
        var counter = 0
        return PhoneMediator {
            counter += 1
            return "r\(counter)"
        }
    }

    private func screen(_ mediator: PhoneMediator) -> PhoneScreen {
        PhoneProps.root(mediator.state, time: .example).screen
    }

    private func login(_ mediator: PhoneMediator) -> PhoneLoginProps? {
        if case .login(let props) = screen(mediator) { props } else { nil }
    }

    private func main(_ mediator: PhoneMediator) -> PhoneMainProps? {
        if case .main(let props) = screen(mediator) { props } else { nil }
    }

    private func fetches(_ effects: [PhoneEffect]) -> [PhoneEffect] {
        effects.filter {
            switch $0 {
            case .fetchAvatarListing, .receiveAvatar: true
            default: false
            }
        }
    }

    @Test("起動したら控えを読み、サーバーがあればその一覧を取りに行く")
    func launchLoadsAndChecks() {
        var mediator = mediator()
        let effects = mediator.handle(.launched(serverOrigin: server))
        #expect(effects.first == .loadAvatar)
        #expect(fetches(effects) == [.fetchAvatarListing(origin: server)])
        var none = self.mediator()
        #expect(fetches(none.handle(.launched(serverOrigin: nil))).isEmpty)
    }

    @Test("アバターを受け取っていなければ、セッションがあってもログインの画面。受け取ったら会話の画面")
    func noAvatarStaysOnLogin() throws {
        var mediator = mediator()
        _ = mediator.handle(.launched(serverOrigin: server))
        _ = mediator.handle(.avatarLoaded(nil))
        _ = mediator.handle(.sessionResumed(hasSession: true, deviceId: nil))
        let waiting = try #require(login(mediator))
        #expect(waiting.greeting == "アバターを受け取っています。少し待ってね。")

        let listing = Fixture.avatarListing()
        #expect(fetches(mediator.handle(.avatarListingFetched(origin: server, listing))) == [.receiveAvatar(origin: server, listing)])
        #expect(login(mediator) != nil)
        _ = mediator.handle(.avatarReceived(copy()))
        #expect(main(mediator) != nil)
    }

    @Test("受け取れなければ、ログインの画面にそう出す")
    func failureIsSaid() throws {
        var mediator = mediator()
        _ = mediator.handle(.launched(serverOrigin: server))
        _ = mediator.handle(.avatarLoaded(nil))
        _ = mediator.handle(.avatarListingFetched(origin: server, nil))
        #expect(try #require(login(mediator)).message == "アバターを受け取れませんでした。サーバーを確かめてね。")
    }

    @Test("控えがあれば、それで会話の画面から始める")
    func copyStartsOnMain() {
        var mediator = mediator()
        _ = mediator.handle(.launched(serverOrigin: server))
        _ = mediator.handle(.avatarLoaded(copy()))
        _ = mediator.handle(.sessionResumed(hasSession: true, deviceId: nil))
        #expect(main(mediator) != nil)
    }

    @Test("ログインの画面でサーバーを入れたら、ログインと一緒にそのサーバーの一覧を取る")
    func loginSubmittedChecks() {
        var mediator = mediator()
        _ = mediator.handle(.launched(serverOrigin: nil))
        _ = mediator.handle(.avatarLoaded(nil))
        let effects = mediator.handle(.loginSubmitted(server: "https://other.example.net"))
        #expect(effects.contains(.startLogin))
        #expect(fetches(effects) == [.fetchAvatarListing(origin: "https://other.example.net")])
    }

    @Test("snapshot の avatarVersion が控えと違えば取り直す")
    func snapshotVersion() {
        var mediator = mediator()
        _ = mediator.handle(.launched(serverOrigin: server))
        _ = mediator.handle(.avatarLoaded(copy()))
        _ = mediator.handle(.avatarListingFetched(origin: server, Fixture.avatarListing(version: version1)))
        _ = mediator.handle(.sessionResumed(hasSession: true, deviceId: nil))
        _ = mediator.handle(.socketOpened)
        #expect(fetches(mediator.handle(.socketReceived(Fixture.snapshot(seq: 1, requestId: "r1", avatarVersion: version2))))
            == [.fetchAvatarListing(origin: server)])
    }

    @Test("受け取った表示名を、吹き出しの見出し・履歴の行・キャラの名前・画像の題に使う")
    func names() throws {
        var mediator = mediator()
        _ = mediator.handle(.launched(serverOrigin: server))
        _ = mediator.handle(.avatarLoaded(copy()))
        _ = mediator.handle(.sessionResumed(hasSession: true, deviceId: nil))
        _ = mediator.handle(.socketOpened)
        _ = mediator.handle(.socketReceived(Fixture.snapshot(
            seq: 1, requestId: "r1", deviceId: "device-1",
            messages: [Fixture.message("m1", role: "owner", kind: "message", text: "おはよう", eventId: "e1"),
                       Fixture.message("m2", text: "おはよう。", replyTo: "e1", expression: "happy")],
            unreadReplyCount: 1)))
        let props = try #require(main(mediator))
        guard case .reply(let reply) = props.balloon else { Issue.record("no reply"); return }
        #expect(reply.header.hasPrefix("ハナ"))
        #expect(props.character.name == "ハナ")

        _ = mediator.handle(.historyOpenRequested)
        guard case .history(let history) = try #require(main(mediator)).page else { Issue.record("no history"); return }
        #expect(history.history.rows.map(\.speaker) == [nil, "ハナ"])
        #expect(PhoneProps.viewerTitle(mediator.state) == "ハナの画像")
    }
}
