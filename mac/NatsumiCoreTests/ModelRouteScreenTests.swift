import CoreGraphics
import Foundation
import Testing
@testable import NatsumiCore

@Suite("モデルの経路の Props と、Mac・iPhone で切り替える")
struct ModelRouteScreenTests {
    // MARK: - Props

    private func book(_ routes: [String: Any]? = Fixture.modelRoutes(), choose: String? = nil, answer: Data? = nil) -> ModelRouteBook {
        var counter = 0
        var m = SessionMachine(deviceId: nil) {
            counter += 1
            return "r\(counter)"
        }
        _ = m.start()
        _ = m.connected()
        _ = m.received(Fixture.snapshot(seq: 1, requestId: "r1", deviceId: "device-1", modelRoutes: routes))
        if let choose { _ = m.chooseRoute(choose) }
        if let answer { _ = m.received(answer) }
        return m.modelRoutes
    }

    private func row(
        _ name: String, _ detail: String, tags: [String] = [], chosen: Bool = false, enabled: Bool = true
    ) -> ModelRouteRowProps {
        ModelRouteRowProps(name: name, detail: detail, tags: tags, isChosen: chosen, isEnabled: enabled)
    }

    @Test("今の経路と一覧。選んである経路と使えない経路は押せない")
    func settled() {
        let props = UIProps.modelRoutes(book(), isConnected: true)
        #expect(props.summary == "local（example-model）で話しています")
        #expect(props.menuTitle == "モデル: local")
        #expect(!props.isSilent)
        #expect(props.pending == nil)
        #expect(props.message == nil)
        #expect(props.rows == [
            row("local", "natsumi-compatible · example-model", tags: ["使用中", "既定"], chosen: true, enabled: false),
            row("plus", "openai-codex · example-plus-model"),
            row("spare", "natsumi-spare · example-spare-model", tags: ["使えません"], enabled: false),
        ])
    }

    @Test("選んだ経路が今と違う間は「次のターンから」と示し、今の経路に戻すこともできる")
    func nextTurn() {
        let props = UIProps.modelRoutes(book(Fixture.modelRoutes(current: "local", chosen: "plus")), isConnected: true)
        #expect(props.summary == "local（example-model）で話しています")
        #expect(props.pending == "次のターンから plus に切り替わります")
        #expect(props.menuTitle == "モデル: local → plus")
        #expect(props.rows.map(\.tags) == [["使用中", "既定"], ["次のターンから"], ["使えません"]])
        #expect(props.rows.map(\.isChosen) == [false, true, false])
        #expect(props.rows.map(\.isEnabled) == [true, false, false])
    }

    @Test("選んだ経路が使えなくなったら、使えるようになるまで移らないことを示す")
    func chosenNotReady() {
        let routes = Fixture.modelRoutes(current: "local", chosen: "plus", ready: ["local": true, "plus": false, "spare": false])
        let props = UIProps.modelRoutes(book(routes), isConnected: true)
        #expect(props.pending == "plus はいま使えません。使えるようになってから切り替わります")
    }

    @Test("current が null なら、話せないことを目立たせる")
    func silent() {
        let routes = Fixture.modelRoutes(current: nil, chosen: "local", ready: ["local": false, "plus": true, "spare": false])
        let props = UIProps.modelRoutes(book(routes), isConnected: true)
        #expect(props.isSilent)
        #expect(props.summary == "なつみはいま話せません（使える経路がありません）")
        #expect(props.menuTitle == "モデル: 話せません")
        #expect(props.pending == "local はいま使えません。使えるようになってから切り替わります")
        #expect(props.rows.map(\.tags) == [["既定", "使えません"], [], ["使えません"]])
        #expect(props.rows.map(\.isEnabled) == [false, true, false])
    }

    @Test("送っている間は、どの経路も押せない")
    func sending() {
        let props = UIProps.modelRoutes(book(choose: "plus"), isConnected: true)
        #expect(props.message == "plus に切り替えています…")
        #expect(!props.isFailure)
        #expect(props.rows.allSatisfy { !$0.isEnabled })
    }

    @Test("断られた理由を示す")
    func refused() {
        func message(_ type: String, _ code: String) -> ModelRoutesProps {
            UIProps.modelRoutes(
                book(choose: "plus", answer: Fixture.envelope(type, seq: 2, requestId: "r2", payload: ["code": code])),
                isConnected: true)
        }
        #expect(message("command.rejected", "unknown-route").message == "plus はサーバーの設定にありません")
        #expect(message("command.rejected", "route-unavailable").message == "plus はいま使えません")
        #expect(message("command.rejected", "invalid-request").message == "plus に切り替えられませんでした（invalid-request）")
        #expect(message("service.unavailable", "pi-unavailable").message == "なつみが話せないため、切り替えられません（pi-unavailable）")
        #expect(message("command.rejected", "route-unavailable").isFailure)
        // The owner may try again.
        #expect(message("command.rejected", "route-unavailable").rows.map(\.isEnabled) == [false, true, false])
    }

    @Test("つながっていなければ押せない。経路を知らないうちは一覧が無い")
    func notConnected() {
        #expect(UIProps.modelRoutes(book(), isConnected: false).rows.allSatisfy { !$0.isEnabled })
        let unknown = UIProps.modelRoutes(book(nil), isConnected: true)
        #expect(unknown.rows.isEmpty)
        #expect(unknown.summary == "経路はまだ分かりません")
        #expect(unknown.menuTitle == "モデル: 不明")
        #expect(!unknown.isSilent)
    }

    // MARK: - The Mac

    private func mac() -> UIMediator {
        var counter = 0
        var mediator = UIMediator {
            counter += 1
            return "r\(counter)"
        }
        _ = mediator.handle(.launched(LaunchInfo(
            characterScale: .default, serverOrigin: "https://natsumi.example.net",
            avatarDirectory: "/tmp/avatar", defaultAvatarDirectory: "/tmp/avatar")))
        _ = mediator.handle(.sessionResumed(hasSession: true, deviceId: nil))
        _ = mediator.handle(.socketOpened)
        _ = mediator.handle(.socketReceived(Fixture.snapshot(
            seq: 1, requestId: "r1", deviceId: "device-1", modelRoutes: Fixture.modelRoutes())))
        return mediator
    }

    private func commands(_ effects: [UIEffect]) -> [ClientCommand] {
        effects.compactMap { if case .sendToServer(let envelope) = $0 { envelope.command } else { nil } }
    }

    private func macProps(_ mediator: UIMediator) -> RootProps {
        UIProps.root(mediator.state, placement: ColumnPlacement(), time: .example)
    }

    @Test("Mac: 設定と menu に経路を出し、選ぶと model.use を 1 回だけ送る")
    func macChoose() {
        var mediator = mac()
        #expect(macProps(mediator).settings.modelRoutes.summary == "local（example-model）で話しています")
        #expect(macProps(mediator).menu.modelRoutes.menuTitle == "モデル: local")
        #expect(commands(mediator.handle(.modelRouteChosen("plus"))) == [.modelUse(route: "plus")])
        #expect(commands(mediator.handle(.modelRouteChosen("plus"))).isEmpty)
        #expect(macProps(mediator).settings.modelRoutes.message == "plus に切り替えています…")
    }

    @Test("Mac: 設定を開くと、つながっていれば model.list で経路を確かめ直す")
    func macSettingsList() {
        var mediator = mac()
        #expect(commands(mediator.handle(.settingsOpenRequested)) == [.modelList])
        _ = mediator.handle(.settingsCloseRequested)
        _ = mediator.handle(.socketClosed(.network))
        #expect(commands(mediator.handle(.settingsOpenRequested)).isEmpty)
    }

    // MARK: - The iPhone

    private func phone() -> PhoneMediator {
        var counter = 0
        var mediator = PhoneMediator {
            counter += 1
            return "r\(counter)"
        }
        _ = mediator.handle(.launched(serverOrigin: "https://natsumi.example.net"))
        _ = mediator.handle(.sessionResumed(hasSession: true, deviceId: nil))
        _ = mediator.handle(.socketOpened)
        _ = mediator.handle(.socketReceived(Fixture.snapshot(
            seq: 1, requestId: "r1", deviceId: "device-1", modelRoutes: Fixture.modelRoutes())))
        return mediator
    }

    private func phoneCommands(_ effects: [PhoneEffect]) -> [ClientCommand] {
        effects.compactMap { if case .sendToServer(let envelope) = $0 { envelope.command } else { nil } }
    }

    private func settings(_ mediator: PhoneMediator) -> PhoneSettingsProps? {
        guard case .main(let main) = PhoneProps.root(mediator.state, time: .example).screen,
              case .settings(let settings) = main.page
        else { return nil }
        return settings
    }

    @Test("iPhone: 設定を開くと model.list を送り、経路を出す。選ぶと model.use を 1 回だけ送り、移ったら今の経路が変わる")
    func phoneChoose() {
        var mediator = phone()
        #expect(phoneCommands(mediator.handle(.settingsOpenRequested)) == [.modelList])
        #expect(settings(mediator)?.modelRoutes.summary == "local（example-model）で話しています")

        #expect(phoneCommands(mediator.handle(.modelRouteChosen("plus"))) == [.modelUse(route: "plus")])
        #expect(phoneCommands(mediator.handle(.modelRouteChosen("plus"))).isEmpty)
        _ = mediator.handle(.socketReceived(Fixture.envelope(
            "command.accepted", seq: 2, requestId: "r3", payload: ["chosen": "plus", "current": "local"])))
        #expect(settings(mediator)?.modelRoutes.pending == "次のターンから plus に切り替わります")
        _ = mediator.handle(.socketReceived(Fixture.envelope(
            "model.routes", seq: 3, payload: Fixture.modelRoutes(current: "plus", chosen: "plus"))))
        #expect(settings(mediator)?.modelRoutes.summary == "plus（example-plus-model）で話しています")
        #expect(settings(mediator)?.modelRoutes.pending == nil)
    }

    @Test("iPhone: ログアウトすると経路を忘れる")
    func phoneLogout() {
        var mediator = phone()
        _ = mediator.handle(.logoutRequested)
        #expect(mediator.state.session.modelRoutes.routes == nil)
    }
}
