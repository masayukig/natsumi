import CoreGraphics
import Foundation
import Testing
@testable import NatsumiCore

@Suite("描画パラメータの導出")
struct PropsTests {
    private func owner(_ id: String, event: String) -> ShownMessage {
        ShownMessage(messageId: id, role: .owner, kind: .message, text: "やあ", createdAt: "2026-01-01T00:00:00.000Z", eventId: event)
    }

    private func reply(_ id: String, to event: String = "e0", text: String = "こんにちは", feeling: NatsumiCore.Expression? = nil) -> ShownMessage {
        ShownMessage(
            messageId: id, role: .natsumi, kind: .reply, text: text, createdAt: "2026-01-01T00:00:01.000Z", replyTo: event,
            expression: feeling)
    }

    private func notice(_ id: String, text: String = "架空のお知らせ") -> ShownMessage {
        ShownMessage(messageId: id, role: .natsumi, kind: .notice, text: text, createdAt: "2026-01-01T00:00:02.000Z")
    }

    private func conversation(
        _ messages: [ShownMessage], readThrough: String? = nil, unread: Int = 0, notices: [String] = [],
        pending: [PendingEvent] = []
    ) -> ConversationState {
        var state = ConversationState()
        state.apply(.snapshot(Snapshot(
            deviceId: "d", messages: messages, pendingEvents: pending, expression: .neutral,
            readState: ReadState(
                readThroughMessageId: readThrough, unreadReplyCount: unread, unacknowledgedNotificationIds: notices))))
        return state
    }

    private func balloon(
        _ conversation: ConversationState, dismissed: Bool = false, readingHistory: Bool = false,
        placement: ColumnPlacement = ColumnPlacement()
    ) -> BalloonProps? {
        UIProps.balloon(
            conversation, dismissed: dismissed, readingHistory: readingHistory, placement: placement,
            scale: .default)
    }

    private func thinking(_ label: String, line: String? = nil) -> BalloonProps.Body {
        .thinking(ThinkingProps(label: label, line: line))
    }

    private func notices(
        _ conversation: ConversationState, hidden: Bool = false, placement: ColumnPlacement = ColumnPlacement()
    ) -> NoticeBundleProps? {
        UIProps.notices(conversation, hidden: hidden, placement: placement, scale: .default)
    }

    // MARK: - The balloon

    @Test("何も話していなければ、吹き出しは出さない")
    func hiddenWhenEmpty() {
        #expect(balloon(ConversationState()) == nil)
    }

