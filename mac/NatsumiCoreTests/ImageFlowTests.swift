import CoreGraphics
import Foundation
import Testing
@testable import NatsumiCore

/// A reply with two pictures: one whose size the server read (taller than wide), one without.
private var pictured: [String: Any] {
    Fixture.message("r1", images: [Fixture.image("image-a", width: 896, height: 1152), Fixture.image("image-b")])
}

private func fetched<Effect>(_ effects: [Effect]) -> [String] {
    effects.compactMap {
        switch $0 {
        case let effect as UIEffect: if case .fetchImage(let id) = effect { id } else { nil }
        case let effect as PhoneEffect: if case .fetchImage(let id) = effect { id } else { nil }
        default: nil
        }
    }
}

private func sentAnything<Effect>(_ effects: [Effect]) -> Bool {
    effects.contains {
        switch $0 {
        case let effect as UIEffect: if case .sendToServer = effect { true } else { false }
        case let effect as PhoneEffect: if case .sendToServer = effect { true } else { false }
        default: false
        }
    }
}

@Suite("Mac の会話の画像")
struct MacImageTests {
    private func launched() -> UIMediator {
        var counter = 0
        var mediator = UIMediator {
            counter += 1
            return "r\(counter)"
        }
        _ = mediator.handle(.launched(LaunchInfo(
            characterScale: .default, serverOrigin: "https://natsumi.example.net")))
        _ = mediator.handle(.avatarLoaded(Fixture.receivedAvatar))
        _ = mediator.handle(.sessionResumed(hasSession: true, deviceId: nil))
        _ = mediator.handle(.socketOpened)
        return mediator
    }

    /// Synced with the given messages; the effects of the snapshot are handed back.
    private func synced(_ messages: [[String: Any]], readThrough: String? = nil) -> (UIMediator, [UIEffect]) {
        var mediator = launched()
        let effects = mediator.handle(.socketReceived(Fixture.snapshot(
            seq: 1, requestId: "r1", deviceId: "device-1", messages: messages, readThrough: readThrough,
            unreadReplyCount: readThrough == nil ? 1 : 0)))
        return (mediator, effects)
    }

    private func props(_ mediator: UIMediator) -> RootProps {
        var placement = ColumnPlacement()
        placement.budget = UIProps.budgetSteps(mediator.state)[0]
        return UIProps.root(mediator.state, placement: placement, time: .example)
    }

    private func balloonImages(_ mediator: UIMediator) -> [ImageTileProps] {
        guard case .reply(let reply) = props(mediator).balloon?.body else { return [] }
        return reply.images
    }

    private func historyImages(_ mediator: UIMediator, _ id: String) -> [ImageTileProps]? {
        props(mediator).conversation?.history?.rows.first { $0.messageId == id }?.images
    }

    @Test("吹き出しの返事に画像があれば、取る前から場所を取った縮小画像を並べ、取りに行く")
    func theBalloonShowsTheImages() {
        let (mediator, effects) = synced([pictured])
        #expect(fetched(effects) == ["image-a", "image-b"])
        let tiles = balloonImages(mediator)
        #expect(tiles.map(\.imageId) == ["image-a", "image-b"])
        #expect(tiles.map(\.content) == [.loading, .loading])
        // One height; the first as the server says it is shaped, the second square until it comes.
        #expect(tiles[0].size.height == tiles[1].size.height)
        #expect(abs(tiles[0].size.width / tiles[0].size.height - 896.0 / 1152) < 0.001)
        #expect(tiles[1].size.width == tiles[1].size.height)
        // Small enough for the balloon, and within its width.
        #expect(tiles[0].size.height <= 80)
        guard case .reply(let reply) = props(mediator).balloon?.body else { Issue.record("no reply"); return }
        #expect(reply.text == "猫を描いてみました。")
    }

    @Test("取れたら画像を出す。同じ ID は二度取りに行かない")
    func showsWhatCameAndFetchesOnce() {
        var (mediator, _) = synced([pictured])
        let effects = mediator.handle(.imageFetched(imageId: "image-a", .loaded(Fixture.loaded("image-a"))))
        #expect(fetched(effects).isEmpty)
        #expect(balloonImages(mediator)[0].content == .loaded(Fixture.loaded("image-a")))
        #expect(balloonImages(mediator)[0].canOpen)
        #expect(fetched(mediator.handle(.socketReceived(Fixture.thinking("ねこ", seq: 1)))).isEmpty)
    }

    @Test("取れなければその場所に印を出し、本文はそのまま出す")
    func aPictureThatCannotBeHad() {
        var (mediator, _) = synced([pictured])
        _ = mediator.handle(.imageFetched(imageId: "image-a", .missing))
        _ = mediator.handle(.imageFetched(imageId: "image-b", .unavailable))
        #expect(balloonImages(mediator).map(\.content) == [.failed, .failed])
        guard case .reply(let reply) = props(mediator).balloon?.body else { Issue.record("no reply"); return }
        #expect(reply.text == "猫を描いてみました。")
    }

