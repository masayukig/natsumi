import Foundation
import Testing
@testable import NatsumiCore

@Suite("iPhone の履歴と設定")
struct PhoneNavigationTests {
    private func synced(
        messages: [[String: Any]] = [], pending: [[String: Any]] = [], readThrough: String? = nil, unread: Int = 0,
        unacknowledged: [String] = []
    ) -> PhoneMediator {
        var counter = 0
        var mediator = PhoneMediator {
            counter += 1
            return "r\(counter)"
        }
        _ = mediator.handle(.launched(serverOrigin: "https://natsumi.example.net"))
        _ = mediator.handle(.avatarLoaded(Fixture.receivedAvatar))
        _ = mediator.handle(.sessionResumed(hasSession: true, deviceId: nil))
        _ = mediator.handle(.socketOpened)
        _ = mediator.handle(.socketReceived(Fixture.snapshot(
            seq: 1, requestId: "r1", deviceId: "device-1", messages: messages, pending: pending,
            readThrough: readThrough, unreadReplyCount: unread, unacknowledged: unacknowledged)))
        return mediator
    }

    private func main(_ mediator: PhoneMediator) -> PhoneMainProps? {
        if case .main(let props) = PhoneProps.root(mediator.state, time: .example).screen { props } else { nil }
    }

    private func history(_ mediator: PhoneMediator) -> PhoneHistoryProps? {
        if case .history(let props) = main(mediator)?.page { props } else { nil }
    }

    private func settings(_ mediator: PhoneMediator) -> PhoneSettingsProps? {
        if case .settings(let props) = main(mediator)?.page { props } else { nil }
    }

    private func sent(_ effects: [PhoneEffect]) -> [ClientCommand] {
        effects.compactMap { if case .sendToServer(let envelope) = $0 { envelope.command } else { nil } }
    }

    private func notice(_ id: String, _ text: String = "架空のお知らせ") -> [String: Any] {
        var message = Fixture.message(id, kind: "notice", text: text)
        message["about"] = ["e0"]
        return message
    }

    // MARK: - History

    @Test("右上のボタンと知らせのカードで履歴を開き、戻るで閉じる")
    func openAndCloseTheHistory() {
        var mediator = synced(messages: [Fixture.message("m1", role: "owner", kind: "message", text: "架空の質問")])
        #expect(main(mediator)?.page == nil)
        _ = mediator.handle(.historyOpenRequested)
        let props = try! #require(history(mediator))
        #expect(props.history.rows.map(\.messageId) == ["m1"])
        _ = mediator.handle(.pageClosed)
        #expect(main(mediator)?.page == nil)
    }

    @Test("履歴で見えた返事までを既読にする。閉じている間は見えても読まない")
    func seenRepliesAreRead() {
        var mediator = synced(
            messages: [Fixture.message("r1"), Fixture.message("r2", text: "二つ目")], readThrough: nil, unread: 2)
        #expect(sent(mediator.handle(.historyRowVisibilityChanged(messageId: "r2", isVisible: true))).isEmpty)
        _ = mediator.handle(.historyOpenRequested)
        #expect(sent(mediator.handle(.historyRowVisibilityChanged(messageId: "r1", isVisible: true)))
            == [.conversationRead(throughMessageId: "r1")])
        #expect(sent(mediator.handle(.historyRowVisibilityChanged(messageId: "r2", isVisible: true)))
            == [.conversationRead(throughMessageId: "r2")])
        #expect(main(mediator)?.balloon == nil)
    }

    @Test("履歴で見えた知らせを確認済みにする。履歴より前の知らせは、履歴を開いたときにまとめて確かめる")
    func seenNoticesAreChecked() {
        var mediator = synced(messages: [notice("n1"), notice("n2")], unacknowledged: ["n0", "n1", "n2"])
        #expect(main(mediator)?.notices?.count == "未読 3 件")
        #expect(sent(mediator.handle(.historyOpenRequested)) == [.notificationAck(notificationId: "n0")])
        #expect(sent(mediator.handle(.historyRowVisibilityChanged(messageId: "n2", isVisible: true)))
            == [.notificationAck(notificationId: "n2")])
        #expect(main(mediator)?.notices?.count == "未読 1 件")
        // One that went out of sight before the history opened again is not checked.
        _ = mediator.handle(.historyRowVisibilityChanged(messageId: "n2", isVisible: false))
        _ = mediator.handle(.pageClosed)
        #expect(sent(mediator.handle(.historyOpenRequested)).isEmpty)
    }

    @Test("届いた返事も、履歴で見えていればその場で既読になる")
    func aReplyArrivingInSightIsRead() {
        var mediator = synced(messages: [Fixture.message("m1", role: "owner", kind: "message", text: "架空の質問")])
        _ = mediator.handle(.historyOpenRequested)
        _ = mediator.handle(.historyRowVisibilityChanged(messageId: "r9", isVisible: true))
        let effects = mediator.handle(.socketReceived(Fixture.envelope(
            "conversation.message", seq: 2, payload: Fixture.message("r9", text: "架空の返事"))))
        #expect(sent(effects) == [.conversationRead(throughMessageId: "r9")])
    }

    @Test("履歴の顔と考え中の行は Mac と同じ規則で導く")
    func historyRowsFollowTheMac() {
        var reply = Fixture.message("r1", text: "架空の返事")
        reply["expression"] = "happy"
        var mediator = synced(
            messages: [Fixture.message("m1", role: "owner", kind: "message", text: "架空の質問", eventId: "e1"), reply],
            pending: [["eventId": "e1", "messageId": "m1", "state": "processing"]], readThrough: "r1")
        _ = mediator.handle(.historyOpenRequested)
        let props = try! #require(history(mediator))
        #expect(props.history.rows.last?.face == FaceProps(expression: .happy, isLarge: true, help: "気持ち: うれしい"))
        #expect(props.history.isThinking)
    }

    // MARK: - Settings and logout

    @Test("設定にはサーバー・接続・この端末を出す")
    func settingsShowTheConnection() {
        var mediator = synced()
        _ = mediator.handle(.settingsOpenRequested)
        let props = try! #require(settings(mediator))
        #expect(props.serverOrigin == "https://natsumi.example.net")
        #expect(props.status == PhoneStatusProps(text: "つながっています", tone: .connected, action: nil))
        #expect(props.device == "device-1")
    }

    @Test("ログアウトで接続を切り、ログインの画面に戻る。次にログインしたらメインから始まる")
    func logout() {
        var mediator = synced()
        _ = mediator.handle(.settingsOpenRequested)
        #expect(mediator.handle(.logoutRequested) == [.disconnect, .logout])
        guard case .login(let login) = PhoneProps.root(mediator.state, time: .example).screen else {
            Issue.record("ログインの画面に戻っていない")
            return
        }
        #expect(login.serverOrigin == "https://natsumi.example.net")
        _ = mediator.handle(.loginSubmitted(server: "https://natsumi.example.net"))
        _ = mediator.handle(.loginFinished(.succeeded))
        _ = mediator.handle(.sessionResumed(hasSession: true, deviceId: "device-1"))
        #expect(main(mediator)?.page == nil)
    }
}
