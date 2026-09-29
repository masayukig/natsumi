import Foundation
import Testing
@testable import NatsumiCore

@Suite("知らせを挟んだやり取り")
struct NoticeFlowTests {
    private func mediator() -> UIMediator {
        var counter = 0
        var mediator = UIMediator {
            counter += 1
            return "r\(counter)"
        }
        _ = mediator.handle(.launched(LaunchInfo(
            characterScale: .default, serverOrigin: "https://natsumi.example.net")))
        _ = mediator.handle(.sessionResumed(hasSession: true, deviceId: nil))
        return mediator
    }

    private func props(_ mediator: UIMediator) -> RootProps {
        UIProps.root(mediator.state, placement: ColumnPlacement(), time: .example)
    }

    /// Runs one exchange as the server sends it: the owner's message is accepted while natsumi is already thinking,
    /// she sends a notice about it, then replies and finishes. `resetExpression` is whether the server puts the face
    /// back to neutral at the end, which it does only when it set the thinking face itself, not when the model did.
    private func exchange(resetExpression: Bool) -> UIMediator {
        var m = mediator()
        _ = m.handle(.socketOpened)
        _ = m.handle(.socketReceived(Fixture.snapshot(seq: 1, requestId: "r1", deviceId: "device-1", messages: [
            Fixture.message("m0", role: "owner", kind: "message", eventId: "e0"),
            Fixture.message("m00", replyTo: "e0"),
        ], readThrough: "m00")))
        #expect(props(m).balloon == nil)
        #expect(props(m).notices == nil)

        _ = m.handle(.inputSubmitted("架空のメッセージ"))
        #expect(props(m).balloon?.body == .thinking(ThinkingProps(label: "受付中", line: nil)))

        var seq = 1
        func receive(_ type: String, requestId: String? = nil, _ payload: [String: Any]) {
            seq += 1
            _ = m.handle(.socketReceived(Fixture.envelope(type, seq: seq, requestId: requestId, payload: payload)))
        }
        receive("command.accepted", requestId: "r2", ["messageId": "m1", "eventId": "e1", "state": "processing"])
        #expect(props(m).balloon?.body == .thinking(ThinkingProps(label: "考え中", line: nil)))
        receive("conversation.message", Fixture.message("m1", role: "owner", kind: "message", eventId: "e1"))
        receive("avatar.expression", ["expression": "thinking"])
        // The model sets the face through its tool while it works.
        receive("avatar.expression", ["expression": "thinking"])
        // The line she is writing goes in the same bubble, without a number of its own (ADR 0017).
        _ = m.handle(.socketReceived(Fixture.thinking("知らせを送ろう", seq: seq)))
        #expect(props(m).balloon?.body == .thinking(ThinkingProps(label: "考え中", line: "知らせを送ろう")))

        var notice = Fixture.message("n1", kind: "notice", text: "架空のお知らせ")
        notice["about"] = ["e1"]
        receive("conversation.message", notice)
        // The notices are a bundle of their own: they stay out while she thinks.
        #expect(props(m).balloon?.body == .thinking(ThinkingProps(label: "考え中", line: "知らせを送ろう")))
        #expect(props(m).notices?.text == "架空のお知らせ")
        #expect(props(m).character.badge?.count == 1)

        receive("conversation.message", Fixture.message("m2", text: "架空の返事", replyTo: "e1"))
        // Her reply comes out at once, with what she is still thinking under it (ADR 0025).
        #expect(props(m).balloon?.body == .reply(ReplyProps(
            text: "架空の返事", lineLimit: BalloonText.maxLines, showsHistoryLink: false, unread: 1,
            help: "クリックで全文を出す", thinking: ThinkingProps(label: "考え中", line: "知らせを送ろう"))))
        receive("conversation.event.completed", ["eventId": "e1", "messageId": "m1", "status": "replied"])
        #expect(m.state.conversation.thinkingLine == nil)
        #expect(props(m).balloon?.body == .reply(ReplyProps(
            text: "架空の返事", lineLimit: BalloonText.maxLines, showsHistoryLink: false, unread: 1,
            help: "クリックで全文を出す")))
        if resetExpression { receive("avatar.expression", ["expression": "neutral"]) }
        return m
    }

    @Test("知らせと返事が履歴に並び、処理待ちが残らない")
    func conversationAfterNotice() {
        let m = exchange(resetExpression: false)
        #expect(m.state.conversation.messages.map(\.messageId) == ["m0", "m00", "m1", "n1", "m2"])
        #expect(m.state.conversation.messages[3].about == ["e1"])
        #expect(m.state.conversation.pendingEvents.isEmpty)
        #expect(m.state.conversation.outbox.isEmpty)
        #expect(props(m).character.disconnectedHelp == nil)
    }

    @Test("表情が thinking のまま残っても、知らせは束に、返事は吹き出しに出る")
    func noticeInBundleReplyInBalloon() {
        let m = exchange(resetExpression: false)
        #expect(m.state.conversation.expression == .thinking)
        #expect(m.state.conversation.isThinking == false)
        #expect(props(m).character.expression == .thinking)
        #expect(props(m).balloon?.body == .reply(ReplyProps(
            text: "架空の返事", lineLimit: BalloonText.maxLines, showsHistoryLink: false, unread: 1,
            help: "クリックで全文を出す")))
        #expect(props(m).balloon?.outline == .speech)
        #expect(props(m).notices?.text == "架空のお知らせ")
        #expect(props(m).notices?.more == 0)
    }

    @Test("サーバーが表情を戻したときも、同じく知らせは束に、返事は吹き出しに出る")
    func afterReset() {
        let m = exchange(resetExpression: true)
        #expect(props(m).balloon?.body == .reply(ReplyProps(
            text: "架空の返事", lineLimit: BalloonText.maxLines, showsHistoryLink: false, unread: 1,
            help: "クリックで全文を出す")))
        #expect(props(m).character.badge?.count == 1)
    }

    @Test("起動し直した snapshot でも、確かめていない知らせと返事が戻る")
    func snapshotAfterRestart() {
        var notice = Fixture.message("n1", kind: "notice", text: "架空のお知らせ")
        notice["about"] = ["e1"]
        var m = mediator()
        _ = m.handle(.socketOpened)
        _ = m.handle(.socketReceived(Fixture.snapshot(seq: 9, requestId: "r1", deviceId: "device-1", messages: [
            Fixture.message("m00", replyTo: "e0"),
            Fixture.message("m1", role: "owner", kind: "message", eventId: "e1"), notice,
            Fixture.message("m2", text: "架空の返事", replyTo: "e1"),
        ], expression: "thinking", readThrough: "m00", unreadReplyCount: 1, unacknowledged: ["n1"])))
        #expect(m.state.conversation.messages.map(\.messageId) == ["m00", "m1", "n1", "m2"])
        #expect(props(m).balloon?.body == .reply(ReplyProps(
            text: "架空の返事", lineLimit: BalloonText.maxLines, showsHistoryLink: false, unread: 1,
            help: "クリックで全文を出す")))
        #expect(props(m).notices?.text == "架空のお知らせ")
    }
}
