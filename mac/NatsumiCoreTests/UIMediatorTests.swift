import CoreGraphics
import Foundation
import Testing
@testable import NatsumiCore

@Suite("UI の裁定（Mediator）")
struct UIMediatorTests {
    private static let server = "https://natsumi.example.net"

    private func launched(server: String? = server, hasSession: Bool = true) -> UIMediator {
        var counter = 0
        var mediator = UIMediator {
            counter += 1
            return "r\(counter)"
        }
        _ = mediator.handle(.launched(LaunchInfo(
            characterScale: .default, serverOrigin: server)))
        _ = mediator.handle(.sessionResumed(hasSession: hasSession, deviceId: nil))
        return mediator
    }

    /// A mediator that is synced with the server, with the given messages already in the conversation.
    private func synced(
        messages: [[String: Any]] = [], readThrough: String? = nil, unread: Int = 0, unacknowledged: [String] = []
    ) -> UIMediator {
        var mediator = launched()
        _ = mediator.handle(.socketOpened)
        _ = mediator.handle(.socketReceived(Fixture.snapshot(
            seq: 1, requestId: "r1", deviceId: "device-1", messages: messages,
            readThrough: readThrough, unreadReplyCount: unread, unacknowledged: unacknowledged)))
        return mediator
    }

    /// The drawing parameters as the root derives them when the whole column fits: the first step of the ladder the
    /// state asks for.
    private func props(_ mediator: UIMediator) -> RootProps {
        var placement = ColumnPlacement()
        placement.budget = UIProps.budgetSteps(mediator.state)[0]
        return UIProps.root(mediator.state, placement: placement, time: .example)
    }

    private func sent(_ effects: [UIEffect]) -> [ClientEnvelope] {
        effects.compactMap { if case .sendToServer(let envelope) = $0 { envelope } else { nil } }
    }

    // MARK: - Panels

    private let screen = CGRect(x: 0, y: 0, width: 1600, height: 1000)
    private let character = CGRect(x: 800, y: 500, width: 96, height: 104)

    /// A mediator whose character stands in the middle of a screen.
    private func placed() -> UIMediator {
        var mediator = launched()
        _ = mediator.handle(.characterFrameChanged(character, visible: screen))
        return mediator
    }

