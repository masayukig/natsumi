import Foundation
import Testing
@testable import NatsumiCore

@Suite("iPhone の承認の画面")
struct PhoneApprovalTests {
    private func synced(_ approvals: [[String: Any]] = [Fixture.approval("a1")]) -> PhoneMediator {
        var counter = 0
        var mediator = PhoneMediator {
            counter += 1
            return "r\(counter)"
        }
        _ = mediator.handle(.launched(serverOrigin: "https://natsumi.example.net"))
        _ = mediator.handle(.avatarLoaded(Fixture.receivedAvatar))
        _ = mediator.handle(.sessionResumed(hasSession: true, deviceId: nil))
        _ = mediator.handle(.socketOpened)
        _ = mediator.handle(.socketReceived(Fixture.snapshot(seq: 1, requestId: "r1", deviceId: "device-1", approvals: approvals)))
        return mediator
    }

    private func main(_ mediator: PhoneMediator) -> PhoneMainProps? {
        if case .main(let props) = PhoneProps.root(mediator.state, time: .example).screen { props } else { nil }
    }

    private func list(_ mediator: PhoneMediator) -> PhoneApprovalListProps? {
        if case .approvals(let props) = main(mediator)?.page { props } else { nil }
    }

    private func page(_ mediator: PhoneMediator) -> PhoneApprovalPageProps? {
        if case .approval(let props, _) = main(mediator)?.page { props } else { nil }
    }

    private func detail(_ mediator: PhoneMediator) -> PhoneApprovalDetailProps? {
        if case .detail(let props) = page(mediator) { props } else { nil }
    }

    private func sent(_ effects: [PhoneEffect]) -> [ClientCommand] {
        effects.compactMap { if case .sendToServer(let envelope) = $0 { envelope.command } else { nil } }
    }

    private func tidies(_ effects: [PhoneEffect]) -> [PushTidy] {
        effects.compactMap { if case .tidyNotifications(let tidy) = $0 { tidy } else { nil } }
    }

    // MARK: - The way in

    @Test("会話の画面に承認待ちの件数を出す。無ければ出さず、書いている間も出さない")
    func entry() {
        var mediator = synced([Fixture.approval("a1"), Fixture.approval("a2")])
        #expect(main(mediator)?.approvals == PhoneApprovalEntryProps(text: "承認待ち 2 件"))
        _ = mediator.handle(.inputFocusChanged(true))
        #expect(main(mediator)?.approvals == nil)
        #expect(main(synced([]))?.approvals == nil)
    }

