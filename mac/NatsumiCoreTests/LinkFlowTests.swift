import CoreGraphics
import Foundation
import Testing
@testable import NatsumiCore

@Suite("本文のリンクを描き、クリックでブラウザを開く")
struct LinkFlowTests {
    private static let server = "https://natsumi.example.net"
    private static let url = URL(string: "https://example.com/a")!
    private static let text = "これ見て https://example.com/a 。"
    private static let runs: [TextRun] = [.plain("これ見て "), .link("https://example.com/a", url), .plain(" 。")]

    private func synced(messages: [[String: Any]], unread: Int = 0, unacknowledged: [String] = []) -> UIMediator {
        var counter = 0
        var mediator = UIMediator {
            counter += 1
            return "r\(counter)"
        }
        _ = mediator.handle(.launched(LaunchInfo(
            characterScale: .default, serverOrigin: Self.server)))
        _ = mediator.handle(.sessionResumed(hasSession: true, deviceId: nil))
        _ = mediator.handle(.socketOpened)
        _ = mediator.handle(.socketReceived(Fixture.snapshot(
            seq: 1, requestId: "r1", deviceId: "device-1", messages: messages, unreadReplyCount: unread,
            unacknowledged: unacknowledged)))
        return mediator
    }

    private func phoneSynced(messages: [[String: Any]], unread: Int = 0) -> PhoneMediator {
        var counter = 0
        var mediator = PhoneMediator {
            counter += 1
            return "r\(counter)"
        }
        _ = mediator.handle(.launched(serverOrigin: Self.server))
        _ = mediator.handle(.avatarLoaded(Fixture.receivedAvatar))
        _ = mediator.handle(.sessionResumed(hasSession: true, deviceId: nil))
        _ = mediator.handle(.socketOpened)
        _ = mediator.handle(.socketReceived(Fixture.snapshot(
            seq: 1, requestId: "r1", deviceId: "device-1", messages: messages, unreadReplyCount: unread)))
        return mediator
    }

    private func props(_ mediator: UIMediator) -> RootProps {
        var placement = ColumnPlacement()
        placement.budget = UIProps.budgetSteps(mediator.state)[0]
        return UIProps.root(mediator.state, placement: placement, time: .example)
    }

    private func reply(_ props: RootProps) -> ReplyProps? {
        if case .reply(let reply) = props.balloon?.body { reply } else { nil }
    }

    // MARK: - The drawing parameters

    @Test("履歴の行は、セリフ・本人のメッセージ・知らせのどれでも本文のリンクを持つ")
    func historyRows() {
        let state = synced(messages: [
            Fixture.message("m1", role: "owner", kind: "message", text: Self.text, eventId: "e1"),
            Fixture.message("r2", text: Self.text, replyTo: "e1"),
            Fixture.message("n3", kind: "notice", text: Self.text),
        ]).state
        let rows = UIProps.history(state.conversation, time: .example).rows
        #expect(rows.map(\.runs) == [Self.runs, Self.runs, Self.runs])
    }

    @Test("URL の無い行は、本文をそのまま 1 つの並びで持つ")
    func historyRowWithoutLinks() {
        let state = synced(messages: [Fixture.message("r1", text: "こんにちは")]).state
        #expect(UIProps.history(state.conversation, time: .example).rows.map(\.runs) == [[.plain("こんにちは")]])
    }

    @Test("返事の吹き出しと知らせの束は、出している本文のリンクを持つ")
    func cards() {
        let mediator = synced(
            messages: [Fixture.message("r1", text: Self.text), Fixture.message("n2", kind: "notice", text: Self.text)],
            unread: 1, unacknowledged: ["n2"])
        #expect(reply(props(mediator))?.runs == Self.runs)
        #expect(props(mediator).notices?.runs == Self.runs)
    }

    @Test("吹き出しの切り詰めた本文で、切れ目にかかった URL はリンクにしない")
    func cutPreview() {
        let long = String(repeating: "あ", count: BalloonText.maxCharacters - 10) + " https://example.com/long/path"
        var mediator = synced(messages: [Fixture.message("r1", text: long)], unread: 1)
        let preview = BalloonText.preview(long).text
        #expect(reply(props(mediator))?.runs == [.plain(preview)])

        // Opened, it is the whole text, and the URL is whole again.
        _ = mediator.handle(.balloonTextClicked)
        #expect(reply(props(mediator))?.runs.last == .link(
            "https://example.com/long/path", URL(string: "https://example.com/long/path")!))
    }

    @Test("iPhone の吹き出しは、返事の全文のリンクを持つ")
    func phoneBalloon() {
        let mediator = phoneSynced(messages: [Fixture.message("r1", text: Self.text)], unread: 1)
        guard case .main(let main) = PhoneProps.root(mediator.state, time: .example).screen,
              case .reply(let reply) = main.balloon
        else { Issue.record("返事が出ていない"); return }
        #expect(reply.runs == Self.runs)
    }

    // MARK: - Opening

    @Test("吹き出しのリンクのクリックはブラウザで開くだけで、既読にせず、吹き出しもそのまま")
    func openFromTheBalloon() {
        var mediator = synced(messages: [Fixture.message("r1", text: Self.text)], unread: 1)
        let before = props(mediator)
        #expect(mediator.handle(.linkClicked(Self.url)) == [.openLink(Self.url)])
        #expect(props(mediator) == before)
        #expect(mediator.state.conversation.unreadReplyCount == 1)
    }

    @Test("http と https のほかのリンクは開かない")
    func refuseOtherSchemes() {
        var mediator = synced(messages: [])
        #expect(mediator.handle(.linkClicked(URL(string: "file:///etc/passwd")!)).isEmpty)
        #expect(mediator.handle(.linkClicked(URL(string: "javascript:alert(1)")!)).isEmpty)
    }

    @Test("iPhone でもリンクのタップはブラウザで開くだけで、http と https のほかは開かない")
    func openOnThePhone() {
        var mediator = phoneSynced(messages: [Fixture.message("r1", text: Self.text)], unread: 1)
        let before = PhoneProps.root(mediator.state, time: .example)
        #expect(mediator.handle(.linkTapped(Self.url)) == [.openLink(Self.url)])
        #expect(PhoneProps.root(mediator.state, time: .example) == before)
        #expect(mediator.handle(.linkTapped(URL(string: "file:///etc/passwd")!)).isEmpty)
    }
}
