import Foundation
import Testing
@testable import NatsumiCore

@Suite("iPhone の裁定（Mediator）と描画パラメータ")
struct PhoneMediatorTests {
    private static let server = "https://natsumi.example.net"

    private func mediator() -> PhoneMediator {
        var counter = 0
        return PhoneMediator {
            counter += 1
            return "r\(counter)"
        }
    }

    private func launched(server: String? = server, hasSession: Bool = true) -> PhoneMediator {
        var mediator = mediator()
        _ = mediator.handle(.launched(serverOrigin: server))
        _ = mediator.handle(.avatarLoaded(Fixture.receivedAvatar))
        _ = mediator.handle(.sessionResumed(hasSession: hasSession, deviceId: nil))
        return mediator
    }

    /// A mediator that is synced with the server, with the given messages already in the conversation.
    private func synced(
        messages: [[String: Any]] = [], pending: [[String: Any]] = [], expression: String = "neutral",
        readThrough: String? = nil, unread: Int = 0, unacknowledged: [String] = []
    ) -> PhoneMediator {
        var mediator = launched()
        _ = mediator.handle(.socketOpened)
        _ = mediator.handle(.socketReceived(Fixture.snapshot(
            seq: 1, requestId: "r1", deviceId: "device-1", messages: messages, pending: pending,
            expression: expression, readThrough: readThrough, unreadReplyCount: unread,
            unacknowledged: unacknowledged)))
        return mediator
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

    private func sent(_ effects: [PhoneEffect]) -> [ClientEnvelope] {
        effects.compactMap { if case .sendToServer(let envelope) = $0 { envelope } else { nil } }
    }

    // MARK: - Login

    @Test("サーバーが未設定なら、ログインの画面で「はじめまして」と迎える")
    func firstLaunchShowsLogin() {
        var mediator = mediator()
        #expect(mediator.handle(.launched(serverOrigin: nil)) == [.loadAvatar, .disconnect])
        let props = try! #require(login(mediator))
        #expect(props.greeting == "はじめまして。どこのサーバーにつなぐか教えてね。")
        #expect(props.serverOrigin == "")
        #expect(props.face == .happy)
        #expect(!props.isLoggingIn)
        #expect(props.buttonTitle == "GitHub でログイン")
        #expect(props.message == nil)
    }

    @Test("サーバーはあるがセッションが無いなら、そのサーバーを入れたまま「おかえり」と迎える")
    func returningOwnerIsWelcomedBack() {
        let mediator = launched(hasSession: false)
        let props = try! #require(login(mediator))
        #expect(props.greeting == "おかえり。もう一度ログインしてね。")
        #expect(props.serverOrigin == Self.server)
    }

    @Test("URL の形でないものと、ループバック以外の http は、その場で断る")
    func invalidServersAreRefused() {
        var mediator = launched(server: nil)
        #expect(mediator.handle(.loginSubmitted(server: "natsumi")).isEmpty)
        #expect(login(mediator)?.message == "https://ホスト名[:ポート] の形で入れてください")
        #expect(mediator.handle(.loginSubmitted(server: "http://natsumi.example.net")).isEmpty)
        #expect(login(mediator)?.message == "http は localhost などのループバックだけで使えます。https の URL を入れてください")
    }

    @Test("新しいサーバーは保存してからログインし、終わるまでボタンを押せない")
    func loginWithANewServer() throws {
        var mediator = launched(server: nil)
        let address = try ServerAddress(Self.server)
        #expect(mediator.handle(.loginSubmitted(server: Self.server + "/")) == [.saveServerAddress(address), .startLogin, .fetchAvatarListing(origin: Self.server)])
        let props = try #require(login(mediator))
        #expect(props.isLoggingIn)
        #expect(props.buttonTitle == "ログイン中…")
        #expect(props.message == nil)
        // A second tap while the sheet is up starts nothing.
        #expect(mediator.handle(.loginSubmitted(server: Self.server)).isEmpty)

        #expect(mediator.handle(.loginFinished(.succeeded)) == [.disconnect, .resumeSession])
        #expect(mediator.handle(.sessionResumed(hasSession: true, deviceId: nil)) == [.registerForNotifications, .connect])
        #expect(main(mediator)?.status == PhoneStatusProps(text: "接続中…", tone: .waiting, action: nil))
    }

    @Test("同じサーバーなら保存し直さずにログインだけする")
    func loginWithTheSameServer() {
        var mediator = launched(hasSession: false)
        #expect(mediator.handle(.loginSubmitted(server: Self.server)) == [.startLogin])
    }

    @Test("ログインをやめたら何も言わずに戻り、失敗したらその理由を出す")
    func loginCancelledOrFailed() {
        var mediator = launched(hasSession: false)
        _ = mediator.handle(.loginSubmitted(server: Self.server))
        #expect(mediator.handle(.loginFinished(.cancelled)).isEmpty)
        #expect(login(mediator)?.isLoggingIn == false)
        #expect(login(mediator)?.message == nil)

        _ = mediator.handle(.loginSubmitted(server: Self.server))
        #expect(mediator.handle(.loginFinished(.failed("ログインできませんでした（HTTP 403）"))).isEmpty)
        #expect(login(mediator)?.isLoggingIn == false)
        #expect(login(mediator)?.message == "ログインできませんでした（HTTP 403）")
    }

    @Test("セッションが切れたら、ログインの画面に戻る")
    func expiredSessionGoesBackToLogin() {
        var mediator = synced()
        #expect(main(mediator) != nil)
        #expect(mediator.handle(.socketClosed(.code(1008))) == [.disconnect, .clearSession])
        #expect(login(mediator)?.greeting == "おかえり。もう一度ログインしてね。")
    }

    // MARK: - The app going away and coming back

    @Test("裏に回ったら切り、戻ったら続きから同期し直す。送りかけのメッセージは残る")
    func backgroundAndBack() {
        var mediator = synced()
        #expect(mediator.handle(.enteredBackground) == [.disconnect])
        _ = mediator.handle(.inputSubmitted("架空のメッセージ"))
        #expect(mediator.handle(.becameActive) == [.disconnect, .connect])
        let effects = mediator.handle(.socketOpened)
        let sync = try! #require(sent(effects).first)
        guard case .sessionSync(let resume) = sync.command else { Issue.record("同期を頼んでいない"); return }
        #expect(resume != nil)
        #expect(mediator.state.conversation.outbox.map(\.text) == ["架空のメッセージ"])
    }

    @Test("再接続を待っている間に戻ったら、待たずにつなぎ直す")
    func comingBackSkipsTheReconnectWait() {
        var mediator = synced()
        #expect(mediator.handle(.socketClosed(.network)) == [.disconnect, .scheduleReconnect(after: 1)])
        #expect(mediator.handle(.becameActive) == [.disconnect, .connect])
    }

    @Test("つながっている最中や、ログインしていないときに戻っても何もしない")
    func comingBackWhenThereIsNothingToDo() {
        var connected = synced()
        #expect(connected.handle(.becameActive).isEmpty)
        var loggedOut = launched(hasSession: false)
        #expect(loggedOut.handle(.becameActive).isEmpty)
        #expect(loggedOut.handle(.enteredBackground).isEmpty)
    }

    // MARK: - The main screen

    @Test("つながっていれば緑で「つながっています」、切り替わったら「接続し直す」を出す")
    func status() {
        var mediator = synced()
        #expect(main(mediator)?.status == PhoneStatusProps(text: "つながっています", tone: .connected, action: nil))
        _ = mediator.handle(.socketClosed(.code(4001)))
        #expect(main(mediator)?.status == PhoneStatusProps(
            text: ConnectionStatus.replaced.text, tone: .trouble,
            action: PhoneActionProps(title: "接続し直す", event: .reconnectRequested)))
        #expect(mediator.handle(.reconnectRequested) == [.disconnect, .resumeSession])
    }

    @Test("吹き出しは最後の未読の返事を全文で出し、見出しに時刻を添える。× で既読にして消す")
    func balloonShowsTheWholeReply() {
        let long = String(repeating: "とても長い返事。", count: 40) + "\n\n続きの段落"
        var mediator = synced(messages: [Fixture.message("r1", text: long)], unread: 1)
        guard case .reply(let reply) = main(mediator)?.balloon else { Issue.record("返事が出ていない"); return }
        #expect(reply.text == long)
        #expect(reply.header == "なつみ · 1/1 9:00")
        #expect(reply.thinking == nil)

        let effects = mediator.handle(.balloonCloseTapped)
        #expect(sent(effects).map(\.command) == [.conversationRead(throughMessageId: "r1")])
        #expect(main(mediator)?.balloon == nil)
    }

    @Test("考えている間は考えの吹き出しを出し、その間の返事には考えている 1 行を添える")
    func thinking() {
        var mediator = synced(
            messages: [Fixture.message("m1", role: "owner", kind: "message", text: "架空の質問", eventId: "e1")],
            pending: [["eventId": "e1", "messageId": "m1", "state": "processing"]])
        #expect(main(mediator)?.balloon == .thought(ThinkingProps(label: "考え中", line: nil)))
        _ = mediator.handle(.socketReceived(Fixture.thinking("メモを読み返してる", seq: 1)))
        #expect(main(mediator)?.balloon == .thought(ThinkingProps(label: "考え中", line: "メモを読み返してる")))

        _ = mediator.handle(.socketReceived(Fixture.envelope(
            "conversation.message", seq: 2, payload: Fixture.message("r1", text: "架空の返事"))))
        guard case .reply(let reply) = main(mediator)?.balloon else { Issue.record("返事が出ていない"); return }
        #expect(reply.text == "架空の返事")
        #expect(reply.thinking == ThinkingProps(label: "考え中", line: "メモを読み返してる"))
    }

    @Test("送ったばかりのメッセージは「受付中」の考えの吹き出しになり、断られたら知らせて消せる")
    func sending() {
        var mediator = synced()
        let effects = mediator.handle(.inputSubmitted("架空のメッセージ"))
        #expect(sent(effects).map(\.command) == [.conversationSend(text: "架空のメッセージ")])
        #expect(main(mediator)?.balloon == .thought(ThinkingProps(label: "受付中", line: nil)))
        #expect(mediator.handle(.inputSubmitted("  \n")).isEmpty)

        _ = mediator.handle(.socketReceived(Fixture.envelope(
            "command.rejected", seq: 2, requestId: "r2", payload: ["code": "too-long"])))
        #expect(main(mediator)?.outgoing
            == [OutgoingRowProps(requestId: "r2", text: "架空のメッセージ", failure: "送れませんでした（too-long）")])
        _ = mediator.handle(.outgoingDismissed(requestId: "r2"))
        #expect(main(mediator)?.outgoing == [])
    }

    @Test("話しかけている間は、知らせを引っ込め、送ったばかりの行を入力欄の上に出す")
    func composing() {
        var notice = Fixture.message("n1", kind: "notice", text: "架空のお知らせ")
        notice["about"] = ["e1"]
        var mediator = synced(messages: [notice, Fixture.message("r1", text: "架空の返事")],
                              unread: 1, unacknowledged: ["n1"])
        #expect(main(mediator)?.isComposing == false)
        #expect(main(mediator)?.notices != nil)

        #expect(mediator.handle(.inputFocusChanged(true)).isEmpty)
        #expect(main(mediator)?.isComposing == true)
        // The card would cover what she said while there is little room; the count comes back when the keyboard goes.
        #expect(main(mediator)?.notices == nil)
        guard case .reply = main(mediator)?.balloon else { Issue.record("返事が出ていない"); return }

        _ = mediator.handle(.inputSubmitted("架空のメッセージ"))
        #expect(main(mediator)?.outgoing == [OutgoingRowProps(requestId: "r2", text: "架空のメッセージ", failure: nil)])

        _ = mediator.handle(.inputFocusChanged(false))
        #expect(main(mediator)?.notices != nil)
        // With the keyboard gone, only what could not be recorded stays over the input field.
        #expect(main(mediator)?.outgoing == [])
    }

    @Test("知らせは 1 行目と未読の数を黄色いカードで出し、後ろに重なる枚数を添える")
    func notices() {
        var first = Fixture.message("n1", kind: "notice", text: "架空のお知らせ\n2 行目")
        first["about"] = ["e1"]
        var second = Fixture.message("n2", kind: "notice", text: "もう一つの架空のお知らせ")
        second["about"] = ["e2"]
        let mediator = synced(messages: [first, second], unacknowledged: ["n1", "n2"])
        #expect(main(mediator)?.notices == PhoneNoticeProps(text: "架空のお知らせ", count: "未読 2 件", edges: 1))

        let older = synced(messages: [], unacknowledged: ["n0"])
        #expect(main(older)?.notices == PhoneNoticeProps(
            text: "前の知らせが 1 件あります（本文は履歴より前のため出せません）", count: "未読 1 件", edges: 0))
    }

    @Test("キャラクターはサーバーの表情で描く")
    func characterWearsTheServersFace() {
        let mediator = synced(expression: "happy")
        #expect(main(mediator)?.character == PhoneCharacterProps(avatar: .placeholder, expression: .happy, name: "なつみ"))
    }

    @Test("話しかけている間の顔は、横に出ているセリフに込めた気持ちで描く")
    func composingFaceWearsTheLinesFeeling() {
        var mediator = synced(
            messages: [Fixture.message("r1", text: "架空の返事", expression: "laughing")], expression: "neutral", unread: 1)
        // Standing, she wears the server's face; the feeling of the line is separate from it (ADR 0026).
        #expect(main(mediator)?.character.expression == .neutral)
        _ = mediator.handle(.inputFocusChanged(true))
        #expect(main(mediator)?.character.expression == .laughing)

        // Once the reply is read, there is no line beside her, and she wears the server's face again.
        _ = mediator.handle(.balloonCloseTapped)
        #expect(main(mediator)?.character.expression == .neutral)
    }

    @Test("話しかけている間でも、気持ちの分からないセリフの横では、サーバーの表情で描く")
    func composingFaceWithoutAFeeling() {
        var mediator = synced(messages: [Fixture.message("r1", text: "架空の返事")], expression: "sleepy", unread: 1)
        _ = mediator.handle(.inputFocusChanged(true))
        #expect(main(mediator)?.character.expression == .sleepy)
    }
}
