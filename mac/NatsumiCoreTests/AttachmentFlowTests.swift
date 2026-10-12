import Foundation
import Testing
@testable import NatsumiCore

/// Made-up files: nothing real is read or sent.
private let pdf = PickedFile(name: "報告書.pdf", bytes: 120_034, source: .data(Data(repeating: 1, count: 4)))
private let png = PickedFile(name: "猫.png", bytes: 2048, source: .data(Data(repeating: 2, count: 4)))
private let huge = PickedFile(name: "動画.mov", bytes: 30 * 1024 * 1024, source: .data(Data()))
private var limits: [String: Any] { ["maxFileBytes": 25 * 1024 * 1024, "maxFiles": 2] }

private func shown(_ id: String, _ file: PickedFile, image: Bool = false) -> ShownAttachment {
    ShownAttachment(
        uploadId: id, name: file.name, bytes: file.bytes, mimeType: image ? "image/png" : nil,
        width: image ? 40 : nil, height: image ? 20 : nil)
}

private func uploads<Effect>(_ effects: [Effect]) -> [String] {
    effects.compactMap {
        switch $0 {
        case let effect as UIEffect: if case .upload(let id, _) = effect { id } else { nil }
        case let effect as PhoneEffect: if case .upload(let id, _) = effect { id } else { nil }
        default: nil
        }
    }
}

private func attachmentFetches<Effect>(_ effects: [Effect]) -> [String] {
    effects.compactMap {
        switch $0 {
        case let effect as UIEffect: if case .fetchAttachment(let id) = effect { id } else { nil }
        case let effect as PhoneEffect: if case .fetchAttachment(let id) = effect { id } else { nil }
        default: nil
        }
    }
}

private func sent<Effect>(_ effects: [Effect]) -> [ClientEnvelope] {
    effects.compactMap {
        switch $0 {
        case let effect as UIEffect: if case .sendToServer(let envelope) = effect { envelope } else { nil }
        case let effect as PhoneEffect: if case .sendToServer(let envelope) = effect { envelope } else { nil }
        default: nil
        }
    }
}

/// An owner message of the history with a picture and a file attached.
private var attachedMessage: [String: Any] {
    var payload = Fixture.message("m1", role: "owner", kind: "message", text: "これ見て", eventId: "e1")
    payload["attachments"] = [
        ["uploadId": "upload-a", "name": "猫.png", "bytes": 2048, "mimeType": "image/png", "width": 40, "height": 20],
        ["uploadId": "upload-b", "name": "報告書.pdf", "bytes": 120_034],
    ]
    return payload
}

@Suite("送る前の添付（AttachmentDrafts）")
struct AttachmentDraftsTests {
    private let limits = UploadLimits(maxFileBytes: 25 * 1024 * 1024, maxFiles: 2)

    @Test("選んだファイルは上がっている途中になり、上げるものとして返る")
    func pickedFilesGoUp() {
        var drafts = AttachmentDrafts()
        let going = drafts.add([pdf, png], limits: limits)
        #expect(going.map(\.localId) == ["file-1", "file-2"])
        #expect(going.map(\.file) == [pdf, png])
        #expect(drafts.items.map(\.status) == [.uploading, .uploading])
        #expect(drafts.isUploading)
    }