    @Test("キャラのクリックで会話のウインドウを開き、もう一度のクリックで消す。初回はキャラの真下に置き、それを覚える")
    func clickTogglesTheConversation() {
        var mediator = placed()
        #expect(props(mediator).conversation == nil)
        let opened = mediator.handle(.characterClicked)
        let window = try! #require(props(mediator).conversation)
        let size = ConversationWindow.default.size
        #expect(window.frame == CGRect(
            x: character.midX - size.width / 2, y: character.minY - 8 - size.height,
            width: size.width, height: size.height))
        #expect(window.history == nil)
        #expect(window.status == StatusProps(text: ConnectionStatus.connecting.text, action: nil))
        #expect(opened == [.focusInput, .saveConversationWindow(mediator.state.conversationWindow)])
        #expect(mediator.handle(.characterClicked).isEmpty)
        #expect(props(mediator).conversation == nil)
        // The next time it comes back to where it was, wherever she is now.
        _ = mediator.handle(.characterFrameChanged(character.offsetBy(dx: -500, dy: 0), visible: screen))
        #expect(mediator.handle(.characterClicked) == [.focusInput])
        #expect(props(mediator).conversation?.frame == window.frame)
    }

    @Test("⌘W で消える。Esc とアプリの外のクリックでは消えない（そのイベントはもう無い）")
    func closeRequested() {
        var mediator = placed()
        _ = mediator.handle(.characterClicked)
        #expect(mediator.handle(.conversationCloseRequested).isEmpty)
        #expect(props(mediator).conversation == nil)
        #expect(mediator.handle(.conversationCloseRequested).isEmpty)
    }

    @Test("メニューから話しかけると、消えていても覚えている状態で開く。開いていれば何もしない")
    func talkOpensTheConversation() {
        var mediator = placed()
        #expect(mediator.handle(.talkRequested).contains(.focusInput))
        #expect(mediator.handle(.talkRequested).isEmpty)
        #expect(props(mediator).conversation?.history == nil)
        _ = mediator.handle(.historyToggleRequested)
        _ = mediator.handle(.conversationCloseRequested)
        #expect(mediator.handle(.talkRequested) == [.focusInput])
        #expect(props(mediator).conversation?.history != nil)
    }

    @Test("ひらく⇔とじるは履歴を畳んだり開いたりするだけで、ウインドウは消えない。消えている間は何もしない")
    func toggleHistory() {
        var mediator = placed()
        #expect(mediator.handle(.historyToggleRequested).isEmpty)
        _ = mediator.handle(.characterClicked)
        let folded = try! #require(props(mediator).conversation)
        let effects = mediator.handle(.historyToggleRequested)
        let unfolded = try! #require(props(mediator).conversation)
        #expect(unfolded.history != nil)
        #expect(unfolded.frame.midY == folded.frame.midY)
        #expect(unfolded.frame.height == ConversationWindow.default.unfoldedHeight)
        #expect(unfolded.foldedHeight == folded.frame.height)
        #expect(unfolded.toggleHelp == "履歴をとじる（⌘L）")
        #expect(effects == [.saveConversationWindow(mediator.state.conversationWindow)])
        _ = mediator.handle(.historyToggleRequested)
        #expect(props(mediator).conversation == folded)
    }

    @Test("「履歴を開く」と「続きは履歴で」は、ウインドウを出して履歴を開く。開いていれば何もしない")
    func historyRequested() {
        var mediator = placed()
        let effects = mediator.handle(.historyOpenRequested)
        #expect(effects.first == .focusInput)
        #expect(props(mediator).conversation?.history != nil)
        #expect(mediator.handle(.historyLinkClicked).isEmpty)
        _ = mediator.handle(.conversationCloseRequested)
        #expect(mediator.handle(.historyLinkClicked) == [.focusInput])
        #expect(props(mediator).conversation?.history != nil)
    }

    @Test("動かした・大きさを変えたウインドウは、その幅といまの状態の高さを覚えて保存する")
    func frameChanged() {
        var mediator = placed()
        _ = mediator.handle(.characterClicked)
        let moved = CGRect(x: 10, y: 20, width: 400, height: 200)
        #expect(mediator.handle(.conversationFrameChanged(moved, visible: screen))
            == [.saveConversationWindow(mediator.state.conversationWindow)])
        #expect(props(mediator).conversation?.frame == moved)
        #expect(mediator.handle(.conversationFrameChanged(moved, visible: screen)).isEmpty)
        _ = mediator.handle(.historyToggleRequested)
        #expect(props(mediator).conversation?.frame.width == 400)
        #expect(props(mediator).conversation?.foldedHeight == 200)
        #expect(props(mediator).conversation?.frame.height == ConversationWindow.default.unfoldedHeight)
    }

    @Test("開くときの上下の余裕は、ウインドウのある画面で見る")
    func unfoldsOnTheWindowsScreen() {
        var mediator = placed()
        _ = mediator.handle(.characterClicked)
        let other = CGRect(x: 1600, y: 0, width: 1000, height: 300)
        _ = mediator.handle(.conversationFrameChanged(CGRect(x: 1700, y: 50, width: 320, height: 140), visible: other))
        _ = mediator.handle(.historyToggleRequested)
        #expect(props(mediator).conversation?.frame == CGRect(x: 1700, y: 0, width: 320, height: 300))
    }

    @Test("設定は開く指示と閉じる指示を出す")
    func settings() {
        var mediator = launched()
        #expect(mediator.handle(.settingsOpenRequested) == [.showSettings])
        #expect(props(mediator).isSettingsOpen)
        #expect(mediator.handle(.settingsCloseRequested) == [.hideSettings])
        #expect(props(mediator).isSettingsOpen == false)
    }

    // MARK: - Conversation

    @Test("送信は受付中の吹き出しになり、空白だけの送信はしない")
    func send() {
        var mediator = synced()
        #expect(mediator.handle(.inputSubmitted("   ")).isEmpty)
        #expect(props(mediator).balloon == nil)

        let effects = mediator.handle(.inputSubmitted("架空のメッセージ"))
        #expect(sent(effects).count == 1)
        #expect(props(mediator).balloon?.body == .thinking(ThinkingProps(label: "受付中", line: nil)))
        #expect(props(mediator).balloon?.outline == .thought)
    }

    @Test("本文のクリックは全文を出すだけで、× が最後の返事まで既読にし、既読になった吹き出しは消える")
    func readReplies() {
        var mediator = synced(
            messages: [Fixture.message("r1"), Fixture.message("r2", text: "架空の返事")], readThrough: nil, unread: 2)
        #expect(props(mediator).balloon?.body == .reply(ReplyProps(
            text: "架空の返事", lineLimit: BalloonText.maxLines, isExpanded: false, showsHistoryLink: false, unread: 2,
            help: "クリックで全文を出す")))
        #expect(props(mediator).balloon?.closeHelp == "既読にして閉じる")

        // Expanding tells the server nothing: only the × reads.
        let expanded = mediator.handle(.balloonTextClicked)
        #expect(sent(expanded).isEmpty)
        #expect(props(mediator).balloon?.body == .reply(ReplyProps(
            text: "架空の返事", lineLimit: BalloonText.expandedMaxLines, isExpanded: true, showsHistoryLink: false,
            unread: 2, help: "クリックで畳む")))

        let closed = mediator.handle(.balloonCloseClicked)
        #expect(sent(closed).map(\.command) == [.conversationRead(throughMessageId: "r2")])
        #expect(props(mediator).balloon == nil)
        #expect(mediator.state.conversation.unreadReplyCount == 0)

        // A newer reply is unread, so it comes forward.
        _ = mediator.handle(.socketReceived(Fixture.envelope(
            "conversation.message", seq: 2, payload: Fixture.message("r3", text: "次の返事"))))
        #expect(props(mediator).balloon?.body == .reply(ReplyProps(
            text: "次の返事", lineLimit: BalloonText.maxLines, showsHistoryLink: false, unread: 1,
            help: "クリックで全文を出す")))
    }

    @Test("メニューの「返事をすべて既読にする」でも、吹き出しは消える")
    func readAllClosesTheBalloon() {
        var mediator = synced(messages: [Fixture.message("r1")], readThrough: nil, unread: 1)
        #expect(sent(mediator.handle(.readAllRepliesRequested)).count == 1)
        #expect(props(mediator).balloon == nil)
    }

    @Test("ほかの端末で既読になれば、吹き出しは消える")
    func readElsewhere() {
        var mediator = synced(messages: [Fixture.message("r1")], readThrough: nil, unread: 1)
        _ = mediator.handle(.socketReceived(Fixture.envelope(
            "conversation.read", seq: 2, payload: ["readThroughMessageId": "r1", "unreadReplyCount": 0])))
        #expect(props(mediator).balloon == nil)
    }

    @Test("最後の返事が変わると、拡大は畳む")
    func expandedFoldsWithTheLastReply() {
        var mediator = synced(messages: [Fixture.message("r1")], readThrough: nil, unread: 1)
        _ = mediator.handle(.balloonTextClicked)
        #expect(props(mediator).balloon?.body.isExpanded == true)
        _ = mediator.handle(.socketReceived(Fixture.envelope(
            "conversation.message", seq: 2, payload: Fixture.message("r2"))))
        #expect(props(mediator).balloon?.body.isExpanded == false)
    }

    // MARK: - Reading in the conversation window

    /// A mediator with the conversation window open, its history unfolded, and the given rows seen in it.
    private func reading(
        messages: [[String: Any]], readThrough: String? = nil, unread: Int, key: Bool = true
    ) -> UIMediator {
        var mediator = synced(messages: messages, readThrough: readThrough, unread: unread)
        _ = mediator.handle(.characterFrameChanged(character, visible: screen))
        _ = mediator.handle(.historyOpenRequested)
        if key { _ = mediator.handle(.conversationKeyChanged(true)) }
        return mediator
    }

    @Test("履歴が開いていて key のウインドウに見えた返事は、見えている最後の返事まで既読にする")
    func readWhatIsSeen() {
        var mediator = reading(
            messages: [Fixture.message("r1"), Fixture.message("r2"), Fixture.message("r3")], unread: 3)
        #expect(sent(mediator.handle(.historyRowVisibilityChanged(messageId: "r1", isVisible: true))).map(\.command)
            == [.conversationRead(throughMessageId: "r1")])
        #expect(sent(mediator.handle(.historyRowVisibilityChanged(messageId: "r2", isVisible: true))).map(\.command)
            == [.conversationRead(throughMessageId: "r2")])
        // A row going out of sight reads nothing, and neither does one already read.
        #expect(sent(mediator.handle(.historyRowVisibilityChanged(messageId: "r1", isVisible: false))).isEmpty)
        #expect(mediator.state.conversation.unreadReplyCount == 1)

        // A reply arriving while it can be seen is read as soon as its row shows.
        _ = mediator.handle(.socketReceived(Fixture.envelope(
            "conversation.message", seq: 2, payload: Fixture.message("r4"))))
        #expect(sent(mediator.handle(.historyRowVisibilityChanged(messageId: "r4", isVisible: true))).map(\.command)
            == [.conversationRead(throughMessageId: "r4")])
        // Everything is read, and while the history is being read the balloon keeps out of the way anyway.
        #expect(props(mediator).balloon == nil)
    }

    @Test("行が見えた・見えなくなっただけでは描くものは変わらず、既読にしたときだけ変わる")
    func rowsInSightAloneDrawNothing() {
        var mediator = reading(messages: [Fixture.message("r1"), Fixture.message("r2")], unread: 2, key: false)
        let before = props(mediator)
        _ = mediator.handle(.historyRowVisibilityChanged(messageId: "r1", isVisible: true))
        #expect(!mediator.mayHaveChangedProps)
        #expect(props(mediator) == before)
        _ = mediator.handle(.historyRowVisibilityChanged(messageId: "r1", isVisible: false))
        #expect(!mediator.mayHaveChangedProps)
        #expect(props(mediator) == before)

        // Any other event may change them.
        _ = mediator.handle(.conversationKeyChanged(true))
        #expect(mediator.mayHaveChangedProps)
        // A row that reads a reply as it comes into sight changes them.
        #expect(sent(mediator.handle(.historyRowVisibilityChanged(messageId: "r2", isVisible: true))).count == 1)
        #expect(mediator.mayHaveChangedProps)
        #expect(props(mediator) != before)
        // And one already read does not.
        _ = mediator.handle(.historyRowVisibilityChanged(messageId: "r1", isVisible: true))
        #expect(!mediator.mayHaveChangedProps)
    }

    @Test("履歴を読んでいる間は、届いた返事を吹き出しに出さない。key でなくなれば出す")
    func noBalloonWhileReading() {
        var mediator = reading(messages: [Fixture.message("r1")], readThrough: "r1", unread: 0)
        _ = mediator.handle(.socketReceived(Fixture.envelope(
            "conversation.message", seq: 2, payload: Fixture.message("r2"))))
        // The row has not been reported in sight yet, and still the balloon does not flash up.
        #expect(props(mediator).balloon == nil)
        _ = mediator.handle(.conversationKeyChanged(false))
        #expect(props(mediator).balloon != nil)
        // Folded to the input field alone, nothing is being read, so the balloon stays.
        _ = mediator.handle(.conversationKeyChanged(true))
        _ = mediator.handle(.historyToggleRequested)
        #expect(props(mediator).balloon != nil)
    }

    @Test("ウインドウが key でない間は、見えていても既読にせず、key になったときに既読にする")
    func readOnlyWhileKey() {
        var mediator = reading(messages: [Fixture.message("r1"), Fixture.message("r2")], unread: 2, key: false)
        #expect(sent(mediator.handle(.historyRowVisibilityChanged(messageId: "r2", isVisible: true))).isEmpty)
        #expect(sent(mediator.handle(.conversationKeyChanged(true))).map(\.command)
            == [.conversationRead(throughMessageId: "r2")])
        _ = mediator.handle(.conversationKeyChanged(false))
        _ = mediator.handle(.socketReceived(Fixture.envelope(
            "conversation.message", seq: 2, payload: Fixture.message("r3"))))
        #expect(sent(mediator.handle(.historyRowVisibilityChanged(messageId: "r3", isVisible: true))).isEmpty)
        #expect(mediator.state.conversation.unreadReplyCount == 1)
    }

    @Test("履歴を畳んだり、ウインドウを消したりすると、見えていた行は忘れる")
    func foldingForgetsTheRows() {
        var mediator = reading(messages: [Fixture.message("r1")], unread: 1, key: false)
        _ = mediator.handle(.historyRowVisibilityChanged(messageId: "r1", isVisible: true))
        _ = mediator.handle(.historyToggleRequested)
        #expect(sent(mediator.handle(.conversationKeyChanged(true))).isEmpty)

        _ = mediator.handle(.historyToggleRequested)
        _ = mediator.handle(.conversationKeyChanged(false))
        _ = mediator.handle(.historyRowVisibilityChanged(messageId: "r1", isVisible: true))
        _ = mediator.handle(.conversationCloseRequested)
        _ = mediator.handle(.talkRequested)
        #expect(sent(mediator.handle(.conversationKeyChanged(true))).isEmpty)
        #expect(mediator.state.conversation.unreadReplyCount == 1)
    }

    @Test("拡大しているのは一度に 1 件で、別の本文を開くと前のは畳む")
    func onlyOneExpanded() {
        var notice = Fixture.message("n1", kind: "notice", text: "架空のお知らせ")
        notice["about"] = ["e1"]
        var mediator = synced(
            messages: [Fixture.message("r1"), notice], readThrough: nil, unread: 1, unacknowledged: ["n1"])
        _ = mediator.handle(.balloonTextClicked)
        #expect(props(mediator).balloon?.body.isExpanded == true)
        #expect(props(mediator).notices?.isExpanded == false)

        _ = mediator.handle(.noticeTextClicked)
        #expect(props(mediator).balloon?.body.isExpanded == false)
        #expect(props(mediator).notices?.isExpanded == true)

        // The same body again folds it.
        _ = mediator.handle(.noticeTextClicked)
        #expect(props(mediator).notices?.isExpanded == false)
    }

    @Test("閉じた「考え中」は、その 1 回の処理が終わるまで出さない")
    func dismissThinking() {
        var mediator = synced(
            messages: [Fixture.message("m1", role: "owner", kind: "message", eventId: "e1")],
            readThrough: "m1")
        _ = mediator.handle(.socketReceived(Fixture.envelope(
            "conversation.message", seq: 2,
            payload: Fixture.message("m2", role: "owner", kind: "message", eventId: "e2"))))
        #expect(props(mediator).balloon?.body == .thinking(ThinkingProps(label: "考え中", line: nil)))

        _ = mediator.handle(.balloonCloseClicked)
        #expect(props(mediator).balloon == nil)

        // One handling is one thing she is thinking: the lines that follow stay hidden.
        _ = mediator.handle(.socketReceived(Fixture.thinking("考えている", seq: 2)))
        #expect(props(mediator).balloon == nil)
        // What she says is not what was closed: the reply comes, without her thinking under it (ADR 0025).
        _ = mediator.handle(.socketReceived(Fixture.envelope(
            "conversation.message", seq: 3, payload: Fixture.message("r3", text: "架空の返事", replyTo: "e2"))))
        guard case .reply(let reply) = props(mediator).balloon?.body else { Issue.record("返事が出ていない"); return }
        #expect(reply.thinking == nil)

        // Reading it while she is still at it leaves nothing: the thought bubble stays closed.
        _ = mediator.handle(.balloonCloseClicked)
        #expect(props(mediator).balloon == nil)
    }

    @Test("考えている間に届いた返事は、考えている 1 行を下に付けて出し、× で既読にして考え中に戻る")
    func replyWhileThinking() {
        var mediator = synced(
            messages: [Fixture.message("m1", role: "owner", kind: "message", eventId: "e1")],
            readThrough: "m1")
        _ = mediator.handle(.socketReceived(Fixture.envelope(
            "conversation.message", seq: 2,
            payload: Fixture.message("m2", role: "owner", kind: "message", eventId: "e2"))))
        _ = mediator.handle(.socketReceived(Fixture.envelope(
            "conversation.message", seq: 3, payload: Fixture.message("r3", text: "架空の返事", replyTo: "e2"))))
        _ = mediator.handle(.socketReceived(Fixture.thinking("記憶に書いておく", seq: 3)))

        let shown = props(mediator)
        #expect(shown.balloon?.outline == .speech)
        guard case .reply(let reply) = shown.balloon?.body else { Issue.record("返事が出ていない"); return }
        #expect(reply.text == "架空の返事")
        #expect(reply.thinking == ThinkingProps(label: "考え中", line: "記憶に書いておく"))
        // The column is laid out without the line: a new one settles nothing.
        guard case .reply(let laidOut) = shown.withoutThinkingLine.balloon?.body else { Issue.record("返事が無い"); return }
        #expect(laidOut.thinking == ThinkingProps(label: "考え中", line: nil))

        // The × reads the reply, and she is still thinking.
        let effects = mediator.handle(.balloonCloseClicked)
        #expect(sent(effects).map(\.command) == [.conversationRead(throughMessageId: "r3")])
        #expect(props(mediator).balloon?.body == .thinking(ThinkingProps(label: "考え中", line: "記憶に書いておく")))
    }

    @Test("閉じた「受付中」は、続けて始まった「考え中」でも出し直さない")
    func dismissCarriesFromReceivingToThinking() {
        var mediator = synced(messages: [], readThrough: nil)
        _ = mediator.handle(.inputSubmitted("架空のメッセージ"))
        #expect(props(mediator).balloon?.body == .thinking(ThinkingProps(label: "受付中", line: nil)))
        _ = mediator.handle(.balloonCloseClicked)
        #expect(props(mediator).balloon == nil)

        _ = mediator.handle(.socketReceived(Fixture.envelope(
            "command.accepted", seq: 2, requestId: "r2",
            payload: ["messageId": "m1", "eventId": "e1", "state": "processing"])))
        #expect(props(mediator).balloon == nil)

        _ = mediator.handle(.socketReceived(Fixture.envelope(
            "conversation.event.completed", seq: 3, payload: ["eventId": "e1", "messageId": "m1", "status": "no-reply"])))
        // Nothing is left to handle, so the next message opens the bubble again.
        _ = mediator.handle(.inputSubmitted("もう一度"))
        #expect(props(mediator).balloon?.body == .thinking(ThinkingProps(label: "受付中", line: nil)))
    }

    @Test("印のクリックで知らせの束を隠し、新しい知らせが来るとまた出す")
    func toggleNotices() {
        var notice = Fixture.message("n1", kind: "notice", text: "架空のお知らせ")
        notice["about"] = ["e1"]
        var mediator = synced(messages: [notice], unacknowledged: ["n1"])
        #expect(props(mediator).notices != nil)
        #expect(props(mediator).character.badge?.count == 1)

        #expect(mediator.handle(.badgeClicked).isEmpty)
        #expect(props(mediator).notices == nil)
        // Hiding checks nothing: the badge still counts it.
        #expect(props(mediator).character.badge?.count == 1)

        var second = Fixture.message("n2", kind: "notice", text: "もう一つの架空のお知らせ")
        second["about"] = ["e2"]
        _ = mediator.handle(.socketReceived(Fixture.envelope("conversation.message", seq: 2, payload: second)))
        #expect(props(mediator).notices != nil)
        #expect(props(mediator).character.badge?.count == 2)
    }

    @Test("知らせの本文のクリックは全文を出すだけで、× が 1 件ずつ確かめる")
    func acknowledgeNotices() {
        var first = Fixture.message("n1", kind: "notice", text: "架空のお知らせ")
        first["about"] = ["e1"]
        var second = Fixture.message("n2", kind: "notice", text: "もう一つの架空のお知らせ")
        second["about"] = ["e2"]
        var mediator = synced(messages: [first, second], unacknowledged: ["n1", "n2"])
        #expect(props(mediator).notices?.closeHelp == "この知らせを確認して次へ")
        #expect(sent(mediator.handle(.noticeTextClicked)).isEmpty)
        #expect(props(mediator).character.badge?.count == 2)

        #expect(sent(mediator.handle(.noticeCloseClicked)).count == 1)
        #expect(props(mediator).character.badge?.count == 1)
        #expect(props(mediator).notices?.closeHelp == "この知らせを確認して閉じる")
        #expect(sent(mediator.handle(.noticeCloseClicked)).count == 1)
        #expect(props(mediator).notices == nil)
        #expect(props(mediator).character.badge == nil)
    }

    @Test("本文の無い「前の知らせ」の 1 枚だけは、クリックでまとめて確かめる")
    func olderNoticesAreCheckedByClicking() {
        var mediator = synced(messages: [Fixture.message("r1")], unacknowledged: ["n0", "n1"])
        #expect(props(mediator).notices?.help == "クリックでまとめて確かめる")
        // One command per notice, as the contract has it; the card stands for both.
        #expect(sent(mediator.handle(.noticeTextClicked)).count == 2)
        #expect(props(mediator).notices == nil)
    }

    @Test("メニューの「すべて確認する」だけが、束をまとめて確かめる")
    func acknowledgeAllFromTheMenu() {
        var first = Fixture.message("n1", kind: "notice", text: "架空のお知らせ")
        first["about"] = ["e1"]
        var second = Fixture.message("n2", kind: "notice", text: "もう一つの架空のお知らせ")
        second["about"] = ["e2"]
        var mediator = synced(messages: [first, second], unacknowledged: ["n1", "n2"])
        #expect(sent(mediator.handle(.acknowledgeAllNoticesRequested)).count == 2)
        #expect(props(mediator).notices == nil)
        #expect(props(mediator).character.badge == nil)
    }

    @Test("メニューの「すべて既読」「すべて確認」は、未読があるときだけ効く")
    func menuCommands() {
        var notice = Fixture.message("n1", kind: "notice", text: "架空のお知らせ")
        notice["about"] = ["e1"]
        var mediator = synced(messages: [Fixture.message("r1"), notice], readThrough: nil, unread: 1, unacknowledged: ["n1"])
        #expect(props(mediator).menu.canReadAllReplies)
        #expect(props(mediator).menu.canAcknowledgeAllNotices)
        #expect(sent(mediator.handle(.readAllRepliesRequested)).count == 1)
        #expect(sent(mediator.handle(.acknowledgeAllNoticesRequested)).count == 1)
        #expect(props(mediator).menu.canReadAllReplies == false)
        #expect(props(mediator).menu.canAcknowledgeAllNotices == false)
        #expect(sent(mediator.handle(.readAllRepliesRequested)).isEmpty)
    }

    // MARK: - Server, login and settings

    @Test("サーバーが未設定なら、ログインを始めずに設定を促す")
    func loginWithoutServer() {
        var mediator = launched(server: nil, hasSession: false)
        #expect(props(mediator).settings.statusText == ConnectionStatus.needsServer.text)
        #expect(mediator.handle(.loginRequested).isEmpty)
        #expect(props(mediator).settings.statusText == ConnectionStatus.needsServer.text)
    }

    @Test("ログインを始めてから、失敗のわけを設定に出す")
    func loginFails() {
        var mediator = launched(hasSession: false)
        #expect(mediator.handle(.loginRequested) == [.startLogin])
        #expect(props(mediator).settings.statusText == ConnectionStatus.loggingIn.text)
        _ = mediator.handle(.loginFinished(.failed("ログインできませんでした（架空）")))
        #expect(props(mediator).settings.lastError == "ログインできませんでした（架空）")
        #expect(props(mediator).settings.statusText == ConnectionStatus.needsLogin.text)

        _ = mediator.handle(.loginRequested)
        _ = mediator.handle(.loginFinished(.cancelled))
        #expect(props(mediator).settings.statusText == ConnectionStatus.needsLogin.text)
    }

    @Test("ログアウトで接続を切り、会話を捨てる")
    func logout() {
        var mediator = synced(messages: [Fixture.message("r1")], readThrough: "r1")
        _ = mediator.handle(.historyOpenRequested)
        #expect(props(mediator).conversation?.history?.rows.count == 1)
        let effects = mediator.handle(.logoutRequested)
        #expect(effects.contains(.disconnect))
        #expect(effects.contains(.logout))
        #expect(props(mediator).conversation?.history?.rows.isEmpty == true)
        #expect(props(mediator).menu.canLogout == false)
    }

    @Test("接続先を保存するとつなぎ直し、誤った URL は保存せずに直し方を出す")
    func saveServer() {
        var mediator = launched()
        let effects = mediator.handle(.serverSubmitted("https://another.example.net"))
        #expect(effects.contains(.saveServerAddress(try! ServerAddress("https://another.example.net"))))
        #expect(effects.contains(.resumeSession))
        #expect(props(mediator).settings.serverOrigin == "https://another.example.net")
        #expect(props(mediator).settings.message == "保存しました")

        _ = mediator.handle(.serverSubmitted("http://example.net"))
        #expect(props(mediator).settings.serverOrigin == "https://another.example.net")
        #expect(props(mediator).settings.message?.contains("ループバック") == true)

        _ = mediator.handle(.serverSubmitted("だめな文字列"))
        #expect(props(mediator).settings.message?.contains("https://ホスト名") == true)
    }

    @Test("同じ接続先を保存し直しても、つなぎ直さない")
    func saveSameServer() {
        var mediator = launched()
        #expect(mediator.handle(.serverSubmitted(Self.server)).isEmpty)
        #expect(props(mediator).settings.message == "保存しました")
    }

    // MARK: - Size and avatar

    @Test("倍率は変わったときだけ保存する")
    func sizes() {
        var mediator = launched()
        #expect(mediator.handle(.characterScaleChanged(CharacterScale(1.5))) == [.saveCharacterScale(CharacterScale(1.5))])
        #expect(props(mediator).character.scale == CharacterScale(1.5))
        #expect(mediator.handle(.characterScaleChanged(CharacterScale(1.5))).isEmpty)
    }

    @Test("起動時に読んだ一列の幅と会話のウインドウは、そのまま描画に使う")
    func launchInfo() {
        var mediator = UIMediator { "r" }
        let window = ConversationWindow(
            origin: CGPoint(x: 30, y: 40), width: 400, foldedHeight: 150, unfoldedHeight: 600, showsHistory: true)
        _ = mediator.handle(.launched(LaunchInfo(
            characterScale: .default, columnWidth: 360, conversationWindow: window, serverOrigin: nil)))
        #expect(props(mediator).balloon == nil)
        #expect(mediator.state.columnWidth == 360)
        #expect(mediator.handle(.characterClicked) == [.focusInput])
        #expect(props(mediator).conversation?.frame == CGRect(x: 30, y: 40, width: 400, height: 600))
        #expect(props(mediator).conversation?.history != nil)
    }

    // MARK: - Connection

    @Test("接続の状態は接続の状態機械から決まり、会話のウインドウの案内になる")
    func status() {
        var mediator = launched()
        #expect(props(mediator).character.disconnectedHelp == ConnectionStatus.connecting.text)
        _ = mediator.handle(.socketOpened)
        _ = mediator.handle(.socketReceived(Fixture.snapshot(seq: 1, requestId: "r1", deviceId: "device-1")))
        #expect(props(mediator).character.disconnectedHelp == nil)

        _ = mediator.handle(.characterClicked)
        #expect(props(mediator).conversation?.status == StatusProps(text: ConnectionStatus.connected.text, action: nil))

        let effects = mediator.handle(.socketClosed(.code(1008)))
        #expect(effects.contains(.clearSession))
        #expect(props(mediator).conversation?.status
            == StatusProps(text: ConnectionStatus.needsLogin.text, action: ActionProps(title: "GitHub でログイン", event: .loginRequested)))
    }

    @Test("接続に使う資格が無くなったら、ログインを求めて止まる")
    func credentialsMissing() {
        var mediator = launched()
        _ = mediator.handle(.credentialsMissing)
        #expect(props(mediator).character.disconnectedHelp == ConnectionStatus.needsLogin.text)
        #expect(props(mediator).menu.showsLogin)
    }

    @Test("再接続の待ちは、指示どおりに時間を置いてから接続し直す")
    func reconnect() {
        var mediator = launched()
        _ = mediator.handle(.socketOpened)
        _ = mediator.handle(.socketReceived(Fixture.snapshot(seq: 1, requestId: "r1", deviceId: "device-1")))
        let closed = mediator.handle(.socketClosed(.network))
        #expect(closed == [.disconnect, .scheduleReconnect(after: 1)])
        #expect(props(mediator).character.disconnectedHelp == ConnectionStatus.reconnecting.text)
        #expect(mediator.handle(.reconnectTimerFired) == [.connect])
    }

    @Test("スリープから起きたら、接続を捨ててつなぎ直し、続きから同期する。送りかけのメッセージは残る")
    func wakeResyncs() {
        var mediator = synced()
        _ = mediator.handle(.inputSubmitted("架空のメッセージ"))
        #expect(mediator.handle(.systemWoke) == [.disconnect, .connect])
        #expect(props(mediator).character.disconnectedHelp == ConnectionStatus.connecting.text)
        let sync = try! #require(sent(mediator.handle(.socketOpened)).first)
        guard case .sessionSync(let resume) = sync.command else { Issue.record("同期を頼んでいない"); return }
        #expect(resume != nil)
        #expect(mediator.state.conversation.outbox.map(\.text) == ["架空のメッセージ"])
    }

    @Test("再接続を待っている間に起きたら、待たずにつなぎ直す。ログインしていなければ何もしない")
    func wakeSkipsTheReconnectWait() {
        var mediator = synced()
        _ = mediator.handle(.socketClosed(.network))
        #expect(mediator.handle(.systemWoke) == [.disconnect, .connect])
        var loggedOut = launched(hasSession: false)
        #expect(loggedOut.handle(.systemWoke).isEmpty)
    }

    @Test("終了は、終了の指示だけを出す")
    func quit() {
        var mediator = launched()
        #expect(mediator.handle(.quitRequested) == [.terminate])
    }

    // MARK: - The global shortcut

    @Test("起動したら覚えているショートカットを登録する。「なし」なら登録しない")
    func registersTheShortcutAtLaunch() {
        var mediator = UIMediator()
        let effects = mediator.handle(.launched(LaunchInfo(
            characterScale: .default, serverOrigin: nil)))
        #expect(effects.contains(.registerHotKey(.default)))
        #expect(props(mediator).settings.hotKey == "⌃⌥N")

        var none = UIMediator()
        let quiet = none.handle(.launched(LaunchInfo(
            characterScale: .default, hotKey: nil, serverOrigin: nil)))
        #expect(!quiet.contains { if case .registerHotKey = $0 { true } else { false } })
        #expect(props(none).settings.hotKey == "なし")
    }

    @Test("ショートカットで会話のウインドウを出して入力欄に焦点を移す。出ていれば消さずに前に出して焦点を移す")
    func shortcutShowsTheConversation() {
        var mediator = placed()
        let opened = mediator.handle(.hotKeyPressed)
        #expect(props(mediator).conversation != nil)
        #expect(opened.first == .focusInput)
        #expect(mediator.handle(.hotKeyPressed) == [.focusInput])
        #expect(props(mediator).conversation != nil)
    }

    @Test("記録を始めると登録を外し、押したキーを保存して登録し直す")
    func recordsAShortcut() {
        var mediator = launched()
        _ = mediator.handle(.settingsOpenRequested)
        #expect(mediator.handle(.hotKeyRecordingRequested) == [.registerHotKey(nil)])
        #expect(props(mediator).settings.isRecordingHotKey)
        let key = HotKey(keyCode: 49, modifiers: [.command, .option])
        #expect(mediator.handle(.hotKeyRecorded(key)) == [.saveHotKey(key), .registerHotKey(key)])
        #expect(!props(mediator).settings.isRecordingHotKey)
        #expect(props(mediator).settings.hotKey == "⌥⌘Space")
        // Nothing is recorded while not recording.
        #expect(mediator.handle(.hotKeyRecorded(.default)).isEmpty)
    }

    @Test("⌘・⌃・⌥ の無いキーは受け付けず、記録を続ける")
    func rejectsAnUnusableShortcut() {
        var mediator = launched()
        _ = mediator.handle(.hotKeyRecordingRequested)
        #expect(mediator.handle(.hotKeyRecorded(HotKey(keyCode: HotKey.KeyCode.n, modifiers: [.shift]))).isEmpty)
        #expect(props(mediator).settings.isRecordingHotKey)
        #expect(props(mediator).settings.hotKeyMessage == "⌘・⌃・⌥ のどれかと組み合わせてください")
    }

    @Test("記録をやめる（Esc・設定を閉じる）と元のショートカットを登録し直す")
    func cancelsRecording() {
        var mediator = launched()
        _ = mediator.handle(.hotKeyRecordingRequested)
        #expect(mediator.handle(.hotKeyRecordingCancelled) == [.registerHotKey(.default)])
        #expect(!props(mediator).settings.isRecordingHotKey)
        #expect(mediator.handle(.hotKeyRecordingCancelled).isEmpty)

        _ = mediator.handle(.hotKeyRecordingRequested)
        #expect(mediator.handle(.settingsCloseRequested) == [.registerHotKey(.default), .hideSettings])
    }

    @Test("「なし」で外し、「既定に戻す」で ⌃⌥N に戻す")
    func clearsAndResets() {
        var mediator = launched()
        #expect(!props(mediator).settings.canResetHotKey)
        #expect(mediator.handle(.hotKeyCleared) == [.saveHotKey(nil), .registerHotKey(nil)])
        #expect(props(mediator).settings.hotKey == "なし")
        #expect(!props(mediator).settings.canClearHotKey)
        #expect(mediator.handle(.hotKeyResetRequested) == [.saveHotKey(.default), .registerHotKey(.default)])
        #expect(props(mediator).settings.hotKey == "⌃⌥N")
    }

    @Test("ほかのアプリが使っていて登録できなければ、設定にそう出す。次に登録できれば消す")
    func reportsAFailedRegistration() {
        var mediator = launched()
        #expect(mediator.handle(.hotKeyRegistrationFailed(.default)).isEmpty)
        #expect(props(mediator).settings.hotKeyMessage == "⌃⌥N はほかのアプリが使っているため登録できませんでした")
        _ = mediator.handle(.hotKeyRecordingRequested)
        _ = mediator.handle(.hotKeyRecorded(HotKey(keyCode: 49, modifiers: [.control])))
        #expect(props(mediator).settings.hotKeyMessage == nil)
    }
}
