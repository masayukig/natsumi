import Foundation
import Testing
@testable import NatsumiCore

@Suite("承認待ちの envelope を読み、approval.decide を書く")
struct ApprovalProtocolTests {
    private func pending(_ approval: [String: Any]) -> Approval? {
        if case .approvalPending(let decoded) = Fixture.decoded(Fixture.approvalPending(approval, seq: 1)).event { decoded } else { nil }
    }

    @Test("approval.pending は、返信先・置き場所・下書き・表情・理由・前の突き返しを運ぶ")
    func pendingApproval() throws {
        let history: [[String: Any]] = [[
            "text": "明日なら何時でも大丈夫です！", "issues": [["name": "promise", "label": "本人に代わる約束・期限", "score": 0.91, "flagged": true]],
        ]]
        let approval = try #require(pending(Fixture.approval("a1", history: history)))
        #expect(approval.approvalId == "a1")
        #expect(approval.revision == 1)
        #expect(approval.createdAt == parseTimestamp("2026-09-22T05:30:00.000Z"))
        #expect(approval.expiresAt == parseTimestamp("2026-09-29T05:30:00.000Z"))
        #expect(approval.target == ApprovalTarget(
            channel: "work/#dev",
            replyTo: ApprovalReplyTarget(speaker: "山田", at: "2026-09-25 14:32:05", text: "明日の打ち合わせ、何時がいいですか？"),
            placement: .thread))
        #expect(approval.text == "明日の 10 時で大丈夫です。")
        #expect(approval.expression == .happy)
        #expect(approval.reason == ApprovalReason(
            verdict: .owner,
            issues: [
                ApprovalIssue(name: "promise", label: "本人に代わる約束・期限", score: 0.82, flagged: true),
                ApprovalIssue(name: "missing-context", label: "スレッドに無い情報", score: 0.12, flagged: false),
            ],
            placementOdds: ApprovalPlacementOdds(thread: 0.7, channel: 0.3)))
        #expect(approval.history == [ApprovalPastDraft(
            text: "明日なら何時でも大丈夫です！",
            issues: [ApprovalIssue(name: "promise", label: "本人に代わる約束・期限", score: 0.91, flagged: true)])])
    }

    @Test("チャンネルへの投稿・判定なし・表情なしは、欄が無いものとして読む")
    func missingFields() throws {
        let approval = try #require(pending(Fixture.approval(
            "a2", replyTo: nil, placement: "channel", verdict: "no-verdict", expression: nil, issues: [], probabilities: nil)))
        #expect(approval.target == ApprovalTarget(channel: "work/#dev", replyTo: nil, placement: .channel))
        #expect(approval.expression == nil)
        #expect(approval.reason == ApprovalReason(verdict: .noVerdict, issues: [], placementOdds: nil))
        #expect(approval.history == [])
    }

    @Test("知らない表情・判定・置き場所・欄があっても、承認待ちは読める")
    func unknownValues() throws {
        var raw = Fixture.approval("a3", placement: "somewhere", verdict: "later-verdict", expression: "angry")
        raw["somethingNew"] = ["x": 1]
        let approval = try #require(pending(raw))
        #expect(approval.expression == nil)
        #expect(approval.reason.verdict == nil)
        #expect(approval.target.placement == nil)
    }

    @Test("置き場所は thread・channel・broadcast の 3 つを読み、確率も 3 つまで読む")
    func threePlacements() throws {
        let approval = try #require(pending(Fixture.approval(
            "a1", placement: "broadcast", probabilities: ["thread": 0.2, "channel": 0.3, "broadcast": 0.5])))
        #expect(approval.target.placement == .broadcast)
        #expect(approval.reason.placementOdds == ApprovalPlacementOdds(thread: 0.2, channel: 0.3, broadcast: 0.5))
        #expect(try #require(pending(Fixture.approval("a2", placement: "channel"))).target.placement == .channel)
    }

    @Test("確率は、欠けたキーを無いものとし、知らないキーを無視する。読めるキーが無ければ見立ては無い")
    func partialOdds() throws {
        let partial = try #require(pending(Fixture.approval("a1", probabilities: ["broadcast": 0.6, "somewhere": 0.4])))
        #expect(partial.reason.placementOdds == ApprovalPlacementOdds(thread: nil, channel: nil, broadcast: 0.6))

        let unknown = try #require(pending(Fixture.approval("a2", probabilities: ["somewhere": 1])))
        #expect(unknown.reason.placementOdds == nil)

        var broken = Fixture.approval("a3")
        broken["reason"] = ["verdict": "owner", "issues": [], "placement": ["probabilities": ["thread": "high", "channel": 0.3]]]
        let approval = try #require(pending(broken))
        #expect(approval.reason.placementOdds == ApprovalPlacementOdds(thread: nil, channel: 0.3, broadcast: nil))

        var notAnObject = Fixture.approval("a4")
        notAnObject["reason"] = ["verdict": "owner", "issues": [], "placement": ["probabilities": [0.7, 0.3]]]
        #expect(try #require(pending(notAnObject)).reason.placementOdds == nil)
    }

    @Test("slack-post でない承認と、形の壊れた承認は読まない")
    func otherKinds() {
        var calendar = Fixture.approval("a4")
        calendar["kind"] = "calendar-change"
        #expect(pending(calendar) == nil)
        var broken = Fixture.approval("a5")
        broken["text"] = nil
        #expect(pending(broken) == nil)
    }

    @Test("snapshot の pendingApprovals を古い順に読み、読めないものだけを落とす。欄が無ければ空")
    func snapshot() {
        var broken = Fixture.approval("a2")
        broken["target"] = nil
        let envelope = Fixture.decoded(Fixture.snapshot(
            seq: 1, approvals: [Fixture.approval("a1"), broken, Fixture.approval("a3")]))
        guard case .snapshot(let snapshot) = envelope.event else { Issue.record("not a snapshot"); return }
        #expect(snapshot.pendingApprovals.map(\.approvalId) == ["a1", "a3"])

        guard case .snapshot(let older) = Fixture.decoded(Fixture.snapshot(seq: 1)).event else { Issue.record("not a snapshot"); return }
        #expect(older.pendingApprovals == [])
    }

    @Test("approval.resolved は、閉じた状態と送った結果を運ぶ")
    func resolved() {
        let sent = Fixture.decoded(Fixture.approvalResolved("a1", seq: 2, state: "edited", sentText: "10 時でお願いします。"))
        #expect(sent.event == .approvalResolved(ApprovalResolution(
            approvalId: "a1", revision: 1, outcome: .edited, delivery: .sent, sentText: "10 時でお願いします。")))

        let failed = Fixture.decoded(Fixture.approvalResolved(
            "a1", seq: 3, delivery: "failed", reason: "mechanical-check", sentText: nil))
        #expect(failed.event == .approvalResolved(ApprovalResolution(
            approvalId: "a1", revision: 1, outcome: .approved, delivery: .failed(reason: "mechanical-check"), sentText: nil)))

        let rejected = Fixture.decoded(Fixture.approvalResolved("a1", seq: 4, state: "rejected", delivery: nil, sentText: nil))
        #expect(rejected.event == .approvalResolved(ApprovalResolution(
            approvalId: "a1", revision: 1, outcome: .rejected, delivery: nil, sentText: nil)))
    }

    @Test("approval.decide への command.accepted は、承認の ID と閉じた状態を運ぶ")
    func accepted() {
        let envelope = Fixture.decoded(Fixture.envelope("command.accepted", seq: 5, requestId: "r7", payload: [
            "approvalId": "a1", "revision": 1, "state": "approved",
        ]))
        #expect(envelope.event == .accepted(CommandAccepted(approvalId: "a1", revision: 1, approvalOutcome: .approved)))

        // The conversation's own states still read as before.
        let sent = Fixture.decoded(Fixture.envelope("command.accepted", seq: 6, requestId: "r8", payload: [
            "messageId": "m1", "eventId": "e1", "state": "queued",
        ]))
        #expect(sent.event == .accepted(CommandAccepted(messageId: "m1", eventId: "e1", state: .queued)))
    }

    @Test("approval.decide の envelope: 承認・修正・却下。置き場所は変えたときだけ付ける")
    func decideEncoding() {
        func payload(_ decision: ApprovalDecision) -> [String: Any] {
            let object = Fixture.object(ClientEnvelope(
                requestId: "r1", deviceId: "device-1", command: .approvalDecide(approvalId: "a1", revision: 2, decision: decision)))
            #expect(object["type"] as? String == "approval.decide")
            return object["payload"] as! [String: Any]
        }
        let approve = payload(.approve(placement: nil))
        #expect(approve as? [String: AnyHashable] == ["approvalId": "a1", "revision": 2, "decision": "approve"])
        let moved = payload(.approve(placement: .channel))
        #expect(moved as? [String: AnyHashable] == ["approvalId": "a1", "revision": 2, "decision": "approve", "placement": "channel"])
        let edit = payload(.edit(text: "10 時でお願いします。", placement: .thread))
        #expect(edit as? [String: AnyHashable] == [
            "approvalId": "a1", "revision": 2, "decision": "edit", "text": "10 時でお願いします。", "placement": "thread",
        ])
        let broadcast = payload(.approve(placement: .broadcast))
        #expect(broadcast as? [String: AnyHashable] == [
            "approvalId": "a1", "revision": 2, "decision": "approve", "placement": "broadcast",
        ])
        let reject = payload(.reject)
        #expect(reject as? [String: AnyHashable] == ["approvalId": "a1", "revision": 2, "decision": "reject"])
    }
}