    @Test("つながり直したら、つながらなくて取れなかった画像を取り直す。無い画像は取り直さない")
    func retriesAfterReconnecting() {
        var (mediator, _) = synced([pictured])
        _ = mediator.handle(.imageFetched(imageId: "image-a", .missing))
        _ = mediator.handle(.imageFetched(imageId: "image-b", .unavailable))
        #expect(mediator.handle(.systemWoke) == [.disconnect, .connect])
        let sync = mediator.handle(.socketOpened).compactMap { if case .sendToServer(let envelope) = $0 { envelope.requestId } else { nil } }
        let effects = mediator.handle(.socketReceived(Fixture.snapshot(
            seq: 1, stream: "stream-2", requestId: sync.first, deviceId: "device-1", messages: [pictured], unreadReplyCount: 1)))
        #expect(fetched(effects) == ["image-b"])
    }

    @Test("履歴では、見えた行の画像だけを取りに行く。行には取る前から縮小画像の場所がある")
    func theHistoryFetchesWhatIsInSight() {
        let older = Fixture.message("r0", images: [Fixture.image("image-old", width: 400, height: 200)])
        var (mediator, effects) = synced([older, pictured], readThrough: "r1")
        // Both are read, so the balloon asks for nothing.
        #expect(fetched(effects).isEmpty)
        _ = mediator.handle(.historyOpenRequested)
        let tiles = try! #require(historyImages(mediator, "r1"))
        #expect(tiles.map(\.content) == [.loading, .loading])
        #expect(abs(tiles[0].size.width / tiles[0].size.height - 896.0 / 1152) < 0.001)
        #expect(historyImages(mediator, "r0")?.first?.size.width == 2 * (historyImages(mediator, "r0")?.first?.size.height ?? 0))
        effects = mediator.handle(.historyRowVisibilityChanged(messageId: "r1", isVisible: true))
        #expect(fetched(effects) == ["image-a", "image-b"])
        // A row without pictures has none.
        #expect(props(mediator).conversation?.history?.rows.allSatisfy { $0.messageId == "r0" || $0.messageId == "r1" } == true)
    }

    @Test("画像の無い行は、今までどおり縮小画像を持たない")
    func linesWithoutPictures() {
        var (mediator, effects) = synced([Fixture.message("r1", text: "こんにちは")])
        #expect(fetched(effects).isEmpty)
        #expect(balloonImages(mediator).isEmpty)
        _ = mediator.handle(.historyOpenRequested)
        #expect(historyImages(mediator, "r1") == [])
    }

    @Test("取れた縮小画像のクリックで拡大の窓を出し、閉じれば消える。既読にはしない。取れていない画像は開かない")
    func opensAPictureLarge() {
        var (mediator, _) = synced([pictured])
        _ = mediator.handle(.imageFetched(imageId: "image-a", .loaded(Fixture.loaded("image-a"))))
        #expect(props(mediator).viewer == nil)
        let effects = mediator.handle(.imageClicked(imageId: "image-a"))
        #expect(!sentAnything(effects))
        #expect(props(mediator).viewer == ImageViewerProps(image: Fixture.loaded("image-a"), title: "なつみの画像"))
        // The reply is still unread, and in the balloon.
        #expect(!balloonImages(mediator).isEmpty)
        _ = mediator.handle(.imageViewerCloseRequested)
        #expect(props(mediator).viewer == nil)
        _ = mediator.handle(.imageClicked(imageId: "image-b"))
        #expect(props(mediator).viewer == nil)
    }

    @Test("ログアウトで手元の画像を捨て、拡大の窓も閉じる。取り直すのは次のログインの後")
    func logoutDropsThePictures() {
        var (mediator, _) = synced([pictured])
        _ = mediator.handle(.imageFetched(imageId: "image-a", .loaded(Fixture.loaded("image-a"))))
        _ = mediator.handle(.imageClicked(imageId: "image-a"))
        let effects = mediator.handle(.logoutRequested)
        #expect(fetched(effects).isEmpty)
        #expect(props(mediator).viewer == nil)
        #expect(mediator.state.images["image-a"] == nil)
        // An answer that was on its way is not kept.
        _ = mediator.handle(.imageFetched(imageId: "image-b", .loaded(Fixture.loaded("image-b"))))
        #expect(mediator.state.images["image-b"] == nil)
    }
}