    @Test("未読の最後の返事を 1 件だけ出し、未読の件数を持つ。本人のメッセージと知らせは入れない")
    func lastReply() {
        let state = conversation(
            [reply("r0"), owner("m1", event: "e1"), reply("r3", to: "e1"), reply("r4"), reply("r5"), reply("r6"), notice("n7")],
            readThrough: "r0", unread: 4)
        #expect(UIProps.unreadReply(state) == reply("r6"))
        let props = balloon(state)
        #expect(props?.body == .reply(ReplyProps(
            text: "こんにちは", lineLimit: BalloonText.maxLines, showsHistoryLink: false, unread: 4,
            help: "クリックで全文を出す")))
        #expect(props?.closeHelp == "既読にして閉じる")
        // A reply is said out loud: it keeps the speech balloon.
        #expect(props?.outline == .speech)
    }

    @Test("最後の返事が既読なら、吹き出しは出さない")
    func readLastReply() {
        let state = conversation([reply("r1"), reply("r2")], readThrough: "r2")
        #expect(UIProps.unreadReply(state) == nil)
        #expect(balloon(state) == nil)
    }

    @Test("履歴を読んでいる間は返事を出さないが、考え中は出す")
    func readingHistory() {
        var state = conversation([reply("r1")], readThrough: nil, unread: 1)
        #expect(balloon(state, readingHistory: true) == nil)
        #expect(balloon(state, readingHistory: false) != nil)
        state.enqueue(text: "やあ", requestId: "q1")
        #expect(balloon(state, readingHistory: true)?.body == thinking("受付中"))
    }

    @Test("一覧より古い未読も、件数には入る")
    func olderUnread() {
        let state = conversation([reply("r5"), reply("r6")], readThrough: "r0", unread: 5)
        #expect(UIProps.unreadReply(state) == reply("r6"))
        #expect(balloon(state)?.body == .reply(ReplyProps(
            text: "こんにちは", lineLimit: BalloonText.maxLines, showsHistoryLink: false, unread: 5,
            help: "クリックで全文を出す")))
    }

    @Test("高さが足りないときは、行数を減らし、続きを履歴へ送る")
    func budget() {
        let state = conversation([reply("r1"), reply("r2"), reply("r3")], readThrough: nil, unread: 3)
        var placement = ColumnPlacement()
        placement.budget = StackBudget(behind: 0, lines: 2)
        #expect(balloon(state, placement: placement)?.body == .reply(ReplyProps(
            text: "こんにちは", lineLimit: 2, showsHistoryLink: true, unread: 3, help: "クリックで全文を出す")))
    }

    @Test("長い発言は切って、続きは履歴で読めることを示す")
    func truncated() {
        let long = String(repeating: "あ", count: BalloonText.maxCharacters + 10)
        let state = conversation([reply("r1", text: long)], readThrough: nil, unread: 1)
        #expect(balloon(state)?.body == .reply(ReplyProps(
            text: String(repeating: "あ", count: BalloonText.maxCharacters) + "…", lineLimit: BalloonText.maxLines,
            showsHistoryLink: true, unread: 1, help: "クリックで全文を出す")))
    }

    @Test("開いたカードは横にも広がり、閉じているカードは今までの幅のまま")
    func expandedIsWider() {
        let screen = CGRect(x: 0, y: 0, width: 1710, height: 950)
        let column = OverlaySettings.defaultColumnWidth
        let wide = OverlayLayout.expandedWidth(column, visible: screen)
        #expect(wide == column * OverlayLayout.expandedWidthFactor)
        // 画面が狭ければ、そこで止まる。
        let narrow = CGRect(x: 0, y: 0, width: 400, height: 900)
        #expect(OverlayLayout.expandedWidth(column, visible: narrow) == 400 - OverlayLayout.expandedSideMargin * 2)
        // 画面の端にいても同じだけ広がる。はみ出す分は配置が内側にずらし、しっぽはキャラクターの中心を指したままになる。
        let atEdge = CGRect(x: 1493, y: 90, width: 192, height: 208)
        #expect(OverlayLayout.expandedWidth(column, visible: screen) == wide)
        let layout = OverlayLayout.make(
            visible: screen, character: atEdge, spacing: 8, notices: nil, balloon: CGSize(width: wide, height: 120))
        #expect(layout.balloon?.maxX == screen.maxX)
        #expect(layout.balloon.map { $0.minX + layout.tailX } == atEdge.midX)

        var placement = ColumnPlacement()
        placement.budget = StackBudget.expandedSteps[0]
        placement.width = column
        placement.expandedWidth = wide
        let state = conversation([reply("r1"), notice("n1")], readThrough: nil, unread: 1, notices: ["n1"])
        #expect(UIProps.balloon(state, dismissed: false, expanded: .reply("r1"), placement: placement, scale: .default)?
            .width == wide)
        #expect(UIProps.balloon(state, dismissed: false, expanded: nil, placement: placement, scale: .default)?
            .width == column)
        #expect(UIProps.notices(state, hidden: false, expanded: .notice("n1"), placement: placement, scale: .default)?
            .width == wide)
        #expect(UIProps.notices(state, hidden: false, expanded: nil, placement: placement, scale: .default)?
            .width == column)
    }

    @Test("拡大した返事は全文を出し、切られていなければ履歴へは誘導しない")
    func expandedReply() {
        let long = String(repeating: "あ", count: BalloonText.maxCharacters + 10)
        let state = conversation([reply("r1", text: long)], readThrough: nil, unread: 1)
        var placement = ColumnPlacement()
        placement.budget = StackBudget.expandedSteps[0]
        let props = UIProps.balloon(
            state, dismissed: false, expanded: .reply("r1"), placement: placement, scale: .default)
        #expect(props?.body == .reply(ReplyProps(
            text: long, lineLimit: BalloonText.expandedMaxLines, isExpanded: true, showsHistoryLink: false, unread: 1,
            help: "クリックで畳む")))
    }

    @Test("拡大しても画面に入らないときは、そこで切って「続きは履歴で」を出したままにする")
    func expandedReplyStillCut() {
        let many = (1...(BalloonText.expandedMaxLines + 5)).map { "行\($0)" }.joined(separator: "\n")
        let state = conversation([reply("r1", text: many)], readThrough: nil, unread: 1)
        var placement = ColumnPlacement()
        placement.budget = StackBudget(behind: 0, lines: 12)
        let props = UIProps.balloon(
            state, dismissed: false, expanded: .reply("r1"), placement: placement, scale: .default)
        #expect(props?.body == .reply(ReplyProps(
            text: many, lineLimit: 12, isExpanded: true, showsHistoryLink: true, unread: 1, help: "クリックで畳む")))
    }

    @Test("拡大していない側のカードは、切った本文と 5 行までのまま")
    func othersKeepThePreview() {
        let long = String(repeating: "あ", count: BalloonText.maxCharacters + 10)
        let state = conversation([reply("r1"), notice("n1", text: long)], readThrough: nil, unread: 1, notices: ["n1"])
        var placement = ColumnPlacement()
        placement.budget = StackBudget.expandedSteps[0]
        let props = UIProps.notices(
            state, hidden: false, expanded: .reply("r1"), placement: placement, scale: .default)
        #expect(props?.isExpanded == false)
        #expect(props?.lineLimit == BalloonText.maxLines)
        #expect(props?.text == String(repeating: "あ", count: BalloonText.maxCharacters) + "…")
        #expect(props?.showsHistoryLink == true)
    }

    @Test("拡大したときの行数の梯子は、上から下へ狭くなる")
    func expandedLadder() {
        #expect(StackBudget.expandedSteps.first?.lines == BalloonText.expandedMaxLines)
        #expect(StackBudget.expandedSteps.last == StackBudget.steps.last)
        #expect(StackBudget.expandedSteps.map(\.lines) == StackBudget.expandedSteps.map(\.lines).sorted(by: >))
    }

    @Test("処理待ちがある間は、処理の前からの未読の返事を隠して考え中の吹き出しに切り替える")
    func indicators() {
        var state = conversation([reply("r0")], readThrough: "r0")
        state.enqueue(text: "やあ", requestId: "q1")
        #expect(balloon(state)?.body == thinking("受付中"))
        #expect(balloon(state)?.outline == .thought)
        #expect(balloon(state)?.closeHelp == "閉じる")

        state.apply(.accepted(CommandAccepted(messageId: "m1", eventId: "e1", state: .processing)), requestId: "q1")
        #expect(balloon(state)?.body == thinking("考え中"))

        // A notice is not a reply: the balloon keeps thinking.
        state.apply(.message(notice("n1")))
        #expect(balloon(state)?.body == thinking("考え中"))

        // A reply left from before she began waits: it is not the answer the owner is waiting for (ADR 0025).
        var old = conversation([reply("r0")], unread: 1)
        old.enqueue(text: "やあ", requestId: "q1")
        #expect(balloon(old)?.body == thinking("受付中"))
        old.apply(.accepted(CommandAccepted(messageId: "m1", eventId: "e1", state: .processing)), requestId: "q1")
        old.apply(.message(owner("m1", event: "e1")))
        #expect(balloon(old)?.body == thinking("考え中"))
        old.apply(.eventCompleted(EventCompletion(eventId: "e1", messageId: "m1", status: .noReply, reason: nil)))
        #expect(balloon(old)?.outline == .speech)
        if case .reply = balloon(old)?.body {} else { Issue.record("返事に戻っていない") }
    }

    @Test("処理の中で届いた返事は出し、その下に考えている 1 行を足す")
    func replyWhileThinking() {
        var state = conversation(
            [reply("r0"), owner("m1", event: "e1")], readThrough: "r0",
            pending: [PendingEvent(eventId: "e1", messageId: "m1", state: .processing)])
        state.apply(.thinking(line: "まず要点を整理する"))
        #expect(balloon(state)?.body == thinking("考え中", line: "まず要点を整理する"))

        state.apply(.message(reply("r2", to: "e1")))
        #expect(UIProps.shownReply(state, readingHistory: false)?.messageId == "r2")
        let props = balloon(state)
        #expect(props?.outline == .speech)
        #expect(props?.closeHelp == "既読にして閉じる")
        guard case .reply(let shown) = props?.body else { Issue.record("返事が出ていない"); return }
        #expect(shown.text == "こんにちは")
        #expect(shown.thinking == ThinkingProps(label: "考え中", line: "まず要点を整理する"))

        // Closing the thought bubble for this handling takes the row away, not the reply.
        guard case .reply(let closed) = balloon(state, dismissed: true)?.body else { Issue.record("返事が出ていない"); return }
        #expect(closed.thinking == nil)

        // When she has finished, the row goes and the reply stays.
        state.apply(.eventCompleted(EventCompletion(eventId: "e1", messageId: "m1", status: .replied, reason: nil)))
        guard case .reply(let done) = balloon(state)?.body else { Issue.record("返事が出ていない"); return }
        #expect(done.thinking == nil)
    }

    @Test("処理の中で届いたかどうかは、処理待ちの最も古い本人のメッセージより後ろかで決める")
    func fromCurrentHandling() {
        let state = conversation(
            [reply("r0"), owner("m1", event: "e1"), reply("r2", to: "e1"), owner("m3", event: "e3"), reply("r4", to: "e3")],
            pending: [PendingEvent(eventId: "e3", messageId: "m3", state: .processing)])
        #expect(!state.isFromCurrentHandling(reply("r0")))
        #expect(!state.isFromCurrentHandling(reply("r2", to: "e1")))
        #expect(state.isFromCurrentHandling(reply("r4", to: "e3")))
        // Nothing is being handled: nothing came during it.
        let idle = conversation([owner("m1", event: "e1"), reply("r2", to: "e1")])
        #expect(!idle.isFromCurrentHandling(reply("r2", to: "e1")))
    }

    @Test("思考の行が届けば行を出し、無ければ点滅のままにする")
    func thinkingLine() {
        var state = conversation(
            [owner("m1", event: "e1")], readThrough: "m1",
            pending: [PendingEvent(eventId: "e1", messageId: "m1", state: .processing)])
        #expect(balloon(state)?.body == thinking("考え中"))

        state.apply(.thinking(line: "まず要点を整理する"))
        #expect(balloon(state)?.body == thinking("考え中", line: "まず要点を整理する"))
        // The line is never cut here: the balloon draws one line of it and cuts what does not fit.
        let long = String(repeating: "あ", count: 200)
        state.apply(.thinking(line: long))
        #expect(balloon(state)?.body == thinking("考え中", line: long))
        #expect(balloon(state)?.outline == .thought)

        state.apply(.thinking(line: ""))
        #expect(balloon(state)?.body == thinking("考え中"))
    }

    @Test("閉じた考え中は出さないが、未読の返事は出し続ける")
    func dismissed() {
        var working = conversation(
            [owner("m1", event: "e1")], readThrough: "m1",
            pending: [PendingEvent(eventId: "e1", messageId: "m1", state: .processing)])
        #expect(balloon(working, dismissed: true) == nil)
        #expect(balloon(working, dismissed: false)?.body == thinking("考え中"))
        // A new line is the same handling still going on: it does not bring the bubble back.
        working.apply(.thinking(line: "考えている"))
        #expect(balloon(working, dismissed: true) == nil)

        let unread = conversation([reply("r1")], readThrough: nil, unread: 1)
        #expect(balloon(unread, dismissed: true)?.body != nil)
    }

    @Test("長い発言は文字数と行数で切り、続きがあることを示す")
    func preview() {
        #expect(BalloonText.preview("  こんにちは\n") == BalloonText(text: "こんにちは", isTruncated: false))

        let long = String(repeating: "あ", count: BalloonText.maxCharacters + 10)
        let cut = BalloonText.preview(long)
        #expect(cut.isTruncated)
        #expect(cut.text == String(repeating: "あ", count: BalloonText.maxCharacters) + "…")

        let lines = (1...(BalloonText.maxLines + 2)).map { "行\($0)" }.joined(separator: "\n")
        let cutLines = BalloonText.preview(lines)
        #expect(cutLines.isTruncated)
        #expect(cutLines.text == (1...BalloonText.maxLines).map { "行\($0)" }.joined(separator: "\n") + "…")
    }

    // MARK: - The notices

    @Test("未確認が無ければ、束も印も出さない")
    func noNotices() {
        let state = conversation([notice("n1")], readThrough: "n1")
        #expect(UIProps.noticeStack(state) == nil)
        #expect(notices(state) == nil)
        #expect(UIProps.character(
            UIState(session: SessionMachine(deviceId: nil)), stack: nil).badge == nil)
    }

    @Test("未確認の知らせを古い順に束にし、件数を印にする。返事は入れない")
    func noticeStack() {
        let state = conversation(
            [notice("n1"), reply("r2"), notice("n3"), notice("n4"), notice("n5")],
            readThrough: "n5", notices: ["n1", "n3", "n4", "n5"])
        let stack = UIProps.noticeStack(state)
        #expect(stack == NoticeStack(front: .notice(notice("n1")), frontIds: ["n1"], count: 4, cards: 4))
        #expect(stack?.behind == NoticeStack.maxBehind)
        let props = notices(state)
        #expect(props == NoticeBundleProps(
            text: "架空のお知らせ", lineLimit: BalloonText.maxLines, showsHistoryLink: false, more: 3,
            help: "クリックで全文を出す", closeHelp: "この知らせを確認して次へ", edges: NoticeStack.maxBehind, edgesUpward: true,
            width: ColumnPlacement().width, textScale: CharacterScale.default.textScale))
    }

    @Test("一覧の外の知らせは、本文の無い 1 枚にまとめ、履歴へは誘導しない")
    func olderNotices() {
        let state = conversation([reply("r4"), notice("n5")], readThrough: "n5", notices: ["n1", "n2", "n5"])
        let stack = UIProps.noticeStack(state)
        #expect(stack == NoticeStack(front: .older(ids: ["n1", "n2"]), frontIds: ["n1", "n2"], count: 3, cards: 2))
        #expect(stack?.more == 1)
        let props = notices(state)
        #expect(props?.text == "前の知らせが 2 件あります（本文は履歴より前のため出せません）")
        #expect(props?.showsHistoryLink == false)
        #expect(props?.help == "クリックでまとめて確かめる")
        // The card has no body to open, so its × means the same as a click on it.
        #expect(props?.closeHelp == "まとめて確認して次へ")
        #expect(props?.isExpanded == false)
    }

    @Test("隠している間は束を出さないが、印は件数を出し続ける")
    func hiddenNotices() {
        let state = conversation([notice("n1")], readThrough: "n1", notices: ["n1"])
        #expect(notices(state, hidden: true) == nil)
        #expect(notices(state, hidden: false) != nil)
    }

    @Test("一列を反転すると、後ろのカードはキャラから離れる向きに動く")
    func flippedNotices() {
        let state = conversation([notice("n1"), notice("n2")], readThrough: "n2", notices: ["n1", "n2"])
        var placement = ColumnPlacement()
        placement.tail = .up
        #expect(notices(state, placement: placement)?.edgesUpward == false)
        #expect(notices(state)?.edgesUpward == true)
    }

    @Test("印は、キャラの右上に、倍率に合わせた大きさで置く")
    func badgeFrame() {
        #expect(CharacterBadge.frame(for: CharacterScale(1)) == CGRect(x: 96 - 22, y: 0, width: 22, height: 22))
        #expect(CharacterBadge.frame(for: CharacterScale(2)) == CGRect(x: 192 - 44, y: 0, width: 44, height: 44))
        // Small characters keep a badge large enough to read and click.
        #expect(CharacterBadge.frame(for: CharacterScale(0.5)) == CGRect(x: 48 - 14, y: 0, width: 14, height: 14))
    }

    // MARK: - The conversation window

    @Test("送れなかった送信は畳んだウインドウでは入力欄の上に、開いたウインドウでは受付中と併せて履歴に出る")
    func failures() {
        var state = ConversationState()
        state.enqueue(text: "架空のメッセージ", requestId: "q1")
        state.enqueue(text: "もう一つ", requestId: "q2")
        state.apply(.rejected(code: "invalid"), requestId: "q2")
        #expect(UIProps.failures(state) == [FailureProps(requestId: "q2", text: "「もう一つ」を送れませんでした（invalid）")])

        let history = UIProps.history(state, time: .example)
        #expect(history.outgoing == [
            OutgoingRowProps(requestId: "q1", text: "架空のメッセージ", failure: nil),
            OutgoingRowProps(requestId: "q2", text: "もう一つ", failure: "送れませんでした（invalid）"),
        ])
    }

    @Test("履歴は未読の返事と未確認の知らせに印を付ける")
    func historyRows() {
        let state = conversation(
            [owner("m1", event: "e1"), reply("r2", to: "e1"), notice("n3")],
            readThrough: "m1", unread: 1, notices: ["n3"])
        let rows = UIProps.history(state, time: .example, name: "なつみ").rows
        #expect(rows == [
            HistoryRowProps(
                messageId: "m1", text: "やあ", time: "1/1 9:00", isOwner: true, isNotice: false, isUnread: false),
            HistoryRowProps(
                messageId: "r2", text: "こんにちは", time: "1/1 9:00", isOwner: false, isNotice: false,
                isUnread: true, face: FaceProps(expression: nil, isLarge: false, help: "気持ちの記録なし"), speaker: "なつみ"),
            HistoryRowProps(
                messageId: "n3", text: "架空のお知らせ", time: "1/1 9:00", isOwner: false, isNotice: true,
                isUnread: true, face: FaceProps(expression: nil, isLarge: true, help: "気持ちの記録なし"), speaker: "なつみ"),
        ])
    }

    @Test("natsumi のセリフには気持ちの顔を添え、いちばん新しいセリフの顔だけを大きくする")
    func historyFaces() {
        let state = conversation([
            reply("r1", feeling: .happy), owner("m2", event: "e2"), reply("r3", to: "e2", feeling: .worried),
            owner("m4", event: "e4"),
        ])
        let faces = UIProps.history(state, time: .example).rows.map(\.face)
        #expect(faces == [
            FaceProps(expression: .happy, isLarge: false, help: "気持ち: うれしい"),
            nil,
            // The newest of her lines, even with the owner's message after it.
            FaceProps(expression: .worried, isLarge: true, help: "気持ち: 心配"),
            nil,
        ])
        #expect(UIProps.history(conversation([owner("m1", event: "e1")]), time: .example).rows.map(\.face) == [nil])
    }

    @Test("履歴の時刻は、今日なら時刻だけ、今年なら月日と時刻、それより前なら年も付ける")
    func historyTimes() {
        // The example's now is 2026-09-22 15:00 in Tokyo. The history is in time order.
        let labels = MessageTime.example.labels([
            "2025-12-31T14:59:00.000Z", "2026-01-01T00:05:00.000Z", "2026-01-01T00:06:00Z", "いつか",
            "2026-09-21T14:59:00.000Z", "2026-09-21T15:00:00Z", "2026-09-22T05:32:00.000Z",
        ].map(parseTimestamp))
        #expect(labels == ["2025/12/31 23:59", "1/1 9:05", "1/1 9:06", nil, "9/21 23:59", "0:00", "14:32"])
    }

    @Test("夏時間の変わる日も、その日の時計の時刻で書く")
    func historyTimesAcrossDaylightSaving() {
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = TimeZone(identifier: "America/New_York")!
        let time = MessageTime(now: parseTimestamp("2026-09-22T12:00:00Z")!, calendar: calendar)
        // 2026-03-08 is 23 hours long in New York: the clocks go from 2:00 to 3:00.
        let labels = time.labels(["2026-03-08T06:30:00Z", "2026-03-08T07:30:00Z", "2026-03-08T15:30:00Z"].map(parseTimestamp))
        #expect(labels == ["3/8 1:30", "3/8 3:30", "3/8 11:30"])
    }

    @Test("届いたメッセージの時刻は、受け取ったときに一度だけ読む")
    func messageDate() {
        #expect(reply("r1").date == parseTimestamp("2026-01-01T00:00:01.000Z"))
        let odd = ShownMessage(messageId: "x", role: .natsumi, kind: .reply, text: "", createdAt: "いつか")
        #expect(odd.date == nil)
    }

    @Test("接続の案内は常にあり、状態ごとに次の一手を持つ")
    func statusRow() {
        func action(_ status: ConnectionStatus) -> ActionProps? { UIProps.statusRow(status).action }
        #expect(UIProps.statusRow(.connected) == StatusProps(text: ConnectionStatus.connected.text, action: nil))
        #expect(action(.needsServer) == ActionProps(title: "設定を開く", event: .settingsOpenRequested))
        #expect(action(.needsLogin) == ActionProps(title: "GitHub でログイン", event: .loginRequested))
        #expect(action(.stopped) == ActionProps(title: "接続し直す", event: .reconnectRequested))
        #expect(action(.unavailable("架空")) == ActionProps(title: "接続し直す", event: .reconnectRequested))
        #expect(action(.replaced) == ActionProps(title: "接続し直す", event: .reconnectRequested))
        #expect(action(.connecting) == nil)
    }
}