    @Test("上限を超える大きさ・個数は上げずに、理由を添えて失敗にする。失敗したものは個数に数えない")
    func theLimitsAreCheckedBefore() {
        var drafts = AttachmentDrafts()
        let going = drafts.add([huge, pdf, png, pdf], limits: limits)
        #expect(going.map(\.localId) == ["file-2", "file-3"])
        #expect(drafts.items.map(\.status) == [
            .failed("25 MB までです"), .uploading, .uploading, .failed("ひとつのメッセージに添えられるのは 2 個までです"),
        ])
    }

    @Test("上限を知らないうちは確かめずに上げ、サーバーの答えに任せる")
    func withoutLimitsEverythingGoes() {
        var drafts = AttachmentDrafts()
        #expect(drafts.add([huge], limits: nil).count == 1)
    }

    @Test("上がったものは ready、失敗は理由の文言。知らない ID の答えは捨てる")
    func answersSettleTheDrafts() {
        var drafts = AttachmentDrafts()
        _ = drafts.add([pdf, png, pdf], limits: nil)
        drafts.finish("file-2", .uploaded(shown("upload-b", png)))
        drafts.finish("file-1", .failed(.tooLarge))
        drafts.finish("file-3", .failed(.unauthorized))
        drafts.finish("file-9", .uploaded(shown("upload-z", pdf)))
        #expect(drafts.items.map(\.status) == [
            .failed("大きすぎるため上げられませんでした"), .ready(shown("upload-b", png)),
            .failed("ログインが切れていて上げられませんでした"),
        ])
        #expect(!drafts.isUploading)
        #expect(drafts.ready == [shown("upload-b", png)])
    }

    @Test("取り除くと消え、その後に届いた答えは捨てる。片付けても番号は戻らない")
    func removing() {
        var drafts = AttachmentDrafts()
        _ = drafts.add([pdf, png], limits: nil)
        drafts.remove("file-1")
        drafts.finish("file-1", .uploaded(shown("upload-a", pdf)))
        #expect(drafts.items.map(\.localId) == ["file-2"])
        drafts.clear()
        #expect(drafts.items.isEmpty)
        #expect(drafts.add([pdf], limits: nil).map(\.localId) == ["file-3"])
    }

    @Test("縮小画像は、まだある添付にだけ付く")
    func previews() {
        var drafts = AttachmentDrafts()
        _ = drafts.add([png], limits: nil)
        drafts.preview("file-1", Fixture.loaded("file-1"))
        drafts.preview("file-7", Fixture.loaded("file-7"))
        #expect(drafts.items.map(\.preview) == [Fixture.loaded("file-1")])
    }
}

@Suite("Mac の添付")
struct MacAttachmentTests {
    private func synced(messages: [[String: Any]] = []) -> UIMediator {
        var counter = 0
        var mediator = UIMediator {
            counter += 1
            return "r\(counter)"
        }
        _ = mediator.handle(.launched(LaunchInfo(characterScale: .default, serverOrigin: "https://natsumi.example.net")))
        _ = mediator.handle(.avatarLoaded(Fixture.receivedAvatar))
        _ = mediator.handle(.sessionResumed(hasSession: true, deviceId: nil))
        _ = mediator.handle(.socketOpened)
        _ = mediator.handle(.socketReceived(Fixture.snapshot(
            seq: 1, requestId: "r1", deviceId: "device-1", messages: messages, uploads: limits)))
        _ = mediator.handle(.talkRequested)
        return mediator
    }

    private func conversation(_ mediator: UIMediator) -> ConversationProps? {
        UIProps.root(mediator.state, placement: ColumnPlacement(), time: .example).conversation
    }

    @Test("クリップはファイルを選ばせ、選んだものはその場で上げる")
    func choosingUploads() {
        var mediator = synced()
        #expect(mediator.handle(.attachRequested) == [.chooseFiles])
        let effects = mediator.handle(.filesPicked([pdf, png]))
        #expect(effects.contains(.upload(localId: "file-1", pdf)))
        #expect(uploads(effects) == ["file-1", "file-2"])
        let composer = conversation(mediator)?.composer
        #expect(composer?.chips.map(\.name) == ["報告書.pdf", "猫.png"])
        #expect(composer?.chips.map(\.detail) == ["アップロード中…", "アップロード中…"])
        #expect(composer?.chips.map(\.removeLabel) == ["報告書.pdf を取り除く", "猫.png を取り除く"])
        #expect(composer?.canSend == false)
    }

    @Test("上がった画像は縮小を出し、ファイルは大きさを出す。失敗は理由を出す")
    func theChips() {
        var mediator = synced()
        _ = mediator.handle(.filesPicked([pdf, png, huge]))
        _ = mediator.handle(.attachmentPreviewed(localId: "file-2", Fixture.loaded("file-2")))
        _ = mediator.handle(.uploadFinished(localId: "file-1", .uploaded(shown("upload-a", pdf))))
        _ = mediator.handle(.uploadFinished(localId: "file-2", .uploaded(shown("upload-b", png, image: true))))
        let chips = conversation(mediator)?.composer.chips ?? []
        #expect(chips.map(\.detail) == ["117.2 KB", "2 KB", "25 MB までです"])
        #expect(chips.map(\.isFailed) == [false, false, true])
        #expect(chips.map(\.thumbnail) == [nil, Fixture.loaded("file-2"), nil])
        #expect(conversation(mediator)?.composer.canSend == true)
        #expect(conversation(mediator)?.composer.sendsWithoutText == true)
    }

