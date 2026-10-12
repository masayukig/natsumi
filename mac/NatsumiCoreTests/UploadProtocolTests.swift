import Foundation
import Testing
@testable import NatsumiCore

@Suite("ファイルの添付（上げる要求・答え・履歴の添付・上限・送る形）")
struct UploadProtocolTests {
    private let server = try! ServerAddress("https://natsumi.example.net")

    // MARK: - Uploading

    @Test("POST /v1/uploads?name=… を bearer で組み立てる。名前は & や空白も含めて URL エンコードする")
    func buildsTheUpload() {
        let request = UploadAPI.request(server: server, token: "token-example", name: "報告 書&1.pdf")
        #expect(request.httpMethod == "POST")
        #expect(request.url?.absoluteString
            == "https://natsumi.example.net/v1/uploads?name=%E5%A0%B1%E5%91%8A%20%E6%9B%B8%261.pdf")
        #expect(request.value(forHTTPHeaderField: "Authorization") == "Bearer token-example")
        // The server does not look at it; the bytes are the body as they are.
        #expect(request.value(forHTTPHeaderField: "Content-Type") == "application/octet-stream")
    }

    @Test("201 の答えから、上げたファイルを読む。画像なら種類と大きさも読む")
    func readsWhatWasUploaded() {
        let file = Fixture.json(["uploadId": "upload-a", "name": "報告書.pdf", "bytes": 120_034])
        #expect(UploadAPI.result(status: 201, body: file)
            == .uploaded(ShownAttachment(uploadId: "upload-a", name: "報告書.pdf", bytes: 120_034)))
        let image = Fixture.json([
            "uploadId": "upload-b", "name": "猫.png", "bytes": 2048, "mimeType": "image/png", "width": 40, "height": 20,
        ])
        guard case .uploaded(let shown) = UploadAPI.result(status: 201, body: image) else {
            Issue.record("not uploaded")
            return
        }
        #expect(shown.mimeType == "image/png")
        #expect(shown.isImage)
        #expect(shown.image == ShownImage(imageId: "upload-b", mimeType: "image/png", bytes: 2048, width: 40, height: 20))
    }

    @Test("契約の表のエラーを区別する。413 は大きすぎ、401 はログイン切れ、ほかと読めない答えは失敗")
    func tellsTheErrorsApart() {
        let body = Fixture.json(["error": "too-large"])
        #expect(UploadAPI.result(status: 413, body: body) == .failed(.tooLarge))
        #expect(UploadAPI.result(status: 401, body: Fixture.json(["error": "unauthorized"])) == .failed(.unauthorized))
        #expect(UploadAPI.result(status: 403, body: Fixture.json(["error": "origin-not-allowed"])) == .failed(.failed))
        #expect(UploadAPI.result(status: 500, body: Data()) == .failed(.failed))
        #expect(UploadAPI.result(status: 201, body: Data("{}".utf8)) == .failed(.failed))
    }

    @Test("添付の中身は GET /v1/uploads/<uploadId> を bearer で取る。形の違う ID はパスに入れない")
    func buildsTheFetch() {
        let request = UploadAPI.contentRequest(server: server, token: "token-example", uploadId: "upload-0000-aaaa")
        #expect(request?.httpMethod == "GET")
        #expect(request?.url?.absoluteString == "https://natsumi.example.net/v1/uploads/upload-0000-aaaa")
        #expect(request?.value(forHTTPHeaderField: "Authorization") == "Bearer token-example")
        #expect(UploadAPI.contentRequest(server: server, token: "token-example", uploadId: "../v1/images") == nil)
    }

    // MARK: - Reading the history

    @Test("本人のメッセージの attachments を送った順に読む。読めない要素は飛ばし、本文は残す")
    func readsTheAttachmentsOfAMessage() {
        var payload = Fixture.message("m1", role: "owner", kind: "message", text: "", eventId: "e1")
        payload["attachments"] = [
            ["uploadId": "upload-a", "name": "猫.png", "bytes": 2048, "mimeType": "image/png", "width": 40, "height": 20],
            ["uploadId": "upload-b"],
            ["uploadId": "upload-c", "name": "報告書.pdf", "bytes": 120_034],
        ]
        guard case .message(let message) = Fixture.decoded(Fixture.envelope("conversation.message", seq: 1, payload: payload)).event
        else { Issue.record("not a message"); return }
        #expect(message.text == "")
        #expect(message.attachments.map(\.uploadId) == ["upload-a", "upload-c"])
        #expect(message.attachments[0].width == 40)
        #expect(!message.attachments[1].isImage)
    }

    @Test("attachments の欄が無い行は、添付の無い行として読む")
    func aMessageWithoutAttachments() {
        let payload = Fixture.message("m1", role: "owner", kind: "message", text: "やあ", eventId: "e1")
        guard case .message(let message) = Fixture.decoded(Fixture.envelope("conversation.message", seq: 1, payload: payload)).event
        else { Issue.record("not a message"); return }
        #expect(message.attachments.isEmpty)
    }

    // MARK: - The limits

    @Test("snapshot の uploads から上限を読む。無い・読めないときは nil")
    func readsTheLimits() {
        let limits: [String: Any] = ["maxFileBytes": 26_214_400, "maxFiles": 10]
        guard case .snapshot(let snapshot) = Fixture.decoded(Fixture.snapshot(seq: 1, uploads: limits)).event
        else { Issue.record("not a snapshot"); return }
        #expect(snapshot.uploadLimits == UploadLimits(maxFileBytes: 26_214_400, maxFiles: 10))

        guard case .snapshot(let without) = Fixture.decoded(Fixture.snapshot(seq: 1)).event,
              case .snapshot(let odd) = Fixture.decoded(Fixture.snapshot(seq: 1, uploads: ["maxFiles": "ten"])).event
        else { Issue.record("not a snapshot"); return }
        #expect(without.uploadLimits == nil)
        #expect(odd.uploadLimits == nil)
    }

    // MARK: - Sending

    @Test("conversation.send は uploadIds を並べた順に添える。無ければ欄を出さない")
    func encodesTheUploadIds() {
        let with = Fixture.object(ClientEnvelope(
            requestId: "r3", deviceId: "device-1", command: .conversationSend(text: "", uploadIds: ["upload-b", "upload-a"])))
        let payload = with["payload"] as? [String: Any]
        #expect(payload?["text"] as? String == "")
        #expect(payload?["uploadIds"] as? [String] == ["upload-b", "upload-a"])

        let without = Fixture.object(ClientEnvelope(requestId: "r4", deviceId: "device-1", command: .conversationSend(text: "やあ")))
        #expect((without["payload"] as? [String: Any])?["uploadIds"] == nil)
    }
}