@Suite("iPhone の会話と承認の画像")
struct PhoneImageTests {
    private func synced(
        _ messages: [[String: Any]] = [pictured], approvals: [[String: Any]] = []
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
            seq: 1, requestId: "r1", deviceId: "device-1", messages: messages, unreadReplyCount: 1, approvals: approvals)))
        return mediator
    }

    private func main(_ mediator: PhoneMediator) -> PhoneMainProps? {
        if case .main(let props) = PhoneProps.root(mediator.state, time: .example).screen { props } else { nil }
    }

    private func historyImages(_ mediator: PhoneMediator, _ id: String) -> [ImageTileProps]? {
        guard case .history(let history) = main(mediator)?.page else { return nil }
        return history.history.rows.first { $0.messageId == id }?.images
    }

    private func detail(_ mediator: PhoneMediator) -> PhoneApprovalDetailProps? {
        guard case .approval(.detail(let detail), _) = main(mediator)?.page else { return nil }
        return detail
    }

    private static var post: [String: Any] {
        Fixture.approval("a1", images: [Fixture.image("post-1"), Fixture.image("post-2")])
    }

    @Test("会話の画面では画像を取りに行かない。履歴で見えた行の画像を取り、縮小画像を並べる")
    func theHistoryShowsThePictures() {
        var mediator = synced()
        #expect(mediator.state.images["image-a"] == nil)
        _ = mediator.handle(.historyOpenRequested)
        let tiles = try! #require(historyImages(mediator, "r1"))
        #expect(tiles.map(\.content) == [.loading, .loading])
        #expect(tiles[0].size.height == tiles[1].size.height)
        #expect(fetched(mediator.handle(.historyRowVisibilityChanged(messageId: "r1", isVisible: true))) == ["image-a", "image-b"])
        _ = mediator.handle(.imageFetched(imageId: "image-a", .loaded(Fixture.loaded("image-a"))))
        _ = mediator.handle(.imageFetched(imageId: "image-b", .missing))
        #expect(historyImages(mediator, "r1")?.map(\.content) == [.loaded(Fixture.loaded("image-a")), .failed])
    }

    @Test("縮小画像のタップで全画面に拡大し、閉じられる。取れていない画像は開かない")
    func opensAPictureLarge() {
        var mediator = synced()
        _ = mediator.handle(.historyOpenRequested)
        _ = mediator.handle(.historyRowVisibilityChanged(messageId: "r1", isVisible: true))
        _ = mediator.handle(.imageFetched(imageId: "image-a", .loaded(Fixture.loaded("image-a"))))
        _ = mediator.handle(.imageTapped(imageId: "image-b"))
        #expect(main(mediator)?.viewer == nil)
        _ = mediator.handle(.imageTapped(imageId: "image-a"))
        #expect(main(mediator)?.viewer == ImageViewerProps(image: Fixture.loaded("image-a"), title: "なつみの画像"))
        // The history stays under it.
        if case .history = main(mediator)?.page {} else { Issue.record("the history went away") }
        _ = mediator.handle(.imageViewerClosed)
        #expect(main(mediator)?.viewer == nil)
    }

    @Test("承認の詳細に承認待ちの画像を並べ、開いたときに取りに行く")
    func theApprovalShowsItsPictures() {
        var mediator = synced([], approvals: [Self.post, Fixture.approval("a2")])
        #expect(mediator.state.images["post-1"] == nil)
        let effects = mediator.handle(.approvalOpenRequested(approvalId: "a1"))
        #expect(fetched(effects) == ["post-1", "post-2"])
        let tiles = try! #require(detail(mediator)?.images)
        #expect(tiles.map(\.label) == ["画像 1/2", "画像 2/2"])
        #expect(tiles.map(\.content) == [.loading, .loading])
        #expect(detail(mediator)?.imagesNote == nil)
        _ = mediator.handle(.imageFetched(imageId: "post-1", .loaded(Fixture.loaded("post-1"))))
        _ = mediator.handle(.imageTapped(imageId: "post-1"))
        #expect(main(mediator)?.viewer?.image == Fixture.loaded("post-1"))
        _ = mediator.handle(.imageViewerClosed)

        // One without pictures shows none.
        _ = mediator.handle(.approvalClosed)
        _ = mediator.handle(.approvalOpenRequested(approvalId: "a2"))
        #expect(detail(mediator)?.images == [])
        #expect(detail(mediator)?.imagesNote == nil)
    }

    @Test("承認が閉じたら画像を捨て、詳細には枚数だけを出す。遅れて届いた画像も置かない")
    func closingAnApprovalDropsItsPictures() {
        var mediator = synced([], approvals: [Self.post])
        _ = mediator.handle(.approvalOpenRequested(approvalId: "a1"))
        _ = mediator.handle(.imageFetched(imageId: "post-1", .loaded(Fixture.loaded("post-1"))))
        _ = mediator.handle(.imageTapped(imageId: "post-1"))
        _ = mediator.handle(.socketReceived(Fixture.approvalResolved("a1", seq: 2)))
        #expect(mediator.state.images["post-1"] == nil)
        #expect(main(mediator)?.viewer == nil)
        _ = mediator.handle(.imageFetched(imageId: "post-2", .loaded(Fixture.loaded("post-2"))))
        #expect(mediator.state.images["post-2"] == nil)
        let closed = try! #require(detail(mediator))
        #expect(closed.images == [])
        #expect(closed.imagesNote == "画像 2 枚（承認が閉じたので表示しません）")
        #expect(closed.result?.title == "承認して送りました")
    }

    @Test("ログアウトで手元の画像を捨てる")
    func logoutDropsThePictures() {
        var mediator = synced()
        _ = mediator.handle(.historyOpenRequested)
        _ = mediator.handle(.historyRowVisibilityChanged(messageId: "r1", isVisible: true))
        _ = mediator.handle(.imageFetched(imageId: "image-a", .loaded(Fixture.loaded("image-a"))))
        _ = mediator.handle(.logoutRequested)
        #expect(mediator.state.images["image-a"] == nil)
    }
}