    @Test("上がっている途中は送らない。上がったら uploadIds を表示の順で添え、本文が空でも送り、添付を片付ける")
    func sendingWithFiles() {
        var mediator = synced()
        _ = mediator.handle(.filesPicked([pdf, png]))
        _ = mediator.handle(.uploadFinished(localId: "file-2", .uploaded(shown("upload-b", png))))
        #expect(sent(mediator.handle(.inputSubmitted("見て"))).isEmpty)
        _ = mediator.handle(.uploadFinished(localId: "file-1", .uploaded(shown("upload-a", pdf))))
        let envelopes = sent(mediator.handle(.inputSubmitted("")))
        #expect(envelopes.map(\.command) == [.conversationSend(text: "", uploadIds: ["upload-a", "upload-b"])])
        #expect(conversation(mediator)?.composer.chips.isEmpty == true)
        // Nothing to send: no text and no file.
        #expect(sent(mediator.handle(.inputSubmitted("  "))).isEmpty)
    }

    @Test("失敗した添付は送らず、送ると一緒に片付く")
    func failedFilesAreLeftOut() {
        var mediator = synced()
        _ = mediator.handle(.filesPicked([pdf, png]))
        _ = mediator.handle(.uploadFinished(localId: "file-1", .failed(.failed)))
        _ = mediator.handle(.uploadFinished(localId: "file-2", .uploaded(shown("upload-b", png))))
        #expect(sent(mediator.handle(.inputSubmitted("やあ"))).map(\.command)
            == [.conversationSend(text: "やあ", uploadIds: ["upload-b"])])
        #expect(conversation(mediator)?.composer.chips.isEmpty == true)
    }

    @Test("取り除いた添付は送らない")
    func removedFilesAreNotSent() {
        var mediator = synced()
        _ = mediator.handle(.filesPicked([pdf, png]))
        _ = mediator.handle(.uploadFinished(localId: "file-1", .uploaded(shown("upload-a", pdf))))
        _ = mediator.handle(.attachmentRemoved(localId: "file-2"))
        #expect(sent(mediator.handle(.inputSubmitted(""))).map(\.command) == [.conversationSend(text: "", uploadIds: ["upload-a"])])
    }

    @Test("送り直しは同じ requestId・本文・uploadIds のまま")
    func resendKeepsTheFiles() {
        var mediator = synced()
        _ = mediator.handle(.filesPicked([pdf]))
        _ = mediator.handle(.uploadFinished(localId: "file-1", .uploaded(shown("upload-a", pdf))))
        let first = sent(mediator.handle(.inputSubmitted("これ")))
        _ = mediator.handle(.socketClosed(.network))
        _ = mediator.handle(.reconnectTimerFired)
        let sync = sent(mediator.handle(.socketOpened))[0].requestId
        let again = sent(mediator.handle(.socketReceived(Fixture.envelope(
            "command.accepted", seq: 2, requestId: sync, payload: ["mode": "resume", "deviceId": "device-1"]))))
        #expect(again.filter { if case .conversationSend = $0.command { true } else { false } } == first)
    }

    @Test("送れなかった添付の理由を言葉にする。本文が空なら名前で示す")
    func refusalsInWords() {
        var mediator = synced()
        _ = mediator.handle(.filesPicked([pdf]))
        _ = mediator.handle(.uploadFinished(localId: "file-1", .uploaded(shown("upload-a", pdf))))
        let request = sent(mediator.handle(.inputSubmitted("")))[0].requestId
        _ = mediator.handle(.socketReceived(Fixture.envelope(
            "command.rejected", seq: 2, requestId: request, payload: ["code": "upload-not-found"])))
        #expect(conversation(mediator)?.failures.map(\.text)
            == ["「報告書.pdf」を送れませんでした（添えたファイルが見つかりません。添え直してください）"])
        _ = mediator.handle(.historyToggleRequested)
        let row = conversation(mediator)?.history?.outgoing.first
        #expect(row?.files == ["報告書.pdf"])
        #expect(row?.failure == "送れませんでした（添えたファイルが見つかりません。添え直してください）")
    }

    @Test("too-many-uploads も言葉にする")
    func tooMany() {
        #expect(UIProps.sendFailureReason("too-many-uploads") == "添えたファイルが多すぎます")
        #expect(UIProps.sendFailureReason("invalid-request") == "invalid-request")
    }

    @Test("履歴の本人の発言の添付は、画像を縮小で、ほかを名前と大きさで出す。見えた行の画像を bearer で取りに行く")
    func theHistoryShowsAttachments() {
        var mediator = synced(messages: [attachedMessage])
        _ = mediator.handle(.historyToggleRequested)
        let effects = mediator.handle(.historyRowVisibilityChanged(messageId: "m1", isVisible: true))
        #expect(attachmentFetches(effects) == ["upload-a"])
        let row = conversation(mediator)?.history?.rows.first
        #expect(row?.images.map(\.imageId) == ["upload-a"])
        #expect(row?.images.first?.content == .loading)
        #expect(row?.files == [AttachedFileProps(uploadId: "upload-b", name: "報告書.pdf", detail: "117.2 KB")])

        _ = mediator.handle(.imageFetched(imageId: "upload-a", .loaded(Fixture.loaded("upload-a"))))
        #expect(conversation(mediator)?.history?.rows.first?.images.first?.canOpen == true)
        _ = mediator.handle(.imageClicked(imageId: "upload-a"))
        #expect(mediator.state.viewedImage == "upload-a")
    }

    @Test("ログアウトで添付を片付け、その後に届いた答えは捨てる。セッションが無ければ選んでも上げない")
    func logoutClears() {
        var mediator = synced()
        _ = mediator.handle(.filesPicked([pdf]))
        _ = mediator.handle(.logoutRequested)
        _ = mediator.handle(.uploadFinished(localId: "file-1", .uploaded(shown("upload-a", pdf))))
        #expect(mediator.state.drafts.items.isEmpty)
        #expect(mediator.handle(.attachRequested).isEmpty)
        #expect(uploads(mediator.handle(.filesPicked([pdf]))).isEmpty)
    }
}