    @Test("件数から一覧を開き、行から詳細を開く。戻ると一覧、もう一度戻ると会話の画面")
    func navigation() {
        var mediator = synced()
        _ = mediator.handle(.approvalsOpenRequested)
        let rows = try! #require(list(mediator)).rows
        #expect(rows == [PhoneApprovalRowProps(
            approvalId: "a1", channel: "work/#dev", text: "明日の 10 時で大丈夫です。", reason: "判定で回った",
            time: "14:30", status: nil)])

        _ = mediator.handle(.approvalOpenRequested(approvalId: "a1"))
        #expect(detail(mediator)?.approvalId == "a1")
        _ = mediator.handle(.approvalClosed)
        #expect(list(mediator) != nil)
        _ = mediator.handle(.pageClosed)
        #expect(main(mediator)?.page == nil)
    }

    @Test("一覧の行は、下書きの 1 行目と回った理由を出す")
    func rowReasons() {
        var mediator = synced([
            Fixture.approval("a1", text: "1 行目\n2 行目", verdict: "no-verdict"),
            Fixture.approval("a2", verdict: "rewrite-limit"),
        ])
        _ = mediator.handle(.approvalsOpenRequested)
        let rows = list(mediator)?.rows ?? []
        #expect(rows.map(\.text) == ["1 行目", "明日の 10 時で大丈夫です。"])
        #expect(rows.map(\.reason) == ["判定なし", "3 回目の突き返し"])
    }

    // MARK: - The detail

    @Test("詳細は、返信先・置き場所・下書き・表情・理由・点数・期限を出す")
    func detailProps() {
        var mediator = synced([Fixture.approval("a1", history: [[
            "text": "明日なら何時でも大丈夫です！", "issues": [["name": "promise", "label": "本人に代わる約束・期限", "score": 0.91, "flagged": true]],
        ]])])
        _ = mediator.handle(.approvalOpenRequested(approvalId: "a1"))
        let props = try! #require(detail(mediator))
        #expect(props.channel == "work/#dev")
        #expect(props.replyTo == PhoneReplyTargetProps(
            speaker: "山田", at: "2026-09-25 14:32:05", text: "明日の打ち合わせ、何時がいいですか？"))
        #expect(props.placement == "スレッドに返す")
        #expect(props.placementOptions == [
            PhonePlacementOptionProps(title: "スレッド", placement: .thread, isSelected: true),
            PhonePlacementOptionProps(title: "チャンネル", placement: .channel, isSelected: false),
        ])
        #expect(props.placementOdds == "判定の見立て: スレッド 70%・チャンネル 30%")
        #expect(props.text == "明日の 10 時で大丈夫です。")
        #expect(props.face == .happy)
        #expect(props.reason == "判定が「本人に回す」になりました")
        #expect(props.issues == [
            PhoneIssueProps(name: "promise", label: "本人に代わる約束・期限", score: 0.82, percent: "82%", flagged: true),
            PhoneIssueProps(name: "missing-context", label: "スレッドに無い情報", score: 0.12, percent: "12%", flagged: false),
        ])
        #expect(props.history == [PhonePastDraftProps(
            index: 0, title: "1 回目の下書き", text: "明日なら何時でも大丈夫です！", flagged: "本人に代わる約束・期限")])
        #expect(props.created == "14:30")
        #expect(props.expires == "期限 9/29 14:30")
        #expect(props.controls == .choose)
        #expect(props.message == nil)
        #expect(props.result == nil)
    }

    @Test("チャンネルそのものへの投稿は、置き場所を変えられない。判定なしは点数も見立ても無い")
    func channelPost() {
        var mediator = synced([Fixture.approval(
            "a1", replyTo: nil, placement: "channel", verdict: "no-verdict", issues: [], probabilities: nil)])
        _ = mediator.handle(.approvalOpenRequested(approvalId: "a1"))
        let props = try! #require(detail(mediator))
        #expect(props.replyTo == nil)
        #expect(props.placement == "チャンネルに投稿")
        #expect(props.placementOptions == [])
        #expect(props.placementOdds == nil)
        #expect(props.reason == "判定がありませんでした")
        #expect(props.issues == [])
    }

    @Test("3 回目の突き返しは、そう書く")
    func rewriteLimit() {
        var mediator = synced([Fixture.approval("a1", verdict: "rewrite-limit")])
        _ = mediator.handle(.approvalOpenRequested(approvalId: "a1"))
        #expect(detail(mediator)?.reason == "同じ返信先で 3 回目の突き返しになりました")
    }

    @Test("知らない承認は、見つからないと出す")
    func missing() {
        var mediator = synced([])
        _ = mediator.handle(.approvalOpenRequested(approvalId: "a9"))
        #expect(page(mediator) == .missing("この承認は見つかりません。もう閉じたのかもしれません"))
    }

    // MARK: - Deciding

    @Test("承認を押すと approval.decide を送り、送っている間は選べない")
    func approve() {
        var mediator = synced()
        _ = mediator.handle(.approvalOpenRequested(approvalId: "a1"))
        #expect(sent(mediator.handle(.approvalApproved(approvalId: "a1")))
            == [.approvalDecide(approvalId: "a1", revision: 1, decision: .approve(placement: nil))])
        #expect(detail(mediator)?.controls == .waiting("送っています…"))
        // The second tap sends nothing.
        #expect(sent(mediator.handle(.approvalApproved(approvalId: "a1"))).isEmpty)

        _ = mediator.handle(.socketReceived(Fixture.envelope("command.accepted", seq: 2, requestId: "r2",
            payload: ["approvalId": "a1", "revision": 1, "state": "approved"])))
        #expect(detail(mediator)?.controls == .waiting("受け付けました。送った結果を待っています…"))
    }

    @Test("置き場所を変えて承認すると、placement を付けて送る")
    func approveWithPlacement() {
        var mediator = synced()
        _ = mediator.handle(.approvalOpenRequested(approvalId: "a1"))
        _ = mediator.handle(.approvalPlacementChosen(.channel))
        #expect(detail(mediator)?.placement == "チャンネルに投稿")
        #expect(detail(mediator)?.placementOptions.map(\.isSelected) == [false, true])
        #expect(sent(mediator.handle(.approvalApproved(approvalId: "a1")))
            == [.approvalDecide(approvalId: "a1", revision: 1, decision: .approve(placement: .channel))])
    }

    @Test("修正は本文を編集して送る。空白だけの本文は送らない。やめると元に戻る")
    func edit() {
        var mediator = synced()
        _ = mediator.handle(.approvalOpenRequested(approvalId: "a1"))
        _ = mediator.handle(.approvalEditRequested)
        #expect(detail(mediator)?.controls == .editing(draft: "明日の 10 時で大丈夫です。"))
        _ = mediator.handle(.approvalEditCancelled)
        #expect(detail(mediator)?.controls == .choose)

        _ = mediator.handle(.approvalEditRequested)
        #expect(sent(mediator.handle(.approvalEditSubmitted(approvalId: "a1", text: "  \n "))).isEmpty)
        #expect(detail(mediator)?.controls == .editing(draft: "明日の 10 時で大丈夫です。"))
        _ = mediator.handle(.approvalPlacementChosen(.channel))
        #expect(sent(mediator.handle(.approvalEditSubmitted(approvalId: "a1", text: "10 時でお願いします。")))
            == [.approvalDecide(approvalId: "a1", revision: 1, decision: .edit(text: "10 時でお願いします。", placement: .channel))])
        #expect(detail(mediator)?.controls == .waiting("送っています…"))
    }

    @Test("却下を送る")
    func reject() {
        var mediator = synced()
        _ = mediator.handle(.approvalOpenRequested(approvalId: "a1"))
        #expect(sent(mediator.handle(.approvalRejected(approvalId: "a1")))
            == [.approvalDecide(approvalId: "a1", revision: 1, decision: .reject)])
    }

    @Test("断られたら、その理由を出して、もう一度選べるようにする")
    func refused() {
        var mediator = synced()
        _ = mediator.handle(.approvalOpenRequested(approvalId: "a1"))
        _ = mediator.handle(.approvalApproved(approvalId: "a1"))
        _ = mediator.handle(.socketReceived(Fixture.envelope("command.rejected", seq: 2, requestId: "r2",
            payload: ["code": "stale-revision"])))
        #expect(detail(mediator)?.controls == .choose)
        #expect(detail(mediator)?.message == "中身が新しくなっていました。見直してから、もう一度選んでください")

        _ = mediator.handle(.approvalRejected(approvalId: "a1"))
        _ = mediator.handle(.socketReceived(Fixture.envelope("command.rejected", seq: 3, requestId: "r3",
            payload: ["code": "invalid-request"])))
        #expect(detail(mediator)?.message == "送れませんでした（invalid-request）")
    }

    @Test("閉じたら送った結果を出し、もう選べない。一覧と件数からは消える")
    func resolved() {
        var mediator = synced()
        _ = mediator.handle(.approvalOpenRequested(approvalId: "a1"))
        _ = mediator.handle(.approvalApproved(approvalId: "a1"))
        _ = mediator.handle(.socketReceived(Fixture.approvalResolved("a1", seq: 2)))
        let props = try! #require(detail(mediator))
        #expect(props.controls == .closed)
        #expect(props.result == PhoneApprovalResultProps(
            title: "承認して送りました", detail: nil, sentText: "明日の 10 時で大丈夫です。", isFailure: false))
        #expect(props.placementOptions == [])
        #expect(main(mediator)?.approvals == nil)
        _ = mediator.handle(.approvalClosed)
        #expect(list(mediator)?.rows == [])
    }

    @Test("置き場所を変えて送ったものは、閉じた後も変えた置き場所を出す")
    func placementAfterClosing() {
        var mediator = synced()
        _ = mediator.handle(.approvalOpenRequested(approvalId: "a1"))
        _ = mediator.handle(.approvalPlacementChosen(.channel))
        _ = mediator.handle(.approvalApproved(approvalId: "a1"))
        _ = mediator.handle(.socketReceived(Fixture.approvalResolved("a1", seq: 2)))
        #expect(detail(mediator)?.placement == "チャンネルに投稿")
        #expect(detail(mediator)?.placementOptions == [])
    }

    @Test("送れなかった・却下・期限切れ・修正の結果の書き方")
    func resultTexts() {
        func result(_ data: Data) -> PhoneApprovalResultProps? {
            var mediator = synced()
            _ = mediator.handle(.approvalOpenRequested(approvalId: "a1"))
            _ = mediator.handle(.socketReceived(data))
            return detail(mediator)?.result
        }
        #expect(result(Fixture.approvalResolved("a1", seq: 2, delivery: "failed", reason: "mechanical-check", sentText: nil))
            == PhoneApprovalResultProps(
                title: "承認しましたが、送れませんでした", detail: "送る前の検査に当たったので、送っていません", sentText: nil,
                isFailure: true))
        #expect(result(Fixture.approvalResolved("a1", seq: 2, state: "edited", delivery: "failed", reason: "slack-error", sentText: nil))?.detail
            == "Slack が受け付けませんでした")
        #expect(result(Fixture.approvalResolved("a1", seq: 2, delivery: "failed", reason: "target-gone", sentText: nil))?.detail
            == "返信先が見つかりませんでした")
        #expect(result(Fixture.approvalResolved("a1", seq: 2, state: "edited", sentText: "直した本文"))
            == PhoneApprovalResultProps(title: "修正して送りました", detail: nil, sentText: "直した本文", isFailure: false))
        #expect(result(Fixture.approvalResolved("a1", seq: 2, state: "rejected", delivery: nil, sentText: nil))
            == PhoneApprovalResultProps(title: "却下しました", detail: nil, sentText: nil, isFailure: false))
        #expect(result(Fixture.approvalResolved("a1", seq: 2, state: "expired", delivery: nil, sentText: nil))
            == PhoneApprovalResultProps(title: "期限が切れました", detail: nil, sentText: nil, isFailure: false))
    }

    // MARK: - Notifications

    @Test("承認待ちの通知をタップすると、どの画面からでもその詳細を開く")
    func notificationOpensTheDetail() {
        var mediator = synced()
        _ = mediator.handle(.historyOpenRequested)
        _ = mediator.handle(.approvalNotificationOpened(approvalId: "a1"))
        #expect(detail(mediator)?.approvalId == "a1")
        // Back goes to the list of approvals.
        _ = mediator.handle(.approvalClosed)
        #expect(list(mediator) != nil)
    }

    @Test("ログインしていなければ、通知のタップでは何も開かない")
    func notificationWithoutSession() {
        var mediator = PhoneMediator()
        _ = mediator.handle(.launched(serverOrigin: "https://natsumi.example.net"))
        _ = mediator.handle(.avatarLoaded(Fixture.receivedAvatar))
        _ = mediator.handle(.sessionResumed(hasSession: false, deviceId: nil))
        _ = mediator.handle(.approvalNotificationOpened(approvalId: "a1"))
        #expect(mediator.state.page == nil)
    }

    @Test("同期したら、承認待ちもバッジに数え、閉じた承認の通知を片づける")
    func tidy() {
        var mediator = synced([Fixture.approval("a1")])
        _ = mediator.handle(.socketReceived(Fixture.approvalPending(Fixture.approval("a2"), seq: 2)))
        let effects = mediator.handle(.socketReceived(Fixture.approvalResolved("a1", seq: 3)))
        #expect(tidies(effects) == [.synced(badge: 1, unreadReplyIds: [], unacknowledgedIds: [], pendingApprovalIds: ["a2"])])
    }

    @Test("approval-resolved の background push は、その通知を消してバッジを直す")
    func resolvedPush() {
        var mediator = synced()
        let push = ApprovalResolvedPush(approvalId: "a1", badge: 0)
        #expect(mediator.handle(.approvalResolvedPushReceived(push)) == [.tidyNotifications(.approvalResolved(push))])
    }
}