@Suite("iPhone の添付")
struct PhoneAttachmentTests {
    private func synced(messages: [[String: Any]] = []) -> PhoneMediator {
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
            seq: 1, requestId: "r1", deviceId: "device-1", messages: messages, uploads: limits)))
        return mediator
    }

    private func main(_ mediator: PhoneMediator) -> PhoneMainProps? {
        if case .main(let props) = PhoneProps.root(mediator.state, time: .example).screen { props } else { nil }
    }

    @Test("写真とファイルのどちらからでも選ばせ、選んだものを上げ、チップを出す")
    func choosing() {
        var mediator = synced()
        #expect(mediator.handle(.attachRequested(.photos)) == [.chooseFiles(.photos)])
        #expect(mediator.handle(.attachRequested(.files)) == [.chooseFiles(.files)])
        #expect(uploads(mediator.handle(.filesPicked([png]))) == ["file-1"])
        #expect(main(mediator)?.composer.chips.map(\.name) == ["猫.png"])
        #expect(main(mediator)?.composer.canSend == false)
    }

    @Test("上がったら本文が空でも uploadIds を添えて送り、チップを片付ける")
    func sending() {
        var mediator = synced()
        _ = mediator.handle(.filesPicked([png, pdf]))
        _ = mediator.handle(.uploadFinished(localId: "file-1", .uploaded(shown("upload-a", png, image: true))))
        _ = mediator.handle(.uploadFinished(localId: "file-2", .uploaded(shown("upload-b", pdf))))
        _ = mediator.handle(.attachmentRemoved(localId: "file-2"))
        #expect(sent(mediator.handle(.inputSubmitted(""))).map(\.command) == [.conversationSend(text: "", uploadIds: ["upload-a"])])
        #expect(main(mediator)?.composer.chips.isEmpty == true)
    }

    @Test("履歴の添付は Mac と同じに出し、見えた行の画像を取りに行く")
    func theHistory() {
        var mediator = synced(messages: [attachedMessage])
        _ = mediator.handle(.historyOpenRequested)
        let effects = mediator.handle(.historyRowVisibilityChanged(messageId: "m1", isVisible: true))
        #expect(attachmentFetches(effects) == ["upload-a"])
        guard case .history(let page) = main(mediator)?.page else { Issue.record("no history"); return }
        #expect(page.history.rows.first?.images.map(\.imageId) == ["upload-a"])
        #expect(page.history.rows.first?.files.map(\.name) == ["報告書.pdf"])
        // The history has its own input field, with the same files over it.
        _ = mediator.handle(.filesPicked([pdf]))
        guard case .history(let after) = main(mediator)?.page else { Issue.record("no history"); return }
        #expect(after.composer.chips.map(\.name) == ["報告書.pdf"])
        #expect(after.composer.canAttach)
    }

    @Test("ログアウトで添付を片付ける")
    func logout() {
        var mediator = synced()
        _ = mediator.handle(.filesPicked([png]))
        _ = mediator.handle(.logoutRequested)
        #expect(mediator.state.drafts.items.isEmpty)
    }
}
